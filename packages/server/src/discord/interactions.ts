import {
  ActionRowBuilder,
  Events,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Client,
  type Interaction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { PrismaClient } from '@prisma/client';
import type { EntrantId, MatchEvent, MatchFormat, MatchState, PendingAction } from '../domain/types.js';
import { toPublicMatch } from '../domain/projection.js';
import { requireFormat } from '../services/engine.js';
import { appendMatchEvent, IllegalActionError, type AppendResult } from '../services/match-service.js';
import type { RandomPort } from '../services/ports.js';
import { Action, SCORE_MODAL_EX_FIELD } from './actions.js';
import type { CommandContext } from './commands/context.js';
import { dispatchChatInputCommand } from './commands/router.js';
import { decodeCustomId, encodeCustomId, type CustomId } from './custom-id.js';
import {
  renderProtectVetoLog,
  renderResetLog,
  renderRulingLog,
  renderSeedChoiceLog,
  renderSetRulingLog,
  renderSongResultLog,
  renderTiebreakRevealLog,
} from './log-messages.js';
import { buildPlayerDirectory, loadMatch, type MatchWithParticipants } from './match-lookup.js';
import type { AlertPort, MatchChannelPort, PlayerNotificationPort, RenderedMessage, ThreadRef } from './ports.js';
import { compactChartLabel } from './render/chart.js';
import { buildEscalationAlert, buildResolvedAlert } from './render/escalation.js';
import { buildMatchSongsEmbed } from './render/match-songs.js';
import { buildResultAnnouncement, buildResultSummaryEmbed } from './render/result-summary.js';
import { memberDisplayName } from './member-display-name.js';
import { hasTier, refereeTierRoleIds, Tier, type TierRoleConfig } from './tier.js';
import { parseExPercent } from './validate-ex.js';
import { displayName, renderStateMessage, type PlayerDirectory } from './state-message.js';

/**
 * The proactive cleanup in `discord/commands/tournament.ts`'s
 * `handleCancel` (clearing the state message, archiving the thread) is
 * best-effort — a crash mid-cascade, or an interaction already in flight
 * when it ran, can still leave a live button or select menu behind. This is
 * the backstop: `match.status` is set to `CANCELLED` in the same
 * transaction as the tournament's own cancellation, so it's authoritative
 * regardless of what the thread visibly still shows.
 */
const CANCELLED_MATCH_MESSAGE = "This action isn't allowed — the tournament has been cancelled.";

/**
 * The one `interactionCreate` listener. Decodes the stateless `custom_id`,
 * resolves the acting Discord user to an `EntrantId` for this match,
 * builds the domain event, and hands it to `appendMatchEvent` — the same
 * call path a test drives directly. See DESIGN.md, "The three-second
 * rule" and "Stateless components".
 *
 * `deferUpdate()` first, always — with one exception: a "Submit score"
 * button must respond with `showModal()` as its *first* response instead,
 * since deferring and showing a modal are mutually exclusive.
 */
export function registerInteractionHandlers(
  client: Client,
  prisma: PrismaClient,
  random: RandomPort,
  matchChannel: MatchChannelPort,
  alert: AlertPort,
  playerNotification: PlayerNotificationPort,
): void {
  const commandCtx: CommandContext = { client, prisma, random, matchChannel, playerNotification, alert };
  client.on(Events.InteractionCreate, (interaction: Interaction) => {
    handle(interaction, prisma, random, matchChannel, alert, commandCtx).catch((err: unknown) => {
      console.error('[discord] interaction handler failed', err);
    });
  });
}

async function handle(
  interaction: Interaction,
  prisma: PrismaClient,
  random: RandomPort,
  matchChannel: MatchChannelPort,
  alert: AlertPort,
  commandCtx: CommandContext,
): Promise<void> {
  if (interaction.isChatInputCommand()) {
    await dispatchChatInputCommand(interaction, commandCtx);
    return;
  }

  if (interaction.isModalSubmit()) {
    const decoded = decodeCustomId(interaction.customId);
    if (!decoded || decoded.action !== Action.SCORE) return;
    await handleScoreModalSubmit(interaction, decoded, prisma, random, matchChannel, alert);
    return;
  }

  if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;

  const decoded = decodeCustomId(interaction.customId);
  if (!decoded) return; // not one of ours

  if (interaction.isButton() && decoded.action === Action.SCORE) {
    await interaction.showModal(buildScoreModal(decoded));
    return;
  }

  // A referee ruling isn't a participant action — gated on tier, not on
  // being seated in the match — so it's routed before the participant
  // check below rather than through the generic path.
  if (interaction.isButton() && decoded.action === Action.RULE) {
    await handleRulingButton(interaction, decoded, prisma, random, matchChannel, alert);
    return;
  }

  // Same reasoning: a referee resetting Protect/Veto isn't a participant
  // action either.
  if (interaction.isButton() && decoded.action === Action.RESET_PV) {
    await handleResetButton(interaction, decoded, prisma, random, matchChannel, alert);
    return;
  }

  // The one place the general defer-first rule has a wrong answer:
  // deferUpdate() mutates the shared state message for everyone, which
  // would leak a tiebreak pick to the opponent before it's revealed. See
  // DESIGN.md, "The tiebreak".
  if (interaction.isStringSelectMenu() && decoded.action === Action.TIEBREAK) {
    await handleTiebreakPick(interaction, decoded, prisma, random, matchChannel, alert);
    return;
  }

  await interaction.deferUpdate();

  const match = await loadMatch(prisma, decoded.matchId);
  if (!match) {
    await interaction.followUp({ ephemeral: true, content: 'This match no longer exists.' });
    return;
  }
  if (match.status === 'CANCELLED') {
    await interaction.followUp({ ephemeral: true, content: CANCELLED_MATCH_MESSAGE });
    return;
  }

  const me = match.participants.find((p) => p.entrant.discordUserId === interaction.user.id);
  if (!me) {
    await interaction.followUp({ ephemeral: true, content: "You're not a participant in this match." });
    return;
  }

  const format = requireFormat(match.formatKey);
  // Best-effort peek at the disposable cache to decide, e.g., Protect vs.
  // Veto for the event *type* — never authoritative. `appendMatchEvent`
  // takes the real row lock and re-validates a moment later; a stale read
  // here fails closed (rejected as illegal), never open.
  const cachedPending: PendingAction = format.pendingAction(match.state as unknown as MatchState);

  const event = buildEvent(decoded, interaction, me.entrantId, cachedPending);
  if (!event) {
    await interaction.followUp({ ephemeral: true, content: 'Unrecognized action.' });
    return;
  }

  try {
    const result = await appendMatchEvent(prisma, random, match.id, event, interaction.id);
    await applyAppendResult(prisma, matchChannel, alert, match, format, event, result);
  } catch (err) {
    if (err instanceof IllegalActionError) {
      await interaction.followUp({
        ephemeral: true,
        content: `That's not available anymore — ${describeStale(err)}.`,
      });
      return;
    }
    throw err;
  }
}

function buildScoreModal(decoded: CustomId): ModalBuilder {
  // `arg` (the song index) is always set when the state message's button
  // encoded this id in the first place — see renderSubmitScore.
  return new ModalBuilder()
    .setCustomId(encodeCustomId({ matchId: decoded.matchId, action: Action.SCORE, arg: decoded.arg! }))
    .setTitle('Submit your EX%')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(SCORE_MODAL_EX_FIELD)
          .setLabel('EX% (0.00–100.00)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. 97.32')
          .setRequired(true)
          .setMaxLength(6),
      ),
    );
}

