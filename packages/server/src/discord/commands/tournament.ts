import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type AutocompleteInteraction, type ChatInputCommandInteraction } from 'discord.js';
import type { PrismaClient, Guild as GuildRow, Tournament } from '@prisma/client';
import { FORMAT_LABEL, plural, sectionLabel, type BracketShape, type BracketSide, type FormatKey, type MatchRef } from '@itg/shared';
import { buildMatchLabel } from '../../services/run-view-service.js';
import { startTournamentWithDiscordEffects } from '../start-tournament-effects.js';
import {
  cancelTournament,
  closeCheckin,
  closeRegistration,
  createTournament,
  findActiveTournament,
  MixedFormatConflictError,
  openCheckin,
  openRegistration,
  renameTournament,
  setMatchFormats,
  setTournamentFormat,
  TournamentSlotOccupiedError,
  TournamentTransitionError,
} from '../../services/tournament-service.js';
import { linkifyTournamentName, tournamentUrl } from '../../web-url.js';
import { Action } from '../actions.js';
import { encodeTournamentCustomId } from '../custom-id.js';
import { LOG_COLOR } from '../render/draw.js';
import { requireOrganizerTier } from './authz.js';
import type { CommandContext } from './context.js';
import { logToOrganizers } from './organizer-log.js';
import { PHASE_LABEL } from './registration.js';

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
    await interaction.reply({ ephemeral: true, content: 'No tournament to act on. Run `/tournament create` first.' });
    return;
  }

  switch (sub) {
    case 'open-registration':
      return runTransition(
        interaction,
        ctx,
        () => openRegistration(ctx.prisma, tournament.id, interaction.user.id),
        (t) => `Registration is open for **${t.name}**. \`/join\` now works.`,
        (t) => ctx.playerNotification.registrationOpened(interaction.guildId!, t.id, t.name),
        LOG_COLOR.REGISTRATION_OPEN,
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
        (t) => `Check-in is closed for **${t.name}**.`,
        (t) => ctx.playerNotification.checkinClosed(interaction.guildId!, t.id, t.name),
        LOG_COLOR.CHECKIN_CLOSED,
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
    case 'format':
      return handleFormat(interaction, ctx, tournament);
    default:
      await interaction.reply({ ephemeral: true, content: "This command isn't available yet." });
  }
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
    await interaction.reply({ ephemeral: true, content: 'No tournament in this server right now.' });
    return;
  }

  const lines = [`**${tournament.name}**: ${PHASE_LABEL[tournament.state]}.`];
  switch (tournament.state) {
    case 'REGISTRATION_OPEN':
      lines.push('`/join` to register, or `/leave` if you change your mind.');
      break;
    case 'CHECKIN_OPEN':
      lines.push("`/checkin` to confirm you're playing, or `/leave` if you can't make it.");
      break;
    case 'CHECKIN_CLOSED':
      lines.push('The tournament is about to start.');
      break;
  }
  await interaction.reply({ ephemeral: true, content: lines.join('\n') });
}

/**
 * `/tournament format` — sets the tournament's default ruleset, or (with
 * `target`) a single round or match instead. Not `runTransition`: the
 * no-`target` path can fail with `MixedFormatConflictError`, which needs a
 * three-button reply rather than a plain "can't do that."
 */
