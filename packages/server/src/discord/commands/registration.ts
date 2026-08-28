import type { ChatInputCommandInteraction } from 'discord.js';
import type { TournamentState } from '@prisma/client';
import { checkin, joinTournament, leaveTournament } from '../../services/roster-service.js';
import { memberDisplayName } from '../member-display-name.js';
import { tournamentUrl } from '../../web-url.js';
import { LOG_COLOR } from '../render/draw.js';
import type { CommandContext } from './context.js';
import { logToOrganizers } from './organizer-log.js';

/**
 * `/join`, `/checkin`, `/leave` — the player-facing half of
 * `services/roster-service.ts`. "All three are usable from any channel and
 * answer ephemerally, so a hundred people joining produces no channel
 * traffic at all." See DESIGN.md, "The commands".
 */

/** Shared with `roster.ts`, whose rejections name the same phases. */
export const PHASE_LABEL: Record<TournamentState, string> = {
  DRAFT: "registration hasn't opened yet",
  REGISTRATION_OPEN: 'registration is open',
  REGISTRATION_CLOSED: 'registration is closed',
  CHECKIN_OPEN: 'check-in is open',
  CHECKIN_CLOSED: 'check-in is closed',
  RUNNING: 'the tournament is running',
  COMPLETE: 'the tournament is complete',
  CANCELLED: 'the tournament was cancelled',
};

export async function handleJoin(interaction: ChatInputCommandInteraction, ctx: CommandContext): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({ ephemeral: true, content: 'This only works inside a server.' });
    return;
  }

  const result = await joinTournament(ctx.prisma, interaction.guildId!, interaction.user.id);
  switch (result.kind) {
    case 'JOINED': {
      await interaction.reply({ ephemeral: true, content: "You're registered! Watch for check-in to open." });
      // Organizer alerts (private) name the actor by username; the general
      // channel (public) uses the server display name — see
      // `player-notification-adapter.ts`.
      const tournament = await ctx.prisma.tournament.findUniqueOrThrow({ where: { id: result.entrant.tournamentId } });
      await logToOrganizers(
        ctx.alert,
        interaction.guildId!,
        `📋 **${interaction.user.username}** joined [**${tournament.name}**](${tournamentUrl(tournament.id)}).`,
        { color: LOG_COLOR.ENTRANT_JOINED },
      );
      const displayName = memberDisplayName(interaction.member, interaction.user);
      await ctx.playerNotification.entrantJoined(interaction.guildId!, displayName, tournament.id, tournament.name);
      ctx.realtime.publishRosterChanged(result.entrant.tournamentId);
      return;
    }
    case 'ALREADY_JOINED':
      await interaction.reply({ ephemeral: true, content: "You're already registered." });
      return;
    case 'NO_TOURNAMENT':
      await interaction.reply({ ephemeral: true, content: 'No tournament is accepting entrants.' });
      return;
    case 'WINDOW_CLOSED':
      await interaction.reply({ ephemeral: true, content: `Registration isn't open: ${PHASE_LABEL[result.phase]}.` });
      return;
  }
}

export async function handleCheckin(interaction: ChatInputCommandInteraction, ctx: CommandContext): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({ ephemeral: true, content: 'This only works inside a server.' });
    return;
  }

  const result = await checkin(ctx.prisma, interaction.guildId!, interaction.user.id);
  switch (result.kind) {
    case 'CHECKED_IN': {
      await interaction.reply({ ephemeral: true, content: "You're checked in. Good luck!" });
      const tournament = await ctx.prisma.tournament.findUniqueOrThrow({ where: { id: result.entrant.tournamentId } });
      await logToOrganizers(
        ctx.alert,
        interaction.guildId!,
        `📋 **${interaction.user.username}** checked in for [**${tournament.name}**](${tournamentUrl(tournament.id)}).`,
        { color: LOG_COLOR.ENTRANT_CHECKED_IN },
      );
      const displayName = memberDisplayName(interaction.member, interaction.user);
      await ctx.playerNotification.entrantCheckedIn(interaction.guildId!, displayName);
      ctx.realtime.publishRosterChanged(result.entrant.tournamentId);
      return;
    }
    case 'ALREADY_CHECKED_IN':
      await interaction.reply({ ephemeral: true, content: "You're already checked in." });
      return;
    case 'NO_TOURNAMENT':
      await interaction.reply({ ephemeral: true, content: 'No tournament is taking check-ins.' });
      return;
    case 'WINDOW_CLOSED':
      await interaction.reply({ ephemeral: true, content: `Check-in isn't open: ${PHASE_LABEL[result.phase]}.` });
      return;
    case 'NOT_REGISTERED':
      await interaction.reply({ ephemeral: true, content: "You're not registered for this tournament." });
      return;
  }
}

/**
 * "After check-in closes... a withdrawal... raises an organizer alert" —
 * See DESIGN.md, "Leaving". Every withdrawal is logged to organizers, not
 * just the late one — the late case gets the louder, ⚠️-prefixed phrasing
 * since a TO reviewing the field right before starting deserves to know it
 * just changed, even though seeding itself stays open (and gets collapsed)
 * only at tournament start.
 */
export async function handleLeave(interaction: ChatInputCommandInteraction, ctx: CommandContext): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({ ephemeral: true, content: 'This only works inside a server.' });
    return;
  }

  const result = await leaveTournament(ctx.prisma, interaction.guildId!, interaction.user.id);
  switch (result.kind) {
    case 'LEFT': {
      await interaction.reply({ ephemeral: true, content: "You've withdrawn from the tournament." });
      const tournament = await ctx.prisma.tournament.findUniqueOrThrow({ where: { id: result.entrant.tournamentId } });
      const message = result.alertNeeded
        ? `⚠️ **${interaction.user.username}** withdrew from [**${tournament.name}**](${tournamentUrl(tournament.id)}) after check-in closed.`
        : `📋 **${interaction.user.username}** withdrew from [**${tournament.name}**](${tournamentUrl(tournament.id)}).`;
      await logToOrganizers(ctx.alert, interaction.guildId!, message, { color: LOG_COLOR.GENERAL_TOURNAMENT_CANCELLED });
      ctx.realtime.publishRosterChanged(result.entrant.tournamentId);
      return;
    }
    case 'NO_TOURNAMENT':
      await interaction.reply({ ephemeral: true, content: 'No tournament to withdraw from.' });
      return;
    case 'TOURNAMENT_RUNNING':
      await interaction.reply({ ephemeral: true, content: 'The tournament has already started. See a referee to withdraw.' });
      return;
    case 'NOT_REGISTERED':
      await interaction.reply({ ephemeral: true, content: "You're not registered for this tournament." });
      return;
  }
}