async function handleScoreModalSubmit(
  interaction: ModalSubmitInteraction,
  decoded: CustomId,
  prisma: PrismaClient,
  random: RandomPort,
  matchChannel: MatchChannelPort,
  alert: AlertPort,
): Promise<void> {
  const raw = interaction.fields.getTextInputValue(SCORE_MODAL_EX_FIELD);
  const ex = parseExPercent(raw);
  if (ex === null) {
    await interaction.reply({
      ephemeral: true,
      content: 'EX% must be a number between 0.00 and 100.00, with at most two decimal places.',
    });
    return;
  }

  await interaction.deferUpdate();

  const match = await loadMatch(prisma, decoded.matchId);
  if (!match) {
    await interaction.followUp({ ephemeral: true, content: 'This match no longer exists.' });
    return;
  }
  if (match.status === 'CANCELLED') {
    await interaction.followUp({ ephemeral: true, content: CANCELLED_MATCH_MESSAGE });
    return;
  }
  const me = match.participants.find((p) => p.entrant.discordUserId === interaction.user.id);
  if (!me) {
    await interaction.followUp({ ephemeral: true, content: "You're not a participant in this match." });
    return;
  }

  const songIndex = Number(decoded.arg);
  const event: Omit<MatchEvent, 'seq'> = {
    actorId: interaction.user.id, // the raw Discord id — see buildEvent's note
    type: 'SCORE_SUBMITTED',
    payload: { songIndex, by: me.entrantId, ex },
  };
  const format = requireFormat(match.formatKey);

  try {
    const result = await appendMatchEvent(prisma, random, match.id, event, interaction.id);
    await applyAppendResult(prisma, matchChannel, alert, match, format, event, result);
  } catch (err) {
    if (err instanceof IllegalActionError) {
      await interaction.followUp({
        ephemeral: true,
        content: `That's not available anymore — ${describeStale(err)}.`,
      });
      return;
    }
    throw err;
  }
}