async function handleFormat(interaction: ChatInputCommandInteraction, ctx: CommandContext, tournament: Tournament): Promise<void> {
  const formatKey = interaction.options.getString('format', true) as FormatKey;
  const target = interaction.options.getString('target');

  await interaction.deferReply({ ephemeral: true });

  if (!target) {
    try {
      const t = await setTournamentFormat(ctx.prisma, tournament.id, formatKey, interaction.user.id);
      const description = `Format set to **${FORMAT_LABEL[formatKey]}**.`;
      await interaction.editReply(description);
      await logToOrganizers(ctx.alert, interaction.guildId!, `📋 **${interaction.user.username}**: ${linkifyTournamentName(description, t.name, t.id)}`);
      ctx.realtime.publishLifecycleChanged(t.id);
    } catch (err) {
      if (err instanceof MixedFormatConflictError) {
        await interaction.editReply({
          content: formatConflictContent(err.breakdown, formatKey),
          components: [buildFormatConflictRow(tournament.id, formatKey)],
        });
        return;
      }
      if (err instanceof TournamentTransitionError) {
        await interaction.editReply(`Can't do that: ${err.reason}`);
        return;
      }
      throw err;
    }
    return;
  }

  const refs = await resolveFormatTarget(ctx.prisma, tournament.id, target);
  if (!refs) {
    await interaction.editReply("Couldn't find that round or match — generate the bracket first, or pick again from the list.");
    return;
  }

  try {
    await setMatchFormats(ctx.prisma, tournament.id, refs, formatKey, interaction.user.id);
    const description = `Set ${plural(refs.length, 'match', 'matches')} to **${FORMAT_LABEL[formatKey]}**.`;
    await interaction.editReply(description);
    await logToOrganizers(ctx.alert, interaction.guildId!, `📋 **${interaction.user.username}**: ${linkifyTournamentName(description, tournament.name, tournament.id)}`);
    ctx.realtime.publishLifecycleChanged(tournament.id);
  } catch (err) {
    if (err instanceof TournamentTransitionError) {
      await interaction.editReply(`Can't do that: ${err.reason}`);
      return;
    }
    throw err;
  }
}

/** `target` is `round:<BRACKET>:<round>` or `match:<matchId>`, whichever autocomplete choice the TO picked — see `handleFormatAutocomplete`. `null` means it no longer resolves (the bracket was regenerated since the choice was offered). */
async function resolveFormatTarget(prisma: PrismaClient, tournamentId: string, target: string): Promise<MatchRef[] | null> {
  if (target.startsWith('round:')) {
    const [, bracket, roundStr] = target.split(':');
    const round = Number(roundStr);
    if (!bracket || !Number.isFinite(round)) return null;
    const matches = await prisma.match.findMany({ where: { tournamentId, bracket: bracket as BracketSide, round } });
    return matches.length > 0 ? matches.map((m) => ({ bracket: m.bracket, round: m.round, slot: m.slot })) : null;
  }
  if (target.startsWith('match:')) {
    const match = await prisma.match.findUnique({ where: { id: target.slice('match:'.length) } });
    return match && match.tournamentId === tournamentId ? [{ bracket: match.bracket, round: match.round, slot: match.slot }] : null;
  }
  return null;
}

/**
 * `target`'s autocomplete: every round first (one choice per distinct
 * `(bracket, round)`, named the same way the bracket page's headings are —
 * "Winners Finals," not "Winners Round 4"), then every individual match,
 * labeled `buildMatchLabel`'s "Round · Alice vs Bob" (degrading to "· ? vs
 * ?" for anything not yet seated, which is the normal case past round 1).
 * `[]` before a bracket has been generated — there is nothing to target yet.
 */
export async function handleFormatAutocomplete(interaction: AutocompleteInteraction, ctx: CommandContext): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.respond([]);
    return;
  }
  const tournament = await findActiveTournament(ctx.prisma, interaction.guildId!);
  if (!tournament) {
    await interaction.respond([]);
    return;
  }

  const matches = await ctx.prisma.match.findMany({
    where: { tournamentId: tournament.id },
    include: { participants: { include: { entrant: true } } },
    orderBy: [{ bracket: 'asc' }, { round: 'asc' }, { slot: 'asc' }],
  });
  if (matches.length === 0) {
    await interaction.respond([]);
    return;
  }

  const shape: BracketShape = {
    winnersRounds: Math.max(0, ...matches.filter((m) => m.bracket === 'WINNERS').map((m) => m.round)),
    losersRounds: Math.max(0, ...matches.filter((m) => m.bracket === 'LOSERS').map((m) => m.round)),
  };

  const seenRounds = new Set<string>();
  const roundChoices: { name: string; value: string }[] = [];
  for (const m of matches) {
    const key = `${m.bracket}:${m.round}`;
    if (seenRounds.has(key)) continue;
    seenRounds.add(key);
    roundChoices.push({ name: sectionLabel(m.bracket, m.round, shape), value: `round:${m.bracket}:${m.round}` });
  }

  const matchChoices = matches.map((m) => ({ name: buildMatchLabel(m.bracket, m.round, m.participants), value: `match:${m.id}` }));

  const focused = interaction.options.getFocused().toLowerCase();
  const choices = [...roundChoices, ...matchChoices].filter((c) => c.name.toLowerCase().includes(focused)).slice(0, 25);
  await interaction.respond(choices);
}

