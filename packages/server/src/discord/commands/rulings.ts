import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import type { Entrant } from '@prisma/client';
import type { EntrantId, MatchEvent, MatchState } from '../../domain/types.js';
import { requireFormat } from '../../services/engine.js';
import { disqualifyFromTournament } from '../../services/advancement-service.js';
import { appendMatchEvent, IllegalActionError } from '../../services/match-service.js';
import { findActiveTournament } from '../../services/tournament-service.js';
import { renderDqLog, renderRulingLog, renderSetRulingLog } from '../log-messages.js';
import { applyAppendResult, CANCELLED_MATCH_MESSAGE, describeStale } from '../match-event-effects.js';
import { buildPlayerDirectory, loadMatch, loadMatchByThreadId, type MatchWithParticipants } from '../match-lookup.js';
import { memberDisplayName } from '../member-display-name.js';
import type { ThreadRef } from '../ports.js';
import { LOG_COLOR } from '../render/draw.js';
import { buildResolvedAlert } from '../render/escalation.js';
import { compactChartLabel } from '../render/chart.js';
import { displayName } from '../state-message.js';
import { requireRefereeTier } from './authz.js';
import type { CommandContext } from './context.js';
import { logToOrganizers, matchLinksBlock } from './organizer-log.js';

/**
 * `/dq` — the referee ruling that ends a match outright rather than
 * unblocking it. Builds a terminal `MatchEvent` and runs it through the
 * same `appendMatchEvent` → `applyAppendResult` pipeline as every
 * button-driven ruling in `interactions.ts`, so a thread's log, escalation
 * resolution and archive behave identically regardless of which surface
 * produced the event. See REQUIREMENTS.md, "Automation Boundary":
 * "Forfeits and disqualifications exist as referee-initiated actions." A
 * plain forfeit — a no-show, or a player conceding — has no command of its
 * own: it is `/dq` scoped to **this match only**, same as a disciplinary
 * disqualification at that scope. See DESIGN.md, "Ending a match by
 * referee ruling".
 *
 * `player` is a `String` option with autocomplete, not Discord's `User`
 * option — a `User` option's picker only ever searches the guild's
 * *current* member list, so a referee could never target the exact player
 * REQUIREMENTS.md names as the reason tournament-scope `/dq` exists: one
 * who has already left the server. Autocomplete instead suggests from the
 * tournament roster (`Entrant.displayName`, snapshotted at start and
 * unaffected by who is still a member), resolving to `discordUserId` —
 * which every DQ path already keys on internally regardless of live
 * membership.
 */

/** A referee's name attributed on a ruling log must be how this *server* shows them — nickname if set — never the raw Discord username. */
function refereeDisplayName(interaction: ChatInputCommandInteraction): string {
  return memberDisplayName(interaction.member, interaction.user);
}

/** The stored roster name, unaffected by whether the player is still a member — see the module doc comment. */
function entrantDisplayName(entrant: Pick<Entrant, 'displayName' | 'discordUserId'>): string {
  return entrant.displayName ?? entrant.discordUserId;
}

/** Takes a bare `channelId` rather than an interaction so both the command handler (`ChatInputCommandInteraction`) and its autocomplete (`AutocompleteInteraction`) can share it. */
async function resolveInvokingThreadMatch(channelId: string | null, ctx: CommandContext): Promise<MatchWithParticipants | null> {
  if (!channelId) return null;
  return loadMatchByThreadId(ctx.prisma, channelId);
}

/**
 * Suggests from the invoking match's two participants when `scope` is
 * already "this match" — `scope` is the first option in the command, so by
 * the time a referee reaches `player` its value is normally already known
 * — and otherwise from the tournament's whole active roster. Never gated
 * on referee tier: `/roster list` already makes this same roster public,
 * so autocomplete surfaces nothing a non-referee couldn't already see.
 */
export async function handleDqAutocomplete(interaction: AutocompleteInteraction, ctx: CommandContext): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.respond([]);
    return;
  }

  const scope = interaction.options.getString('scope');
  const focused = interaction.options.getFocused().toLowerCase();

  let candidates: Pick<Entrant, 'displayName' | 'discordUserId'>[];
  if (scope === 'match') {
    const match = await resolveInvokingThreadMatch(interaction.channelId, ctx);
    candidates = match ? match.participants.map((p) => p.entrant) : [];
  } else {
    const tournament = await findActiveTournament(ctx.prisma, interaction.guildId!);
    candidates = tournament
      ? await ctx.prisma.entrant.findMany({
          where: { tournamentId: tournament.id, status: 'ACTIVE' },
          orderBy: [{ seed: 'asc' }, { joinedAt: 'asc' }],
        })
      : [];
  }

  const choices = candidates
    .map((e) => ({ name: entrantDisplayName(e), value: e.discordUserId }))
    .filter((c) => c.name.toLowerCase().includes(focused))
    .slice(0, 25);

  await interaction.respond(choices);
}