/**
 * Every role's roles come back shaped differently depending on whether
 * discord.js resolved a full cached `GuildMember` or the raw API partial —
 * both carry the same role ids, just under different shapes.
 */
function rolesOfMember(member: ButtonInteraction['member']): string[] {
  if (!member) return [];
  if (Array.isArray(member.roles)) return member.roles;
  return [...member.roles.cache.keys()];
}

/** A referee's name attributed on a ruling/reset log must be how this *server* shows them — nickname if set — never the raw Discord username. */
function refereeDisplayName(interaction: ButtonInteraction): string {
  return memberDisplayName(interaction.member, interaction.user);
}

async function handleRulingButton(
  interaction: ButtonInteraction,
  decoded: CustomId,
  prisma: PrismaClient,
  random: RandomPort,
  matchChannel: MatchChannelPort,
  alert: AlertPort,
): Promise<void> {
  await interaction.deferUpdate();

  const match = await loadMatch(prisma, decoded.matchId);
  if (!match) {
    await interaction.followUp({ ephemeral: true, content: 'This match no longer exists.' });
    return;
  }
  if (match.status === 'CANCELLED') {
    await interaction.followUp({ ephemeral: true, content: CANCELLED_MATCH_MESSAGE });
    return;
  }

  const guild = await prisma.guild.findUnique({ where: { id: match.tournament.guildId } });
  const tierConfig: TierRoleConfig = guild ?? { refereeRoleId: null, toRoleId: null, adminRoleId: null };
  if (!hasTier(rolesOfMember(interaction.member), tierConfig, Tier.REFEREE)) {
    await interaction.followUp({ ephemeral: true, content: 'Only a referee can rule on this.' });
    return;
  }

  // `state.escalation` (the raw field) is only ever set for an explicit
  // settings-violation report — a winner disagreement is derived from the
  // selections and never stored there. `pendingAction` is the only place
  // it, and the songIndex it applies to, surfaces at all.
  const format = requireFormat(match.formatKey);
  const cachedState = match.state as unknown as MatchState;
  const cachedPending = format.pendingAction(cachedState);
  const arg = decoded.arg;
  if (cachedPending.kind !== 'AWAITING_TO' || !arg) {
    await interaction.followUp({ ephemeral: true, content: 'This escalation was already resolved.' });
    return;
  }

  const players = buildPlayerDirectory(match);
  const refDisplayName = refereeDisplayName(interaction);
  const ref: ThreadRef = { matchId: match.id, threadId: match.threadId! };

  // A set-level disagreement has no songIndex — it isn't about any one
  // song — and only two possible rulings, never a Void.
  if (cachedPending.reason === 'SET_RESULT_DISAGREEMENT') {
    const winnerId = arg as EntrantId;
    const event: Omit<MatchEvent, 'seq'> = {
      actorId: interaction.user.id,
      type: 'SET_RESULT_RULED',
      payload: { result: winnerId },
    };
    try {
      const result = await appendMatchEvent(prisma, random, match.id, event, interaction.id);
      if (match.alertMsgId) {
        const outcome = `awarded the set to ${displayName(players, winnerId)}`;
        await alert.resolve(match.tournament.guildId, { messageId: match.alertMsgId }, buildResolvedAlert(refDisplayName, outcome));
        await prisma.match.update({ where: { id: match.id }, data: { alertMsgId: null } });
      }
      await matchChannel.postLogMessage(ref, renderSetRulingLog(winnerId, refDisplayName, players));
      await applyAppendResult(prisma, matchChannel, alert, match, format, event, result);
    } catch (err) {
      if (err instanceof IllegalActionError) {
        await interaction.followUp({
          ephemeral: true,
          content: `That's not available anymore — ${describeStale(err)}.`,
        });
        return;
      }
      throw err;
    }
    return;
  }

  const songIndex = cachedPending.songIndex!;
  const rulingResult = arg as EntrantId | 'VOID';
  const event: Omit<MatchEvent, 'seq'> = {
    actorId: interaction.user.id,
    type: 'SONG_RULED',
    payload: { songIndex, result: rulingResult },
  };

  try {
    const result = await appendMatchEvent(prisma, random, match.id, event, interaction.id);
    const chart = result.state.songs[songIndex]!.chart;

    if (match.alertMsgId) {
      const outcome =
        rulingResult === 'VOID' ? 'voided' : `awarded to ${displayName(players, rulingResult)}`;
      await alert.resolve(match.tournament.guildId, { messageId: match.alertMsgId }, buildResolvedAlert(refDisplayName, outcome));
      await prisma.match.update({ where: { id: match.id }, data: { alertMsgId: null } });
    }

    await matchChannel.postLogMessage(ref, renderRulingLog(songIndex, chart, rulingResult, refDisplayName, players));

    await applyAppendResult(prisma, matchChannel, alert, match, format, event, result);
  } catch (err) {
    if (err instanceof IllegalActionError) {
      await interaction.followUp({
        ephemeral: true,
        content: `That's not available anymore — ${describeStale(err)}.`,
      });
      return;
    }
    throw err;
  }
}