function formatConflictContent(breakdown: Record<string, number>, formatKey: FormatKey): string {
  const lines = Object.entries(breakdown).map(([key, count]) => `• ${FORMAT_LABEL[key as FormatKey] ?? key}: ${count}`);
  return [`This tournament's matches aren't all on one format:`, ...lines, `How should setting the default to **${FORMAT_LABEL[formatKey]}** be handled?`].join('\n');
}

/** Update all / default only / cancel, per `setTournamentFormat`'s own comment on the three-way choice. Routed in `interactions.ts` via the `t1:` codec — see that file's comment on why this needs a second codec at all. */
function buildFormatConflictRow(tournamentId: string, formatKey: FormatKey): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeTournamentCustomId({ tournamentId, action: Action.FORMAT_UPDATE_ALL, arg: formatKey }))
      .setLabel('Update all matches')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(encodeTournamentCustomId({ tournamentId, action: Action.FORMAT_DEFAULT_ONLY, arg: formatKey }))
      .setLabel('Change default only')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(encodeTournamentCustomId({ tournamentId, action: Action.FORMAT_CANCEL }))
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  );
}

/** "If a tournament is created then that is the tournament the bot is now holding" — released only by `/tournament cancel` or reaching `COMPLETE`. */
async function handleCreate(interaction: ChatInputCommandInteraction, ctx: CommandContext): Promise<void> {
  const name = interaction.options.getString('name', true);
  try {
    const t = await createTournament(ctx.prisma, interaction.guildId!, name, interaction.user.id);
    const url = tournamentUrl(t.id);
    await interaction.reply({
      ephemeral: true,
      content: `Created **${t.name}** (draft): ${url}\nRun \`/tournament open-registration\` when you're ready for \`/join\` to start working.`,
    });
    // Alert-channel messages name the actor by their raw Discord username —
    // that channel is organizer-private, unlike the general channel, which
    // uses the server display name. See `player-notification-adapter.ts`.
    await logToOrganizers(ctx.alert, interaction.guildId!, `🆕 **${interaction.user.username}** created tournament [**${t.name}**](${url})`);
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
  /** Matches this transition's own public-facing announcement color, where one exists — e.g. registration-open's alert matches the general channel's green. `undefined` (close-registration, rename) leaves the alert uncolored, same as it always was. */
  color?: number,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  try {
    const t = await run();
    const description = describe(t);
    await interaction.editReply(description);
    await logToOrganizers(
      ctx.alert,
      interaction.guildId!,
      `📋 **${interaction.user.username}**: ${linkifyTournamentName(description, t.name, t.id)}`,
      { color },
    );
    ctx.realtime.publishLifecycleChanged(t.id);
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
  ctx.realtime.publishLifecycleChanged(opened.id);

  const lines = [`Check-in is open for **${opened.name}**. We notified registered players.`];
  if (unreachable.length > 0) lines.push(`⚠️ Could not DM: ${unreachable.map((id) => `<@${id}>`).join(', ')}.`);
  await interaction.editReply(lines.join('\n'));

  const logLines = [`📋 **${interaction.user.username}**: check-in is open for [**${opened.name}**](${tournamentUrl(opened.id)}).`];
  if (unreachable.length > 0) logLines.push(`⚠️ Could not DM: ${unreachable.map((id) => `<@${id}>`).join(', ')}.`);
  // Matches the "Tournament starting" DM's color — the general-channel post
  // for this event carries no color of its own to match instead.
  await logToOrganizers(ctx.alert, interaction.guildId!, logLines.join('\n'), { color: LOG_COLOR.TOURNAMENT_STARTING });
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
    await ctx.matchChannel.postLogMessage(ref, {
      embeds: [new EmbedBuilder().setColor(LOG_COLOR.TOURNAMENT_CANCELLED).setDescription('⚠️ This tournament is cancelled. This match won\'t continue.')],
    });
    // Replaces whatever was last — Protect/Veto, a score-submit button, a
    // tiebreak select, anything — with a plain, component-free message, so
    // there's no live prompt left to click. `postMatchState` edits the
    // current state message in place (or reposts) with exactly the
    // components given; omitting them here clears whatever was there.
    // Same color/shape as the log line just above — this is the same
    // event, restated as the closing state rather than a permanent entry.
    await ctx.matchChannel.postMatchState(ref, {
      embeds: [new EmbedBuilder().setColor(LOG_COLOR.TOURNAMENT_CANCELLED).setDescription('⚠️ This match is cancelled. Nothing else to do here.')],
    });
    await ctx.matchChannel.archiveThread(ref);
  }

  const lines = [`**${result.tournament.name}** is cancelled.`];
  if (result.cancelledMatchIds.length > 0) {
    lines.push(
      `⚠️ Cancelled ${plural(result.cancelledMatchIds.length, 'in-progress match', 'in-progress matches')}; closed ${cancelledWithThreads.length} threads.`,
    );
  }
  await interaction.editReply(lines.join('\n'));
  ctx.realtime.publishLifecycleChanged(result.tournament.id);

  const orgLines = [linkifyTournamentName(lines[0]!, result.tournament.name, result.tournament.id), ...lines.slice(1)];
  await logToOrganizers(ctx.alert, interaction.guildId!, [`📋 **${interaction.user.username}**:`, ...orgLines].join('\n'), {
    color: LOG_COLOR.GENERAL_TOURNAMENT_CANCELLED,
  });
  await ctx.playerNotification.tournamentCancelled(interaction.guildId!, result.tournament.id, result.tournament.name);
}

/**
 * `CHECKIN_CLOSED → RUNNING`. All the actual work — the permission
 * preflight, the display-name snapshot, `startTournament` itself, and
 * thread provisioning — lives in `startTournamentWithDiscordEffects`,
 * shared with the web console's Start button; this just formats the
 * outcome as an ephemeral reply, an organizer-alert line, and the general-
 * channel announcement.
 */
async function handleStart(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
  tournament: Tournament,
  guildRow: GuildRow,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const guild = interaction.guild!;

  const outcome = await startTournamentWithDiscordEffects(ctx, guild, guildRow, tournament.id, interaction.user.id);
  if (outcome.kind === 'BLOCKED') {
    await interaction.editReply(outcome.message);
    return;
  }
  if (outcome.kind === 'TRANSITION_ERROR') {
    await interaction.editReply(`Can't start: ${outcome.reason}`);
    return;
  }

  const lines = [`🏁 **${outcome.tournament.name}** has started. Created ${plural(outcome.threads.length, 'match thread', 'match threads')}.`];
  if (outcome.packSizeWarning) {
    lines.push(`⚠️ The chart pack has only ${plural(outcome.packSizeWarning.actual, 'chart', 'charts')}; we recommend ${outcome.packSizeWarning.recommended}+.`);
  }
  if (outcome.refereePoolEmpty) {
    lines.push('⚠️ Nobody holds a role at Referee tier or above yet, so a dispute has nobody to rule on it.');
  }
  if (outcome.holdsTierRole.length > 0) {
    lines.push(`⚠️ These entrants also hold a tier role: ${outcome.holdsTierRole.join(', ')}.`);
  }
  await interaction.editReply(lines.join('\n'));

  const orgLines = [linkifyTournamentName(lines[0]!, outcome.tournament.name, outcome.tournament.id), ...lines.slice(1)];
  await logToOrganizers(ctx.alert, interaction.guildId!, [`📋 **${interaction.user.username}**:`, ...orgLines].join('\n'), {
    color: LOG_COLOR.TOURNAMENT_STARTED,
  });
  await ctx.playerNotification.tournamentStarted(interaction.guildId!, outcome.tournament.id, outcome.tournament.name);
  ctx.realtime.publishLifecycleChanged(outcome.tournament.id);
  // Starting drops no-shows and collapses seeds — a real roster change a
  // seeding page held open elsewhere needs to hear about, the same
  // broadcast the web console's own Start button already makes.
  ctx.realtime.publishRosterChanged(outcome.tournament.id);
}
