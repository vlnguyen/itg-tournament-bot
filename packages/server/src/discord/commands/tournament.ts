import type { ChatInputCommandInteraction } from 'discord.js';
import type { Guild as GuildRow, Tournament } from '@prisma/client';
import { describeGap } from '../permission-diagnostic.js';
import { provisionReadyThreads } from '../thread-provisioning.js';
import { hasTier, Tier } from '../tier.js';
import {
  cancelTournament,
  closeCheckin,
  closeRegistration,
  createTournament,
  findActiveTournament,
  openCheckin,
  openRegistration,
  renameTournament,
  startTournament,
  TournamentSlotOccupiedError,
  TournamentTransitionError,
} from '../../services/tournament-service.js';
import { requireOrganizerTier } from './authz.js';
import type { CommandContext } from './context.js';
import { logToOrganizers } from './organizer-log.js';
import { runFullDiagnostic, type RequiredTierRole } from './setup.js';

/**
 * `/tournament` — the lifecycle command surface over `services/tournament-service.ts`.
 * See DESIGN.md, "Tournament Lifecycle": "Every transition is an explicit
 * action by someone at Tournament Organizer tier or above." Gated on tier
 * alone, not Discord's own permissions — same reasoning as everywhere else
 * authority is resolved from a configured role. See DESIGN.md, "Rulings".
 */

export async function handleTournament(interaction: ChatInputCommandInteraction, ctx: CommandContext): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({ ephemeral: true, content: 'This only works inside a server.' });
    return;
  }

  const guildRow = await ctx.prisma.guild.findUnique({ where: { id: interaction.guildId! } });
  if (!(await requireOrganizerTier(interaction, guildRow))) return;

  const sub = interaction.options.getSubcommand();
  if (sub === 'create') return handleCreate(interaction, ctx);

  // Every subcommand but `create` has no tournament-id argument (see
  // `definitions.ts`) — it acts on the one tournament this guild holds.
  // "A tournament occupies the slot from the moment it is created," so
  // `findActiveTournament` is unambiguous here — there is never more than
  // one to pick between.
  const tournament = await findActiveTournament(ctx.prisma, interaction.guildId!);
  if (!tournament) {
    await interaction.reply({ ephemeral: true, content: 'No tournament to act on — run `/tournament create` first.' });
    return;
  }

  switch (sub) {
    case 'open-registration':
      return runTransition(
        interaction,
        ctx,
        () => openRegistration(ctx.prisma, tournament.id, interaction.user.id),
        (t) => `Registration is open for **${t.name}** — \`/join\` now works.`,
        (t) => ctx.playerNotification.registrationOpened(interaction.guildId!, t.name),
      );
    case 'close-registration':
      return runTransition(
        interaction,
        ctx,
        () => closeRegistration(ctx.prisma, tournament.id, interaction.user.id),
        (t) => `Registration is closed for **${t.name}**.`,
      );
    case 'open-checkin':
      return handleOpenCheckin(interaction, ctx, tournament);
    case 'close-checkin':
      return runTransition(
        interaction,
        ctx,
        () => closeCheckin(ctx.prisma, tournament.id, interaction.user.id),
        (t) => `Check-in is closed for **${t.name}** — seeds are renumbered and locked in.`,
        (t) => ctx.playerNotification.checkinClosed(interaction.guildId!, t.name),
      );
    case 'start':
      return handleStart(interaction, ctx, tournament, guildRow!);
    case 'cancel':
      return runTransition(
        interaction,
        ctx,
        () => cancelTournament(ctx.prisma, tournament.id, interaction.user.id),
        (t) => `**${t.name}** is cancelled.`,
        (t) => ctx.playerNotification.tournamentCancelled(interaction.guildId!, t.name),
      );
    case 'rename': {
      const name = interaction.options.getString('name', true);
      return runTransition(
        interaction,
        ctx,
        () => renameTournament(ctx.prisma, tournament.id, name, interaction.user.id),
        (t) => `Renamed to **${t.name}**.`,
      );
    }
    default:
      await interaction.reply({ ephemeral: true, content: "This command isn't available yet." });
  }
}