const PROTECT_VETO_RESET_REASON = 'Reset by a referee via the match thread button.';

async function handleResetButton(
  interaction: ButtonInteraction,
  decoded: CustomId,
  prisma: PrismaClient,
  random: RandomPort,
  matchChannel: MatchChannelPort,
  alert: AlertPort,
): Promise<void> {
  await interaction.deferUpdate();

  const match = await loadMatch(prisma, decoded.matchId);
  if (!match) {
    await interaction.followUp({ ephemeral: true, content: 'This match no longer exists.' });
    return;
  }
  if (match.status === 'CANCELLED') {
    await interaction.followUp({ ephemeral: true, content: CANCELLED_MATCH_MESSAGE });
    return;
  }

  const guild = await prisma.guild.findUnique({ where: { id: match.tournament.guildId } });
  const tierConfig: TierRoleConfig = guild ?? { refereeRoleId: null, toRoleId: null, adminRoleId: null };
  if (!hasTier(rolesOfMember(interaction.member), tierConfig, Tier.REFEREE)) {
    await interaction.followUp({ ephemeral: true, content: 'Only a referee can reset Protect/Veto.' });
    return;
  }

  const event: Omit<MatchEvent, 'seq'> = {
    actorId: interaction.user.id,
    type: 'PROTECT_VETO_RESET',
    payload: { reason: PROTECT_VETO_RESET_REASON },
  };
  const format = requireFormat(match.formatKey);

  try {
    const result = await appendMatchEvent(prisma, random, match.id, event, interaction.id);
    const ref: ThreadRef = { matchId: match.id, threadId: match.threadId! };
    await matchChannel.postLogMessage(ref, renderResetLog(refereeDisplayName(interaction)));
    await applyAppendResult(prisma, matchChannel, alert, match, format, event, result);
  } catch (err) {
    if (err instanceof IllegalActionError) {
      await interaction.followUp({
        ephemeral: true,
        content: `That's not available anymore — ${describeStale(err)}.`,
      });
      return;
    }
    throw err;
  }
}

