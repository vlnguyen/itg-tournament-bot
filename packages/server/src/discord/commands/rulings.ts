import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import type { Entrant } from '@prisma/client';
import type { EntrantId } from '../../domain/types.js';
import { requireFormat } from '../../services/engine.js';
import { disqualifyFromTournament } from '../../services/advancement-service.js';
import { appendMatchEvent, IllegalActionError } from '../../services/match-service.js';
import { findActiveTournament } from '../../services/tournament-service.js';
import { renderDqLog } from '../log-messages.js';
import { applyAppendResult, CANCELLED_MATCH_MESSAGE, describeStale } from '../match-event-effects.js';
import { buildPlayerDirectory, loadMatch, loadMatchByThreadId, type MatchWithParticipants } from '../match-lookup.js';
import { memberDisplayName } from '../member-display-name.js';
import type { ThreadRef } from '../ports.js';
import { requireRefereeTier } from './authz.js';
import type { CommandContext } from './context.js';
import { logToOrganizers } from './organizer-log.js';

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
    await applyAppendResult(ctx.prisma, ctx.matchChannel, ctx.alert, ctx.playerNotification, match, format, event, result);

    await interaction.editReply(`Disqualified **${playerName}** from this match.`);
    await logToOrganizers(ctx.alert, interaction.guildId!, `⛔ **${interaction.user.username}** disqualified **${playerName}** from a match.`);
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

  if (resolvedMatch) {
    const match = await loadMatch(ctx.prisma, resolvedMatch.matchId);
    if (match) {
      const format = requireFormat(match.formatKey);
      const players = buildPlayerDirectory(match);
      const ref: ThreadRef = { matchId: match.id, threadId: match.threadId! };
      const refName = refereeDisplayName(interaction);

      await ctx.matchChannel.postLogMessage(ref, renderDqLog(entrant.id as EntrantId, 'TOURNAMENT', refName, players));
      await applyAppendResult(ctx.prisma, ctx.matchChannel, ctx.alert, ctx.playerNotification, match, format, resolvedMatch.event, resolvedMatch.result);
    }
  }

  await interaction.editReply(
    `Disqualified **${playerName}** from **${tournament.name}** — every remaining opponent receives a walkover automatically.`,
  );
  await logToOrganizers(
    ctx.alert,
    interaction.guildId!,
    `⛔ **${interaction.user.username}** disqualified **${playerName}** from the tournament.`,
  );
}