/** "If a tournament is created then that is the tournament the bot is now holding" — released only by `/tournament cancel` or reaching `COMPLETE`. */
async function handleCreate(interaction: ChatInputCommandInteraction, ctx: CommandContext): Promise<void> {
  const name = interaction.options.getString('name', true);
  try {
    const t = await createTournament(ctx.prisma, interaction.guildId!, name, interaction.user.id);
    await interaction.reply({
      ephemeral: true,
      content: `Created **${t.name}** (draft). Run \`/tournament open-registration\` when you're ready for \`/join\` to start working.`,
    });
    // Alert-channel messages name the actor by their raw Discord username —
    // that channel is organizer-private, unlike the general channel, which
    // uses the server display name. See `player-notification-adapter.ts`.
    await logToOrganizers(ctx.alert, interaction.guildId!, `🆕 **${interaction.user.username}** created tournament **${t.name}**.`);
  } catch (err) {
    if (err instanceof TournamentSlotOccupiedError) {
      await interaction.reply({
        ephemeral: true,
        content: `This server is already holding **${err.held.name}** (${err.held.state}). Rename it with \`/tournament rename\`, or run \`/tournament cancel\` before creating a new one.`,
      });
      return;
    }
    throw err;
  }
}

/**
 * Shared shape for the plain transitions: defer, run the service call,
 * translate a guard failure into a friendly ephemeral reply, and — on
 * success — post a line to the organizer alert channel. "All tournament
 * and roster changes should be logged to organizer alerts."
 */
async function runTransition(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
  run: () => Promise<Tournament>,
  describe: (t: Tournament) => string,
  afterSuccess?: (t: Tournament) => Promise<void>,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  try {
    const t = await run();
    const description = describe(t);
    await interaction.editReply(description);
    await logToOrganizers(ctx.alert, interaction.guildId!, `📋 **${interaction.user.username}**: ${description}`);
    if (afterSuccess) await afterSuccess(t);
  } catch (err) {
    if (err instanceof TournamentTransitionError) {
      await interaction.editReply(`Can't do that: ${err.reason}`);
      return;
    }
    throw err;
  }
}

/** "The bot announces when check-in opens... and direct messages every registered player." See REQUIREMENTS.md, "Notifications". */
async function handleOpenCheckin(interaction: ChatInputCommandInteraction, ctx: CommandContext, tournament: Tournament): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  let opened: Tournament;
  try {
    opened = await openCheckin(ctx.prisma, tournament.id, interaction.user.id);
  } catch (err) {
    if (err instanceof TournamentTransitionError) {
      await interaction.editReply(`Can't do that: ${err.reason}`);
      return;
    }
    throw err;
  }

  const registered = await ctx.prisma.entrant.findMany({
    where: { tournamentId: tournament.id, status: 'ACTIVE' },
    select: { discordUserId: true },
  });
  const { unreachable } = await ctx.playerNotification.checkinOpened(interaction.guildId!, registered.map((e) => e.discordUserId));

  const lines = [`Check-in is open for **${opened.name}** — registered players have been notified.`];
  if (unreachable.length > 0) lines.push(`⚠️ Could not DM: ${unreachable.map((id) => `<@${id}>`).join(', ')}.`);
  await interaction.editReply(lines.join('\n'));

  const logLines = [`📋 **${interaction.user.username}**: check-in is open for **${opened.name}**.`];
  if (unreachable.length > 0) logLines.push(`⚠️ Could not DM: ${unreachable.map((id) => `<@${id}>`).join(', ')}.`);
  await logToOrganizers(ctx.alert, interaction.guildId!, logLines.join('\n'));
}

const TIER_ROLE_LABEL: Record<RequiredTierRole, string> = { referee: 'Referee', organizer: 'Tournament Organizer' };