async function handleTiebreakPick(
  interaction: StringSelectMenuInteraction,
  decoded: CustomId,
  prisma: PrismaClient,
  random: RandomPort,
  matchChannel: MatchChannelPort,
  alert: AlertPort,
): Promise<void> {
  // Ephemeral, never deferUpdate() — see the note at the call site.
  await interaction.deferReply({ ephemeral: true });

  const match = await loadMatch(prisma, decoded.matchId);
  if (!match) {
    await interaction.editReply('This match no longer exists.');
    return;
  }
  if (match.status === 'CANCELLED') {
    await interaction.editReply(CANCELLED_MATCH_MESSAGE);
    return;
  }
  const me = match.participants.find((p) => p.entrant.discordUserId === interaction.user.id);
  if (!me) {
    await interaction.editReply("You're not a participant in this match.");
    return;
  }

  const format = requireFormat(match.formatKey);
  const cachedState = match.state as unknown as MatchState;
  const cachedPending = format.pendingAction(cachedState);

  if (cachedPending.kind !== 'TIEBREAK_PICK') {
    // "Selections are final. A second interaction from a player who has
    // already chosen is refused ephemerally, saying what they picked so
    // they are not left guessing." The round may also simply be over.
    const round = cachedState.tiebreaks.at(-1);
    const priorIndex = round?.choices[me.entrantId];
    if (round && priorIndex !== undefined) {
      await interaction.editReply(`Your pick is final — you already chose ${compactChartLabel(round.charts[priorIndex]!)}.`);
    } else {
      await interaction.editReply("That's not available anymore.");
    }
    return;
  }

  const index = Number(interaction.values[0]);
  if (!Number.isInteger(index)) {
    await interaction.editReply('Unrecognized choice.');
    return;
  }

  const event: Omit<MatchEvent, 'seq'> = {
    actorId: interaction.user.id,
    type: 'TIEBREAK_CHOICE',
    payload: { round: cachedPending.round, by: me.entrantId, index },
  };

  try {
    const result = await appendMatchEvent(prisma, random, match.id, event, interaction.id);
    const chosenChart = result.state.tiebreaks.find((t) => t.round === cachedPending.round)!.charts[index]!;
    await interaction.editReply(
      `You picked ${compactChartLabel(chosenChart)}. It'll be revealed once your opponent has chosen too.`,
    );
    await applyAppendResult(prisma, matchChannel, alert, match, format, event, result);
  } catch (err) {
    if (err instanceof IllegalActionError) {
      await interaction.editReply("That's not available anymore.");
      return;
    }
    throw err;
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
  match: MatchWithParticipants,
  format: MatchFormat,
  event: Omit<MatchEvent, 'seq'>,
  result: AppendResult,
): Promise<void> {
  const players = buildPlayerDirectory(match);
  const ref: ThreadRef = { matchId: match.id, threadId: match.threadId! };
  const before = match.state as unknown as MatchState;

  // A permanent record of the action itself — the state message's own
  // draw-status field is disposable and will move on to a different
  // prompt, but the sequence of picks should survive in the thread's
  // history regardless. See DESIGN.md, "Two kinds of bot message."
  const log = renderActionLog(event, result.state, players);
  if (log) await matchChannel.postLogMessage(ref, log);

  // A song committed by agreement gets its own permanent log line — a
  // ruling does too, but that one is posted by handleRulingButton, which
  // is the only place that has the referee's identity to attribute it to.
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
    const alertMessage = buildEscalationAlert(match.id, pending.songIndex, pending.reason, mention, threadLink, [
      { entrantId: p0!.entrantId, name: displayName(players, p0!.entrantId) },
      { entrantId: p1!.entrantId, name: displayName(players, p1!.entrantId) },
    ]);
    const alertRef = await alert.raise(match.tournament.guildId, alertMessage);
    await prisma.match.update({ where: { id: match.id }, data: { alertMsgId: alertRef.messageId } });
  }

  // The set just closed — `SET_DECIDED` fires exactly once, the moment
  // `outcome()` turns non-null (both confirmations landed, or a terminal
  // event). "The result summary is a log message and the last thing the
  // bot posts... the thread archives immediately afterward." See
  // DESIGN.md, "Ending the match". No further state message: there is
  // nothing left pending.
  if (result.effects.some((e) => e.kind === 'SET_DECIDED')) {
    const publicMatch = toPublicMatch(format, result.state);
    const [p0, p1] = match.participants;
    const participantIds: [EntrantId, EntrantId] = [p0!.entrantId, p1!.entrantId];
    const nameOf = (id: EntrantId) => displayName(players, id);
    const outcome = publicMatch.outcome!;

    const summary = buildResultSummaryEmbed(publicMatch.songs, publicMatch.points, outcome, participantIds, nameOf);
    await matchChannel.postLogMessage(ref, { embeds: [summary] });

    const announcement = buildResultAnnouncement(match.bracket, match.round, outcome, publicMatch.points, participantIds, nameOf);
    await matchChannel.publishResult(ref, announcement);

    await matchChannel.archiveThread(ref);
    return;
  }

  await matchChannel.postMatchState(ref, renderStateMessage(match.id, pending, result.state, players));
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
    default:
      return null;
  }
}