export async function handleDq(interaction: ChatInputCommandInteraction, ctx: CommandContext): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({ ephemeral: true, content: 'This only works inside a server.' });
    return;
  }

  const guildRow = await ctx.prisma.guild.findUnique({ where: { id: interaction.guildId! } });
  if (!(await requireRefereeTier(interaction, guildRow))) return;

  const playerId = interaction.options.getString('player', true);
  const scope = interaction.options.getString('scope', true) as 'match' | 'tournament';

  if (scope === 'match') return handleMatchScopeDq(interaction, ctx, playerId);
  return handleTournamentScopeDq(interaction, ctx, playerId);
}

async function handleMatchScopeDq(interaction: ChatInputCommandInteraction, ctx: CommandContext, playerId: string): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const match = await resolveInvokingThreadMatch(interaction.channelId, ctx);
  if (!match) {
    await interaction.editReply('Run this inside the match thread you want to rule on.');
    return;
  }
  if (match.status === 'CANCELLED') {
    await interaction.editReply(CANCELLED_MATCH_MESSAGE);
    return;
  }

  const participant = match.participants.find((p) => p.entrant.discordUserId === playerId);
  if (!participant) {
    // Autocomplete only ever offers this match's own two participants for
    // scope "match", so reaching here means a stale or hand-typed value —
    // there is no entrant row scoped to this match to name, so the id is
    // all that is left to show.
    await interaction.editReply(`That player isn't a participant in this match (${playerId}).`);
    return;
  }

  const playerName = entrantDisplayName(participant.entrant);
  const event = {
    actorId: interaction.user.id,
    type: 'DQ_APPLIED' as const,
    payload: { playerId: participant.entrantId as EntrantId, scope: 'MATCH' as const },
  };

  try {
    const result = await appendMatchEvent(ctx.prisma, ctx.random, match.id, event, interaction.id);
    const format = requireFormat(match.formatKey);
    const players = buildPlayerDirectory(match);
    const ref: ThreadRef = { matchId: match.id, threadId: match.threadId! };
    const refName = refereeDisplayName(interaction);

    await ctx.matchChannel.postLogMessage(ref, renderDqLog(participant.entrantId as EntrantId, 'MATCH', refName, players));
    await applyAppendResult(ctx.prisma, ctx.matchChannel, ctx.alert, ctx.playerNotification, ctx.realtime, match, format, event, result);

    await interaction.editReply(`Disqualified **${playerName}** from this match.`);
    await logToOrganizers(
      ctx.alert,
      interaction.guildId!,
      `**${interaction.user.username}** disqualified **${playerName}** from a match.\n\n${matchLinksBlock(interaction.guildId!, ref, match.tournamentId)}`,
      { title: '⛔ Disqualification', color: LOG_COLOR.RULING },
    );
  } catch (err) {
    if (err instanceof IllegalActionError) {
      await interaction.editReply(`Can't rule on that — ${describeStale(err)}.`);
      return;
    }
    throw err;
  }
}

async function handleTournamentScopeDq(interaction: ChatInputCommandInteraction, ctx: CommandContext, playerId: string): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const tournament = await findActiveTournament(ctx.prisma, interaction.guildId!);
  if (!tournament) {
    await interaction.editReply('No tournament to act on.');
    return;
  }

  const entrant = await ctx.prisma.entrant.findFirst({
    where: { tournamentId: tournament.id, discordUserId: playerId, status: 'ACTIVE' },
  });
  if (!entrant) {
    await interaction.editReply(`That player (${playerId}) isn't an active entrant in **${tournament.name}**.`);
    return;
  }

  const playerName = entrantDisplayName(entrant);
  const { resolvedMatch } = await disqualifyFromTournament(ctx.prisma, ctx.random, tournament.id, entrant.id, interaction.user.id);

  // No match/thread to link when the player wasn't mid-set — the DQ still
  // walked the bracket, just with nothing live for an organizer to jump to.
  let linksBlock = '';
  if (resolvedMatch) {
    const match = await loadMatch(ctx.prisma, resolvedMatch.matchId);
    if (match) {
      const format = requireFormat(match.formatKey);
      const players = buildPlayerDirectory(match);
      const ref: ThreadRef = { matchId: match.id, threadId: match.threadId! };
      const refName = refereeDisplayName(interaction);

      await ctx.matchChannel.postLogMessage(ref, renderDqLog(entrant.id as EntrantId, 'TOURNAMENT', refName, players));
      await applyAppendResult(ctx.prisma, ctx.matchChannel, ctx.alert, ctx.playerNotification, ctx.realtime, match, format, resolvedMatch.event, resolvedMatch.result);
      linksBlock = `\n\n${matchLinksBlock(interaction.guildId!, ref, match.tournamentId)}`;
    }
  }

  await interaction.editReply(
    `Disqualified **${playerName}** from **${tournament.name}** — every remaining opponent receives a walkover automatically.`,
  );
  await logToOrganizers(
    ctx.alert,
    interaction.guildId!,
    `**${interaction.user.username}** disqualified **${playerName}** from the tournament.${linksBlock}`,
    { title: '⛔ Disqualification', color: LOG_COLOR.RULING },
  );
}

