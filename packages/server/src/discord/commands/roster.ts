import { EmbedBuilder, type ChatInputCommandInteraction, type User } from 'discord.js';
import { rosterAdd, rosterCheckin, rosterRemove, rosterUncheckin } from '../../services/roster-service.js';
import { findActiveTournament } from '../../services/tournament-service.js';
import { fetchDisplayNameById, fetchMemberDisplayName } from '../member-display-name.js';
import { requireOrganizerTier } from './authz.js';
import { logToOrganizers } from './organizer-log.js';
import { PHASE_LABEL } from './registration.js';
import type { CommandContext } from './context.js';

/**
 * `/roster` — a Tournament Organizer acting on a player's behalf. "Anything
 * a player can do for themselves, a Tournament Organizer can do for them...
 * Checking a player in as an organizer writes exactly what `/checkin`
 * writes; removing them writes exactly what `/leave` writes." See
 * DESIGN.md, "Acting on a player's behalf". Every subcommand is gated on
 * Tournament Organizer tier, not Referee — roster composition is
 * tournament management, not unblocking a match.
 *
 * Naming convention throughout: the ephemeral reply (visible only to the
 * organizer who ran the command) names the player by their server display
 * name; the organizer-alert-channel log line — private, but shared by the
 * whole referee pool — names both the actor and the player by their raw
 * Discord username. See `player-notification-adapter.ts`'s doc comment for
 * why the general channel gets the opposite treatment.
 */

export async function handleRoster(interaction: ChatInputCommandInteraction, ctx: CommandContext): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({ ephemeral: true, content: 'This only works inside a server.' });
    return;
  }

  const sub = interaction.options.getSubcommand();
  // `list` is read-only and open to anybody — every other subcommand acts
  // on someone's behalf and stays gated on Tournament Organizer tier below.
  if (sub === 'list') return handleList(interaction, ctx);

  const guildRow = await ctx.prisma.guild.findUnique({ where: { id: interaction.guildId! } });
  if (!(await requireOrganizerTier(interaction, guildRow))) return;

  const player = interaction.options.getUser('player', true);
  const playerName = await fetchMemberDisplayName(interaction.guild, player); // for the ephemeral reply only

  switch (sub) {
    case 'add':
      return handleAdd(interaction, ctx, player, playerName);
    case 'checkin':
      return handleCheckin(interaction, ctx, player, playerName);
    case 'uncheckin':
      return handleUncheckin(interaction, ctx, player, playerName);
    case 'remove':
      return handleRemove(interaction, ctx, player, playerName);
    default:
      await interaction.reply({ ephemeral: true, content: "This command isn't available yet." });
  }
}

/**
 * "This command can be run by anybody to see who is added to the
 * tournament roster." Every `ACTIVE` entrant, seeded ones first in seed
 * order then unseeded ones in join order — the same ordering
 * `renormalizeSeeds` produces. A tournament past `RUNNING` already has
 * `Entrant.displayName` frozen at the start snapshot, so that's used
 * verbatim; earlier than that it's still null and the current server name
 * is fetched live, same as everywhere else pre-start.
 */
async function handleList(interaction: ChatInputCommandInteraction, ctx: CommandContext): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const guild = interaction.guild!;

  const tournament = await findActiveTournament(ctx.prisma, interaction.guildId!);
  if (!tournament) {
    await interaction.editReply('No tournament to show a roster for.');
    return;
  }

  const entrants = await ctx.prisma.entrant.findMany({
    where: { tournamentId: tournament.id, status: 'ACTIVE' },
    orderBy: [{ seed: 'asc' }, { joinedAt: 'asc' }],
  });

  if (entrants.length === 0) {
    await interaction.editReply(`**${tournament.name}** has no entrants yet.`);
    return;
  }

  const lines: string[] = [];
  for (const e of entrants) {
    const name = e.displayName ?? (await fetchDisplayNameById(guild, e.discordUserId));
    const seedLabel = e.seed !== null ? `**${e.seed}.**` : '**—**';
    lines.push(`${seedLabel} ${name}${e.checkedIn ? ' ✅' : ''}`);
  }

  const embed = new EmbedBuilder()
    .setTitle(`${tournament.name} — roster`)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `${entrants.length} entrant(s) · ✅ checked in` });
  await interaction.editReply({ embeds: [embed] });
}

