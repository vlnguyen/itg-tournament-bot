import { readFileSync } from 'node:fs';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { Guild as GuildRow, Tournament } from '@prisma/client';
import type { ChartInput } from '@itg/shared';
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
import { PHASE_LABEL } from './registration.js';
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

  // Public — anyone can check what's going on and what they can do right
  // now, so this runs before the organizer-tier gate below, the same way
  // `/roster list` is carved out ahead of that command's own gate.
  const sub = interaction.options.getSubcommand();
  if (sub === 'status') return handleStatus(interaction, ctx);

  const guildRow = await ctx.prisma.guild.findUnique({ where: { id: interaction.guildId! } });
  if (!(await requireOrganizerTier(interaction, guildRow))) return;

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
      return handleCancel(interaction, ctx, tournament);
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

// DEBUG — not meant to ship. Every tournament created during manual testing
// gets auto-seeded with a real chart pack (Storm 2026), so there's always
// something to draw from without a separate import step (`/pack import`
// doesn't exist yet). `debug-storm-2026-pack.json` is a one-time dump of
// `readPackDirectory("/Users/vincent/Downloads/Storm 2026")` — parsed once
// and committed as data, not re-parsed from the real pack on every create.
// Delete this block, the import above it, and the JSON file together once
// `/pack import` exists for real.
const DEBUG_PACK_PATH = new URL('../../../scripts/debug-storm-2026-pack.json', import.meta.url);
let debugPackCache: ChartInput[] | null = null;
function loadDebugPack(): ChartInput[] {
  debugPackCache ??= JSON.parse(readFileSync(DEBUG_PACK_PATH, 'utf8')) as ChartInput[];
  return debugPackCache;
}

/**
 * `/tournament status` — the one lifecycle-adjacent command with no tier
 * gate. Names the phase in the same words `PHASE_LABEL` already gives a
 * rejected `/join`/`/checkin`, then adds whichever of those two is actually
 * actionable right now, paired with `/leave` since it works alongside both
 * — "any time before it starts," DESIGN.md's "Leaving". Check-in closed
 * gets its own callout: nothing is actionable there, but it is the one
 * phase that means "the bracket is coming imminently."
 *
 * `DRAFT` is treated as no tournament at all. A draft is a TO still setting
 * up — nothing public has happened yet, `/join` doesn't work, and naming it
 * would announce a tournament to the server before its organizer chose to.
 */
async function handleStatus(interaction: ChatInputCommandInteraction, ctx: CommandContext): Promise<void> {
  const tournament = await findActiveTournament(ctx.prisma, interaction.guildId!);
  if (!tournament || tournament.state === 'DRAFT') {
    await interaction.reply({ ephemeral: true, content: 'No tournament right now in this server.' });
    return;
  }

  const lines = [`**${tournament.name}** — ${PHASE_LABEL[tournament.state]}.`];
  switch (tournament.state) {
    case 'REGISTRATION_OPEN':
      lines.push('`/join` to register — or `/leave` if you change your mind.');
      break;
    case 'CHECKIN_OPEN':
      lines.push("`/checkin` to confirm you're playing — or `/leave` if you can't make it.");
      break;
    case 'CHECKIN_CLOSED':
      lines.push('Seeds are locked in — the tournament is about to start.');
      break;
  }
  await interaction.reply({ ephemeral: true, content: lines.join('\n') });
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

    // DEBUG — see the block above.
    try {
      const charts = loadDebugPack();
      await ctx.prisma.chart.createMany({ data: charts.map((c) => ({ tournamentId: t.id, ...c })) });
      console.log(`[DEBUG] seeded ${charts.length} chart(s) from debug-storm-2026-pack.json into "${t.name}"`);
    } catch (err) {
      console.warn(`[DEBUG] failed to auto-seed test pack: ${(err as Error).message}`);
    }
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
  const { unreachable } = await ctx.playerNotification.checkinOpened(interaction.guildId!, opened.name, registered.map((e) => e.discordUserId));

  const lines = [`Check-in is open for **${opened.name}** — registered players have been notified.`];
  if (unreachable.length > 0) lines.push(`⚠️ Could not DM: ${unreachable.map((id) => `<@${id}>`).join(', ')}.`);
  await interaction.editReply(lines.join('\n'));

  const logLines = [`📋 **${interaction.user.username}**: check-in is open for **${opened.name}**.`];
  if (unreachable.length > 0) logLines.push(`⚠️ Could not DM: ${unreachable.map((id) => `<@${id}>`).join(', ')}.`);
  await logToOrganizers(ctx.alert, interaction.guildId!, logLines.join('\n'));
}

/**
 * Reachable from `RUNNING` too — "for any number of reasons... a tournament
 * may need to be cancelled midway." `cancelTournament` already marked every
 * not-yet-`COMPLETE` match `CANCELLED`; this closes out whichever of those
 * had a live thread — a note posted in it, then archived, the same
 * mechanism `matchChannel` already uses to close a thread on ordinary match
 * completion — and announces the cancellation to the general channel.
 */
async function handleCancel(interaction: ChatInputCommandInteraction, ctx: CommandContext, tournament: Tournament): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  let result;
  try {
    result = await cancelTournament(ctx.prisma, tournament.id, interaction.user.id);
  } catch (err) {
    if (err instanceof TournamentTransitionError) {
      await interaction.editReply(`Can't do that: ${err.reason}`);
      return;
    }
    throw err;
  }

  const cancelledWithThreads =
    result.cancelledMatchIds.length > 0
      ? await ctx.prisma.match.findMany({
          where: { id: { in: result.cancelledMatchIds }, threadId: { not: null } },
          select: { id: true, threadId: true },
        })
      : [];

  for (const m of cancelledWithThreads) {
    const ref = { matchId: m.id, threadId: m.threadId! };
    await ctx.matchChannel.postLogMessage(ref, { content: '⚠️ This tournament has been cancelled. This match will not be completed.' });
    // Replaces whatever was last — Protect/Veto, a score-submit button, a
    // tiebreak select, anything — with a plain, component-free message, so
    // there's no live prompt left to click. `postMatchState` edits the
    // current state message in place (or reposts) with exactly the
    // components given; omitting them here clears whatever was there.
    await ctx.matchChannel.postMatchState(ref, { content: 'This match has been cancelled — no further action is possible.' });
    await ctx.matchChannel.archiveThread(ref);
  }

  const lines = [`**${result.tournament.name}** is cancelled.`];
  if (result.cancelledMatchIds.length > 0) {
    lines.push(`⚠️ ${result.cancelledMatchIds.length} in-progress match(es) were cancelled — ${cancelledWithThreads.length} with a thread closed.`);
  }
  await interaction.editReply(lines.join('\n'));

  await logToOrganizers(ctx.alert, interaction.guildId!, [`📋 **${interaction.user.username}**:`, ...lines].join('\n'));
  await ctx.playerNotification.tournamentCancelled(interaction.guildId!, result.tournament.name);
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

  const threads = await provisionReadyThreads(ctx.prisma, ctx.matchChannel, ctx.playerNotification, tournament.id, result.tournament.name);

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