function describeStale(err: IllegalActionError): string {
  if (err.pending.kind === 'DONE') return 'the match is already decided';
  return `it's currently waiting on ${err.pending.kind.toLowerCase().replaceAll('_', ' ')}`;
}

function buildEvent(
  decoded: CustomId,
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  entrantId: string,
  cachedPending: PendingAction,
): Omit<MatchEvent, 'seq'> | null {
  // actorId is the raw Discord user id (see types.ts's Envelope) — distinct
  // from payload.by, which is the EntrantId the reducer actually reasons
  // about. They're never the same value; conflating them would silently
  // lose who-really-clicked once a referee event needs to attribute a
  // ruling to someone who isn't a participant at all.
  const actorId = interaction.user.id;
  switch (decoded.action) {
    case Action.SEED_CHOICE: {
      const arg = decoded.arg;
      if (arg !== 'FIRST' && arg !== 'SECOND') return null;
      return { actorId, type: 'SEED_CHOICE_MADE', payload: { by: entrantId, order: arg } };
    }
    case Action.PROTECT_VETO: {
      if (!interaction.isStringSelectMenu()) return null;
      const drawIndex = Number(interaction.values[0]);
      if (!Number.isInteger(drawIndex)) return null;
      const type = cachedPending.kind === 'VETO' ? 'CHART_VETOED' : 'CHART_PROTECTED';
      return { actorId, type, payload: { by: entrantId, drawIndex } };
    }
    case Action.WINNER: {
      if (cachedPending.kind !== 'SELECT_WINNER') return null;
      const arg = decoded.arg;
      if (!arg) return null;
      const choice = arg as EntrantId | 'TIE';
      return {
        actorId,
        type: 'SONG_WINNER_SELECTED',
        payload: { songIndex: cachedPending.songIndex, by: entrantId, choice },
      };
    }
    case Action.CONFIRM: {
      if (cachedPending.kind !== 'CONFIRM_RESULT') return null;
      const arg = decoded.arg;
      if (!arg) return null;
      return { actorId, type: 'SET_RESULT_CONFIRMED', payload: { by: entrantId, choice: arg as EntrantId } };
    }
    default:
      return null;
  }
}