/**
 * `/rule` — DESIGN.md, "Proactive song and set rulings": the same
 * pre-conflict override capability `referee-overrides.tsx` already
 * exposes on the web, reached in Discord the way `/dq` reaches its match
 * — run from inside the thread, no escalation alert required. `song`
 * rules whatever song the match is currently on
 * (`state.songs.find(s => !s.result)`, via `pendingAction`, never a
 * `songIndex` argument); `set` rules the overall outcome directly,
 * pre-empting any songs still unplayed. All other legality is left to
 * `appendMatchEvent`'s own check — the same `isLegal` the web ruling
 * endpoint and the alert-channel buttons already share.
 */

/** Suggests this match's two participants (plus Tie/Void for `song`) — same autocomplete-a-roster reasoning as `/dq`'s `player` option. */
export async function handleRuleAutocomplete(interaction: AutocompleteInteraction, ctx: CommandContext): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.respond([]);
    return;
  }

  const match = await resolveInvokingThreadMatch(interaction.channelId, ctx);
  const candidates = match ? match.participants.map((p) => p.entrant) : [];
  const focused = interaction.options.getFocused().toLowerCase();
  const extra = interaction.options.getSubcommand() === 'song' ? [{ name: 'Tie', value: 'TIE' }, { name: 'Void', value: 'VOID' }] : [];

  const choices = [...candidates.map((e) => ({ name: entrantDisplayName(e), value: e.discordUserId })), ...extra]
    .filter((c) => c.name.toLowerCase().includes(focused))
    .slice(0, 25);

  await interaction.respond(choices);
}

/** `result`'s autocomplete offers a participant's `discordUserId`, or the literal `TIE`/`VOID` — resolve the former back to the `entrantId` every event payload actually keys on, same as `/dq`'s `player`. */
function resolveRulingResult(match: MatchWithParticipants, raw: string): EntrantId | 'TIE' | 'VOID' | null {
  if (raw === 'TIE' || raw === 'VOID') return raw;
  const participant = match.participants.find((p) => p.entrant.discordUserId === raw);
  return participant ? (participant.entrantId as EntrantId) : null;
}

