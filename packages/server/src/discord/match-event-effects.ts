import type { PrismaClient } from '@prisma/client';
import type { EntrantId, MatchEvent, MatchFormat, MatchState } from '../domain/types.js';
import { toPublicMatch } from '../domain/projection.js';
import { computeTournamentStandings } from '../services/advancement-service.js';
import { bracketShapeOf } from '../services/bracket-service.js';
import type { AppendResult, IllegalActionError } from '../services/match-service.js';
import type { RealtimeBroadcastPort } from '../services/ports.js';
import {
  renderProtectVetoLog,
  renderSeedChoiceLog,
  renderSongResultLog,
  renderTiebreakRevealLog,
} from './log-messages.js';
import { buildPlayerDirectory, type MatchWithParticipants } from './match-lookup.js';
import type { AlertPort, MatchChannelPort, PlayerNotificationPort, RenderedMessage, ThreadRef } from './ports.js';
import { buildEscalationAlert } from './render/escalation.js';
import { buildMatchSongsEmbed } from './render/match-songs.js';
import { buildResultAnnouncement, buildResultSummaryEmbed } from './render/result-summary.js';
import { buildTournamentCompleteAnnouncement } from './render/tournament-complete.js';
import { refereeTierRoleIds } from './tier.js';
import { provisionReadyThreads } from './thread-provisioning.js';
import { displayName, renderStateMessage, type PlayerDirectory } from './state-message.js';

/**
 * Shared by every surface that can append a `MatchEvent` — button/select
 * interactions (`interactions.ts`), a message-attachment photo
 * (`message-listener.ts` handles its own, simpler case inline), and referee
 * slash commands (`commands/rulings.ts`). Split out from `interactions.ts`
 * specifically so `commands/rulings.ts` can import it without creating an
 * import cycle back through `commands/router.ts`, which `interactions.ts`
 * itself imports.
 */

/**
 * The proactive cleanup in `discord/commands/tournament.ts`'s
 * `handleCancel` (clearing the state message, archiving the thread) is
 * best-effort — a crash mid-cascade, or an interaction already in flight
 * when it ran, can still leave a live button or select menu behind. This is
 * the backstop: `match.status` is set to `CANCELLED` in the same
 * transaction as the tournament's own cancellation, so it's authoritative
 * regardless of what the thread visibly still shows.
 */
export const CANCELLED_MATCH_MESSAGE = "You can't do that. The tournament is cancelled.";

/** Every actor a pending action names, in order — for the two-actor kinds, joined into prose. */
function namesOf(players: PlayerDirectory, actors: readonly EntrantId[]): string {
  return actors.map((id) => displayName(players, id)).join(' and ');
}

/**
 * A full sentence naming what the match is actually waiting on — "Waiting
 * for Hubert to pick a song," not the raw pending kind. Told to whoever
 * just got refused (a player acting out of turn, a referee ruling on
 * something already resolved), so it reads as an answer, not an error code.
 */
export function describeStale(err: IllegalActionError, players: PlayerDirectory): string {
  const p = err.pending;
  switch (p.kind) {
    case 'SEED_CHOICE':
      return `Waiting for ${displayName(players, p.actor)} to choose Protect order.`;
    case 'PROTECT':
      return `Waiting for ${displayName(players, p.actor)} to Protect.`;
    case 'VETO':
      return `Waiting for ${displayName(players, p.actor)} to Veto.`;
    case 'SELECT_SONG':
      return `Waiting for ${displayName(players, p.actor)} to pick a song.`;
    case 'SUBMIT_SCORE':
      return `Waiting for ${namesOf(players, p.actors)} to submit EX%.`;
    case 'SELECT_WINNER':
      return `Waiting for ${namesOf(players, p.actors)} to select the winner.`;
    case 'TIEBREAK_PICK':
      // Never names who specifically — a tiebreak pick is hidden from the
      // opponent until both are in. See DESIGN.md, "The tiebreak".
      return 'Waiting for a tiebreak pick.';
    case 'CONFIRM_RESULT':
      return `Waiting for ${namesOf(players, p.actors)} to confirm the result.`;
    case 'AWAITING_BOT':
      return 'Waiting for the bot to finish its move.';
    case 'AWAITING_TO':
      return "Waiting for a referee's ruling.";
    case 'DONE':
      return 'The match is already decided.';
  }
}