function describePreflightFailure(diag: Awaited<ReturnType<typeof runFullDiagnostic>>): string {
  const lines = ["Can't start — Discord isn't fully set up yet:"];
  for (const role of diag.missingTierRoles) {
    lines.push(`- The ${TIER_ROLE_LABEL[role]} role is not configured — run \`/setup roles\`.`);
  }
  for (const role of diag.deletedTierRoles) {
    lines.push(`- The configured ${TIER_ROLE_LABEL[role]} role no longer exists — run \`/setup roles\`.`);
  }
  for (const slot of diag.missingChannels) {
    lines.push(`- The configured ${slot} channel no longer exists — run \`/setup channels\`.`);
  }
  for (const gap of diag.gaps) {
    lines.push(`- ${describeGap({ permission: gap.permission, layer: gap.layer }, gap.targetLabel, `<#${gap.channelId}>`)}`);
  }
  lines.push('', 'Run `/setup status` to see the full diagnostic and fix these, then try again.');
  return lines.join('\n');
}

/**
 * `CHECKIN_CLOSED → RUNNING`. Everything Discord-shaped that
 * `tournament-service.ts`'s `startTournament` deliberately leaves out: the
 * blocking permission preflight (reusing `/setup`'s own diagnostic), the
 * non-blocking tier-role-overlap warning ("tournament start warns if any
 * entrant also holds a tier role, naming them" — REQUIREMENTS.md, "Roles"),
 * the live display-name snapshot, and provisioning round 1's threads.
 */
async function handleStart(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
  tournament: Tournament,
  guildRow: GuildRow,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const guild = interaction.guild!;

  const diag = await runFullDiagnostic(ctx, guild, guildRow);
  const blocking = diag.gaps.length > 0 || diag.missingChannels.length > 0 || diag.missingTierRoles.length > 0 || diag.deletedTierRoles.length > 0;
  if (blocking) {
    await interaction.editReply(describePreflightFailure(diag));
    return;
  }

  const entrants = await ctx.prisma.entrant.findMany({
    where: { tournamentId: tournament.id, status: 'ACTIVE', checkedIn: true },
  });
  const displayNames = new Map<string, string>();
  const holdsTierRole: string[] = [];
  for (const e of entrants) {
    const member = await guild.members.fetch(e.discordUserId).catch(() => null);
    if (!member) continue; // left the guild — seated anyway; nothing here to snapshot or warn on
    displayNames.set(e.id, member.displayName);
    if (hasTier(member.roles.cache.keys(), guildRow, Tier.REFEREE)) holdsTierRole.push(member.displayName);
  }

  let result;
  try {
    result = await startTournament(ctx.prisma, ctx.random, tournament.id, displayNames, interaction.user.id);
  } catch (err) {
    if (err instanceof TournamentTransitionError) {
      await interaction.editReply(`Can't start: ${err.reason}`);
      return;
    }
    throw err;
  }

  const threads = await provisionReadyThreads(ctx.prisma, ctx.matchChannel, ctx.playerNotification, tournament.id);

  const lines = [`🏁 **${result.tournament.name}** has started — ${threads.length} match thread(s) created.`];
  if (result.packSizeWarning) {
    lines.push(`⚠️ The chart pack has only ${result.packSizeWarning.actual} chart(s); ${result.packSizeWarning.recommended}+ is recommended.`);
  }
  if (diag.refereePoolEmpty) {
    lines.push('⚠️ Nobody holds a role at Referee tier or above yet — a dispute has nobody to rule on it.');
  }
  if (holdsTierRole.length > 0) {
    lines.push(`⚠️ These entrants also hold a tier role: ${holdsTierRole.join(', ')}.`);
  }
  await interaction.editReply(lines.join('\n'));

  await logToOrganizers(ctx.alert, interaction.guildId!, [`📋 **${interaction.user.username}**:`, ...lines].join('\n'));
  await ctx.playerNotification.tournamentStarted(interaction.guildId!, result.tournament.name);
}