export async function handleRule(interaction: ChatInputCommandInteraction, ctx: CommandContext): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({ ephemeral: true, content: 'This only works inside a server.' });
    return;
  }

  const guildRow = await ctx.prisma.guild.findUnique({ where: { id: interaction.guildId! } });
  if (!(await requireRefereeTier(interaction, guildRow))) return;

  const sub = interaction.options.getSubcommand(true) as 'song' | 'set';
  const resultArg = interaction.options.getString('result', true);

  await interaction.deferReply({ ephemeral: true });

  const match = await resolveInvokingThreadMatch(interaction.channelId, ctx);
  if (!match) {
    await interaction.editReply('Run this inside the match thread you want to rule on.');
    return;
  }
  if (match.status === 'CANCELLED') {
    await interaction.editReply(CANCELLED_MATCH_MESSAGE);
    return;
  }

  const rulingResult = resolveRulingResult(match, resultArg);
  if (rulingResult === null) {
    await interaction.editReply(`That player isn't a participant in this match (${resultArg}).`);
    return;
  }

  const format = requireFormat(match.formatKey);
  const players = buildPlayerDirectory(match);
  const ref: ThreadRef = { matchId: match.id, threadId: match.threadId! };
  const refName = refereeDisplayName(interaction);

  if (sub === 'set') {
    if (rulingResult === 'TIE' || rulingResult === 'VOID') {
      await interaction.editReply('A set can only be awarded to a player, not tied or voided.');
      return;
    }
    const event: Omit<MatchEvent, 'seq'> = {
      actorId: interaction.user.id,
      type: 'SET_RESULT_RULED',
      payload: { result: rulingResult },
    };
    try {
      const result = await appendMatchEvent(ctx.prisma, ctx.random, match.id, event, interaction.id);
      if (match.alertMsgId) {
        const outcome = `awarded the set to ${displayName(players, rulingResult)}`;
        await ctx.alert.resolve(match.tournament.guildId, { messageId: match.alertMsgId }, buildResolvedAlert(refName, outcome));
        await ctx.prisma.match.update({ where: { id: match.id }, data: { alertMsgId: null } });
      }
      await ctx.matchChannel.postLogMessage(ref, renderSetRulingLog(rulingResult, refName, players));
      await applyAppendResult(ctx.prisma, ctx.matchChannel, ctx.alert, ctx.playerNotification, ctx.realtime, match, format, event, result);
      await logToOrganizers(
        ctx.alert,
        interaction.guildId!,
        `Set result awarded to **${displayName(players, rulingResult)}** — ruling by **${refName}**\n\n${matchLinksBlock(interaction.guildId!, ref, match.tournamentId)}`,
        { title: '⚖️ Set resolution', color: LOG_COLOR.RULING },
      );
      await interaction.editReply(`Awarded the set to **${displayName(players, rulingResult)}**.`);
    } catch (err) {
      if (err instanceof IllegalActionError) {
        await interaction.editReply(`Can't rule on that — ${describeStale(err)}.`);
        return;
      }
      throw err;
    }
    return;
  }

  // sub === 'song' — always the match's current song, never a picked index,
  // so the web and Discord act on the identical target.
  const cachedState = match.state as unknown as MatchState;
  const pending = format.pendingAction(cachedState);
  const songIndex =
    pending.kind === 'SUBMIT_SCORE' || pending.kind === 'SELECT_WINNER'
      ? pending.songIndex
      : pending.kind === 'AWAITING_TO'
        ? pending.songIndex
        : undefined;
  if (songIndex === undefined) {
    await interaction.editReply("There's no song currently in play to rule on.");
    return;
  }

  const event: Omit<MatchEvent, 'seq'> = {
    actorId: interaction.user.id,
    type: 'SONG_RULED',
    payload: { songIndex, result: rulingResult },
  };
  try {
    const result = await appendMatchEvent(ctx.prisma, ctx.random, match.id, event, interaction.id);
    const chart = result.state.songs[songIndex]!.chart;

    if (match.alertMsgId) {
      const outcome = rulingResult === 'VOID' ? 'voided' : rulingResult === 'TIE' ? 'ruled a tie' : `awarded to ${displayName(players, rulingResult)}`;
      await ctx.alert.resolve(match.tournament.guildId, { messageId: match.alertMsgId }, buildResolvedAlert(refName, outcome));
      await ctx.prisma.match.update({ where: { id: match.id }, data: { alertMsgId: null } });
    }

    await ctx.matchChannel.postLogMessage(ref, renderRulingLog(songIndex, chart, rulingResult, refName, players));
    await applyAppendResult(ctx.prisma, ctx.matchChannel, ctx.alert, ctx.playerNotification, ctx.realtime, match, format, event, result);

    const alertOutcome = rulingResult === 'VOID' ? 'voided' : rulingResult === 'TIE' ? 'ruled a tie' : `awarded to **${displayName(players, rulingResult)}**`;
    await logToOrganizers(
      ctx.alert,
      interaction.guildId!,
      `Song ${songIndex + 1} (${compactChartLabel(chart)}) ${alertOutcome} — ruling by **${refName}**\n\n${matchLinksBlock(interaction.guildId!, ref, match.tournamentId)}`,
      { title: '⚖️ Song resolution', color: LOG_COLOR.RULING },
    );

    const outcomeText = rulingResult === 'VOID' ? 'Voided' : rulingResult === 'TIE' ? 'Ruled a tie for' : `Awarded to **${displayName(players, rulingResult)}** —`;
    await interaction.editReply(`${outcomeText} song ${songIndex + 1}.`);
  } catch (err) {
    if (err instanceof IllegalActionError) {
      await interaction.editReply(`Can't rule on that — ${describeStale(err)}.`);
      return;
    }
    throw err;
  }
}