function renderActionLog(
  eventInput: Omit<MatchEvent, 'seq'>,
  after: MatchState,
  players: PlayerDirectory,
): RenderedMessage | null {
  // `Omit<MatchEvent, 'seq'>` doesn't narrow on `.type` the way `MatchEvent`
  // itself does — a known TS gap with `Omit` over a discriminated union of
  // intersections. The `seq` is irrelevant to rendering, so a throwaway
  // value restores the discriminated-union shape for the switch below.
  const event = { ...eventInput, seq: 0 } as MatchEvent;
  switch (event.type) {
    case 'SEED_CHOICE_MADE':
      return renderSeedChoiceLog(event.payload.by, event.payload.order, players);
    case 'CHART_PROTECTED':
      return renderProtectVetoLog('PROTECT', event.payload.by, after.draw[event.payload.drawIndex]!, players);
    case 'CHART_VETOED':
      return renderProtectVetoLog('VETO', event.payload.by, after.draw[event.payload.drawIndex]!, players);
    case 'CHART_SELECTED':
      return renderProtectVetoLog('PICK', event.payload.by, after.draw[event.payload.drawIndex]!, players);
    default:
      return null;
  }
}

/**
 * Everything that happens after a successful append, shared by every
 * action type: a permanent log line where one applies, the Protect/Veto
 * completion recap where that transition just happened, a newly raised
 * escalation alert, and the state message re-rendered from whatever is
 * now pending.
 */