async function handleAdd(interaction: ChatInputCommandInteraction, ctx: CommandContext, player: User, playerName: string): Promise<void> {
  const result = await rosterAdd(ctx.prisma, interaction.guildId!, player.id, interaction.user.id);
  switch (result.kind) {
    case 'JOINED': {
      await interaction.reply({ ephemeral: true, content: `Added **${playerName}** to the roster.` });
      await logToOrganizers(ctx.alert, interaction.guildId!, `📋 **${interaction.user.username}** added **${player.username}** to the roster.`);
      // "Anything a player can do for themselves, a Tournament Organizer can
      // do for them" — same public general-channel hype line `/join` posts.
      await ctx.playerNotification.entrantJoined(interaction.guildId!, playerName);
      ctx.realtime.publishRosterChanged(result.entrant.tournamentId);
      return;
    }
    case 'ALREADY_JOINED':
      await interaction.reply({ ephemeral: true, content: `**${playerName}** is already registered.` });
      return;
    case 'NO_TOURNAMENT':
      await interaction.reply({ ephemeral: true, content: 'No tournament to add them to.' });
      return;
    case 'TOO_LATE':
      await interaction.reply({ ephemeral: true, content: `Can't add anyone — ${PHASE_LABEL[result.phase]}.` });
      return;
  }
}

async function handleCheckin(interaction: ChatInputCommandInteraction, ctx: CommandContext, player: User, playerName: string): Promise<void> {
  const result = await rosterCheckin(ctx.prisma, interaction.guildId!, player.id, interaction.user.id);
  switch (result.kind) {
    case 'CHECKED_IN': {
      await interaction.reply({ ephemeral: true, content: `Checked in **${playerName}**.` });
      await logToOrganizers(ctx.alert, interaction.guildId!, `📋 **${interaction.user.username}** checked in **${player.username}**.`);
      // Same public general-channel hype line `/checkin` posts.
      await ctx.playerNotification.entrantCheckedIn(interaction.guildId!, playerName);
      ctx.realtime.publishRosterChanged(result.entrant.tournamentId);
      return;
    }
    case 'ALREADY_CHECKED_IN':
      await interaction.reply({ ephemeral: true, content: `**${playerName}** is already checked in.` });
      return;
    case 'NO_TOURNAMENT':
      await interaction.reply({ ephemeral: true, content: 'No tournament to check them into.' });
      return;
    case 'WINDOW_CLOSED':
      await interaction.reply({ ephemeral: true, content: `Can't check them in — ${PHASE_LABEL[result.phase]}.` });
      return;
    case 'NOT_REGISTERED':
      await interaction.reply({ ephemeral: true, content: `**${playerName}** isn't registered — use \`/roster add\` first.` });
      return;
  }
}

async function handleUncheckin(interaction: ChatInputCommandInteraction, ctx: CommandContext, player: User, playerName: string): Promise<void> {
  const result = await rosterUncheckin(ctx.prisma, interaction.guildId!, player.id, interaction.user.id);
  switch (result.kind) {
    case 'UNCHECKED_IN': {
      await interaction.reply({ ephemeral: true, content: `Un-checked-in **${playerName}**.` });
      await logToOrganizers(ctx.alert, interaction.guildId!, `📋 **${interaction.user.username}** un-checked-in **${player.username}**.`);
      ctx.realtime.publishRosterChanged(result.entrant.tournamentId);
      return;
    }
    case 'ALREADY_NOT_CHECKED_IN':
      await interaction.reply({ ephemeral: true, content: `**${playerName}** isn't checked in.` });
      return;
    case 'NO_TOURNAMENT':
      await interaction.reply({ ephemeral: true, content: 'No tournament to act on.' });
      return;
    case 'TOO_LATE':
      await interaction.reply({ ephemeral: true, content: `Can't do that — ${PHASE_LABEL[result.phase]}.` });
      return;
    case 'NOT_REGISTERED':
      await interaction.reply({ ephemeral: true, content: `**${playerName}** isn't registered.` });
      return;
  }
}

async function handleRemove(interaction: ChatInputCommandInteraction, ctx: CommandContext, player: User, playerName: string): Promise<void> {
  const result = await rosterRemove(ctx.prisma, interaction.guildId!, player.id, interaction.user.id);
  switch (result.kind) {
    case 'REMOVED': {
      await interaction.reply({ ephemeral: true, content: `Removed **${playerName}** from the tournament.` });
      await logToOrganizers(ctx.alert, interaction.guildId!, `📋 **${interaction.user.username}** removed **${player.username}** from the tournament.`);
      ctx.realtime.publishRosterChanged(result.entrant.tournamentId);
      return;
    }
    case 'NO_TOURNAMENT':
      await interaction.reply({ ephemeral: true, content: 'No tournament to remove them from.' });
      return;
    case 'TOO_LATE':
      await interaction.reply({ ephemeral: true, content: `Can't do that — ${PHASE_LABEL[result.phase]}. See a referee to remove a player mid-tournament.` });
      return;
    case 'NOT_REGISTERED':
      await interaction.reply({ ephemeral: true, content: `**${playerName}** isn't registered.` });
      return;
  }
}
