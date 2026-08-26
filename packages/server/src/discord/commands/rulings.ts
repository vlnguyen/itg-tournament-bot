import type { ChatInputCommandInteraction, User } from 'discord.js';
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
 */

/** A referee's name attributed on a ruling log must be how this *server* shows them — nickname if set — never the raw Discord username. */
function refereeDisplayName(interaction: ChatInputCommandInteraction): string {
  return memberDisplayName(interaction.member, interaction.user);
}

async function resolveInvokingThreadMatch(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<MatchWithParticipants | null> {
  if (!interaction.channelId) return null;
  return loadMatchByThreadId(ctx.prisma, interaction.channelId);
}

export async function handleDq(interaction: ChatInputCommandInteraction, ctx: CommandContext): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({ ephemeral: true, content: 'This only works inside a server.' });
    return;
  }

  const guildRow = await ctx.prisma.guild.findUnique({ where: { id: interaction.guildId! } });
  if (!(await requireRefereeTier(interaction, guildRow))) return;

  const player = interaction.options.getUser('player', true);
  const scope = interaction.options.getString('scope', true) as 'match' | 'tournament';

  if (scope === 'match') return handleMatchScopeDq(interaction, ctx, player);
  return handleTournamentScopeDq(interaction, ctx, player);
}

async function handleMatchScopeDq(interaction: ChatInputCommandInteraction, ctx: CommandContext, player: User): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const match = await resolveInvokingThreadMatch(interaction, ctx);
  if (!match) {
    await interaction.editReply('Run this inside the match thread you want to rule on.');
    return;
  }
  if (match.status === 'CANCELLED') {
    await interaction.editReply(CANCELLED_MATCH_MESSAGE);
    return;
  }

  const participant = match.participants.find((p) => p.entrant.discordUserId === player.id);
  if (!participant) {
    await interaction.editReply(`**${player.username}** isn't a participant in this match.`);
    return;
  }

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

    await interaction.editReply(`Disqualified **${player.username}** from this match.`);
    await logToOrganizers(
      ctx.alert,
      interaction.guildId!,
      `⛔ **${interaction.user.username}** disqualified **${player.username}** from a match.`,
    );
  } catch (err) {
    if (err instanceof IllegalActionError) {
      await interaction.editReply(`Can't rule on that — ${describeStale(err)}.`);
      return;
    }
    throw err;
  }
}

async function handleTournamentScopeDq(interaction: ChatInputCommandInteraction, ctx: CommandContext, player: User): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const tournament = await findActiveTournament(ctx.prisma, interaction.guildId!);
  if (!tournament) {
    await interaction.editReply('No tournament to act on.');
    return;
  }

  const entrant = await ctx.prisma.entrant.findFirst({
    where: { tournamentId: tournament.id, discordUserId: player.id, status: 'ACTIVE' },
  });
  if (!entrant) {
    await interaction.editReply(`**${player.username}** isn't an active entrant in **${tournament.name}**.`);
    return;
  }

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
    `Disqualified **${player.username}** from **${tournament.name}** — every remaining opponent receives a walkover automatically.`,
  );
  await logToOrganizers(
    ctx.alert,
    interaction.guildId!,
    `⛔ **${interaction.user.username}** disqualified **${player.username}** from the tournament.`,
  );
}