export async function applyAppendResult(
  prisma: PrismaClient,
  matchChannel: MatchChannelPort,
  alert: AlertPort,
  playerNotification: PlayerNotificationPort,
  realtime: RealtimeBroadcastPort,
  match: MatchWithParticipants,
  format: MatchFormat,
  event: Omit<MatchEvent, 'seq'>,
  result: AppendResult,
): Promise<void> {
  const players = buildPlayerDirectory(match);
  const ref: ThreadRef = { matchId: match.id, threadId: match.threadId! };
  const before = match.state as unknown as MatchState;

  // "Domain services emit an internal event after committing a MatchEvent;
  // RealtimeModule fans it out" — DESIGN.md, "Realtime". Unconditional,
  // ahead of every branch below: the bracket and any open match-detail
  // view need to hear about every commit, not just the ones that also
  // produce a Discord-side effect.
  //
  // `toPublicMatch` never sets `participants[].displayName` — `MatchState`
  // has no idea `Entrant` rows exist, per `projection-wire-schema.test.ts`'s
  // own comment — so every caller has to join it in. The REST controllers
  // do this via `api/entrant-names.ts`; this was the one broadcast path
  // that never did, which meant `PublicMatchSchema.parse` (a required
  // `displayName: z.string()`) threw on every single frame, silently
  // aborting this entire function before any of the effects below ever
  // ran — the state message, the action log, escalation alerts, thread
  // provisioning, all of it, for every match action ever submitted through
  // a live Discord interaction.
  const projection = toPublicMatch(format, result.state);
  realtime.publish(match.tournamentId, match.id, result.state.seq, {
    ...projection,
    bracket: match.bracket,
    round: match.round,
    slot: match.slot,
    participants: projection.participants.map((p) => ({ ...p, displayName: displayName(players, p.entrantId) })),
  });

  // A permanent record of the action itself — the state message's own
  // draw-status field is disposable and will move on to a different
  // prompt, but the sequence of picks should survive in the thread's
  // history regardless. See DESIGN.md, "Two kinds of bot message."
  const log = renderActionLog(event, result.state, players);
  if (log) await matchChannel.postLogMessage(ref, log);

  // A song committed by agreement gets its own permanent log line — a
  // ruling does too, but that one is posted by the caller, which is the
  // only place that has the referee's identity to attribute it to.
  // A resolved tiebreak round gets its own reveal log, once both picks
  // exist — see DESIGN.md, "The tiebreak".
  const [pA, pB] = match.participants;
  for (const effect of result.effects) {
    if (effect.kind === 'SONG_COMMITTED') {
      const song = result.state.songs[effect.songIndex]!;
      if (song.result?.by !== 'AGREEMENT') continue;
      await matchChannel.postLogMessage(ref, renderSongResultLog(effect.songIndex, song.chart, song.result.winner, players));
    } else if (effect.kind === 'TIEBREAK_RESOLVED') {
      const round = result.state.tiebreaks.find((t) => t.round === effect.round)!;
      await matchChannel.postLogMessage(ref, renderTiebreakRevealLog(round, [pA!.entrantId, pB!.entrantId], players));
    }
  }

  // Protect/Veto just finished — ABBAAB's sixth and last action always
  // lands on exactly 4 protects and 2 vetoes. Checked as a *transition*
  // (not complete before, complete after): that count never changes again
  // once reached, so a bare state check would re-fire this on every action
  // for the rest of the match.
  const justCompletedPV = (s: MatchState) => s.protects.length === 4 && s.vetoes.length === 2;
  if (!justCompletedPV(before) && justCompletedPV(result.state)) {
    const songs = buildMatchSongsEmbed(result.state, (id) => displayName(players, id));
    await matchChannel.postLogMessage(ref, { embeds: [songs] });
  }

  // Newly escalated — same transition-not-state-check reasoning as above.
  // Read off `pendingAction`, never `state.escalation`: that raw field is
  // only ever set for an explicit settings-violation report — a winner
  // disagreement is derived from the selections themselves and never
  // stored, so `pendingAction` is the only place it surfaces at all (with
  // the songIndex `isLegal`'s SONG_RULED check also depends on).
  const beforePending = format.pendingAction(before);
  const pending = format.pendingAction(result.state);
  if (beforePending.kind !== 'AWAITING_TO' && pending.kind === 'AWAITING_TO') {
    const guild = await prisma.guild.findUnique({ where: { id: match.tournament.guildId } });
    const mention = guild
      ? refereeTierRoleIds(guild)
          .map((id) => `<@&${id}>`)
          .join(' ')
      : '';
    const [p0, p1] = match.participants;
    const threadLink = `https://discord.com/channels/${match.tournament.guildId}/${match.threadId}`;
    const alertMessage = buildEscalationAlert(match.id, pending.songIndex, pending.reason, mention, threadLink, match.tournamentId, [
      { entrantId: p0!.entrantId, name: displayName(players, p0!.entrantId) },
      { entrantId: p1!.entrantId, name: displayName(players, p1!.entrantId) },
    ]);
    const alertRef = await alert.raise(match.tournament.guildId, alertMessage);
    await prisma.match.update({ where: { id: match.id }, data: { alertMsgId: alertRef.messageId } });
  }

  // The set just closed — `SET_DECIDED` fires exactly once, the moment
  // `outcome()` turns non-null (both confirmations landed, a referee ruling
  // ended it, or a forfeit/DQ did). "The result summary is a log message
  // and the last thing the bot posts... the thread archives immediately
  // afterward." See DESIGN.md, "Ending the match".
  if (result.effects.some((e) => e.kind === 'SET_DECIDED')) {
    const publicMatch = toPublicMatch(format, result.state);
    const [p0, p1] = match.participants;
    const participantIds: [EntrantId, EntrantId] = [p0!.entrantId, p1!.entrantId];
    const nameOf = (id: EntrantId) => displayName(players, id);
    const outcome = publicMatch.outcome!;

    const summary = buildResultSummaryEmbed(publicMatch.songs, publicMatch.points, outcome, participantIds, nameOf);
    await matchChannel.postLogMessage(ref, { embeds: [summary] });

    const shape = await bracketShapeOf(prisma, match.tournamentId);
    const announcement = buildResultAnnouncement(
      match.bracket,
      match.round,
      outcome,
      publicMatch.points,
      participantIds,
      nameOf,
      match.tournamentId,
      match.id,
      match.tournament.name,
      publicMatch.songs,
      shape,
    );
    await matchChannel.publishResult(ref, announcement);

    // No closing state message — the result summary embed just above is
    // already the match-complete signal for anyone reading the thread.
    // The previous prompt's buttons/select menu (Protect/Veto, "Confirm
    // result," whatever was last pending) are left as they were: a click
    // on one now fails the existing stale-match guard in `interactions.ts`
    // and gets an ephemeral "this match no longer exists" in response,
    // rather than silently doing nothing.
    await matchChannel.archiveThread(ref);

    // This match was the one that decided the whole tournament — the grand
    // final, its reset, or (a 2-entrant field) the only match there is.
    // `tournamentCompleted` reflects the full cascade, not just this match,
    // so this also fires correctly when a tournament-scope DQ's walkover
    // chain is what actually closed it out. Standings mirror the match
    // result feed the same way: posted to the results channel, then
    // forwarded to general by `publishResult` itself.
    if (result.tournamentCompleted) {
      const standings = await computeTournamentStandings(prisma, match.tournamentId);
      await matchChannel.publishResult(ref, buildTournamentCompleteAnnouncement(match.tournamentId, match.tournament.name, standings));
      return;
    }

    // Advancement may have just seated two real players into a new match —
    // ordinary advancement, or a walkover cascade several matches deep.
    // Nothing else provisions a thread for that: `provisionReadyThreads` is
    // otherwise only ever called once, right after `/tournament start`, so
    // this is what makes every round *after* the first actually playable.
    await provisionReadyThreads(prisma, matchChannel, playerNotification, match.tournamentId, match.tournament.name);
    return;
  }

  await matchChannel.postMatchState(ref, renderStateMessage(match.id, pending, result.state, players));
}
