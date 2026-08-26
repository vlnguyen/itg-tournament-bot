import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  OverwriteType,
  PermissionFlagsBits,
  type ButtonInteraction,
  type CategoryChannel,
  type ChatInputCommandInteraction,
  type Guild as DiscordGuild,
  type Message,
  type PermissionsString,
  type TextChannel,
} from 'discord.js';
import type { Guild as GuildRow } from '@prisma/client';
import { logAction } from '../../services/audit-log.js';
import {
  diagnoseBotInChannel,
  diagnoseTierRoleInChannel,
  isRepairable,
  REQUIRED_BOT_PERMS,
  REQUIRED_TIER_ROLE_PERMS,
  type ChannelGap,
} from '../setup-diagnostic.js';
import { describeGap } from '../permission-diagnostic.js';
import { refereeTierRoleIds, type TierRoleConfig } from '../tier.js';
import type { CommandContext } from './context.js';

export type ChannelSlot = 'matches' | 'alerts' | 'results' | 'general';

const EMPTY_TIER_CONFIG: TierRoleConfig = { refereeRoleId: null, toRoleId: null, adminRoleId: null };

/**
 * `/setup` is gated on Manage Guild alone — there is no separate
 * bot-tracked Server Administrator role to configure or fall back to.
 * "There is always one implied administrator through the server owner":
 * whoever holds Manage Guild (the owner, at minimum) is the administrator,
 * full stop, which is also why this has to work on a guild with no
 * `Guild` row yet at all — it's the bootstrap route. See DESIGN.md,
 * "Bootstrap".
 */
function canRunSetup(interaction: ChatInputCommandInteraction): boolean {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
}

export async function handleSetup(interaction: ChatInputCommandInteraction, ctx: CommandContext): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({ ephemeral: true, content: 'This only works inside a server.' });
    return;
  }

  if (!canRunSetup(interaction)) {
    await interaction.reply({
      ephemeral: true,
      content: 'You need **Manage Server** to run `/setup`.',
    });
    return;
  }

  const guildRow = await ctx.prisma.guild.findUnique({ where: { id: interaction.guildId! } });

  const sub = interaction.options.getSubcommand();
  if (sub === 'channels') return handleChannels(interaction, ctx, guildRow);
  if (sub === 'roles') return handleRoles(interaction, ctx, guildRow);

  // 'status' — the diagnostic itself (channel fetches, a full member fetch
  // for the referee-pool check) can easily blow the three-second ack
  // window, so defer before running it rather than after.
  await interaction.deferReply({ ephemeral: true });
  await postDiagnostic(interaction, ctx, guildRow, {});
}

// ---------------------------------------------------------------------------
// /setup channels
// ---------------------------------------------------------------------------

const OVERWRITE_TABLE: Record<
  Exclude<ChannelSlot, 'general'>,
  { everyoneAllow: PermissionsString[]; everyoneDeny: PermissionsString[]; tierAllow: PermissionsString[] }
> = {
  // #matches and #results are read-only for @everyone — the channel body,
  // not the private threads under #matches, which are a separate
  // permission (`SendMessagesInThreads`) untouched by denying `SendMessages`
  // here. @everyone also can't start a thread of either kind on either
  // channel: only the bot creates threads under #matches, and #results is a
  // conversation-free log — a member-started thread there would be exactly
  // the "chat in the results channel" DESIGN.md calls out as something
  // provisioning should prevent, not ask nicely about.
  matches: {
    everyoneAllow: ['ViewChannel'],
    everyoneDeny: ['SendMessages', 'CreatePublicThreads', 'CreatePrivateThreads'],
    tierAllow: ['ViewChannel', 'ManageThreads'],
  },
  alerts: { everyoneAllow: [], everyoneDeny: ['ViewChannel'], tierAllow: ['ViewChannel', 'ReadMessageHistory'] },
  results: {
    everyoneAllow: ['ViewChannel', 'AddReactions'],
    everyoneDeny: ['SendMessages', 'CreatePublicThreads', 'CreatePrivateThreads'],
    tierAllow: [],
  },
};

const CHANNEL_NAMES: Record<ChannelSlot, string> = {
  matches: 'matches',
  alerts: 'organizer-alerts',
  results: 'results',
  general: 'general',
};

const TOURNAMENT_CATEGORY_NAME = 'Tournament';

/** Reuses an existing "Tournament" category if one is already there, rather than creating a duplicate on every `/setup channels` re-run. */
async function findOrCreateTournamentCategory(guild: DiscordGuild): Promise<CategoryChannel> {
  const existing = guild.channels.cache.find(
    (c): c is CategoryChannel => c.type === ChannelType.GuildCategory && c.name === TOURNAMENT_CATEGORY_NAME,
  );
  if (existing) return existing;
  return guild.channels.create({ name: TOURNAMENT_CATEGORY_NAME, type: ChannelType.GuildCategory });
}

/** Correct by construction, per DESIGN.md's overwrite table — never for the `general` slot, which is never created. */
async function createManagedChannel(
  guild: DiscordGuild,
  slot: Exclude<ChannelSlot, 'general'>,
  tierRoleIds: readonly string[],
  botId: string,
  categoryId: string,
): Promise<TextChannel> {
  const table = OVERWRITE_TABLE[slot];
  const overwrites = [
    { id: guild.id, type: OverwriteType.Role, allow: table.everyoneAllow, deny: table.everyoneDeny },
    ...tierRoleIds.map((id) => ({ id, type: OverwriteType.Role, allow: table.tierAllow, deny: [] })),
    { id: botId, type: OverwriteType.Member, allow: REQUIRED_BOT_PERMS[slot], deny: [] },
  ];
  return guild.channels.create({
    name: CHANNEL_NAMES[slot],
    type: ChannelType.GuildText,
    parent: categoryId,
    permissionOverwrites: overwrites,
  });
}

async function handleChannels(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
  guildRow: GuildRow | null,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const guild = interaction.guild!;
  const given = {
    matches: interaction.options.getChannel('matches'),
    alerts: interaction.options.getChannel('alerts'),
    results: interaction.options.getChannel('results'),
    general: interaction.options.getChannel('general'),
  };

  const tierRoleIds = refereeTierRoleIds(guildRow ?? EMPTY_TIER_CONFIG);
  const botId = ctx.client.user!.id;
  const notes: string[] = [];

  const resolved: Record<ChannelSlot, string | null> = {
    matches: guildRow?.matchesChannelId ?? null,
    alerts: guildRow?.alertChannelId ?? null,
    results: guildRow?.resultsChannelId ?? null,
    general: guildRow?.generalChannelId ?? null,
  };

  // A channel id already on file might point at something Discord no
  // longer has — deleted since it was configured. That's equivalent to
  // never having been set: it should fall through to "point at what was
  // given, or create fresh" below, not be silently kept as "unchanged."
  for (const slot of ['matches', 'alerts', 'results', 'general'] as const) {
    if (resolved[slot] && !(await fetchTextChannel(guild, resolved[slot]))) {
      resolved[slot] = null;
    }
  }

  const needsCreation = (['matches', 'alerts', 'results'] as const).some((slot) => !given[slot] && !resolved[slot]);
  let categoryId: string | null = null;
  let categoryError: string | null = null;
  if (needsCreation) {
    try {
      categoryId = (await findOrCreateTournamentCategory(guild)).id;
    } catch (err) {
      categoryError = (err as Error).message;
    }
  }

  for (const slot of ['matches', 'alerts', 'results'] as const) {
    const pick = given[slot];
    if (pick) {
      resolved[slot] = pick.id;
      notes.push(`Pointed at <#${pick.id}> for ${slot}.`);
      continue;
    }
    if (resolved[slot]) continue; // already configured, not being changed
    if (categoryError) {
      notes.push(`Couldn't create a ${slot} channel (no "${TOURNAMENT_CATEGORY_NAME}" category: ${categoryError}) — create one yourself and re-run \`/setup channels\` pointing at it.`);
      continue;
    }
    try {
      const created = await createManagedChannel(guild, slot, tierRoleIds, botId, categoryId!);
      resolved[slot] = created.id;
      notes.push(`Created <#${created.id}> for ${slot}.`);
    } catch (err) {
      notes.push(`Couldn't create a ${slot} channel (${(err as Error).message}) — create one yourself and re-run \`/setup channels\` pointing at it.`);
    }
  }
  if (given.general) {
    resolved.general = given.general.id;
    notes.push(`Pointed at <#${given.general.id}> for general.`);
  }

  await ctx.prisma.guild.upsert({
    where: { id: guild.id },
    create: {
      id: guild.id,
      matchesChannelId: resolved.matches,
      alertChannelId: resolved.alerts,
      resultsChannelId: resolved.results,
      generalChannelId: resolved.general,
    },
    update: {
      matchesChannelId: resolved.matches,
      alertChannelId: resolved.alerts,
      resultsChannelId: resolved.results,
      generalChannelId: resolved.general,
    },
  });
  await logAction(ctx.prisma, interaction.user.id, 'SETUP_CHANNELS', 'Guild', guild.id, resolved);

  const updatedRow = await ctx.prisma.guild.findUniqueOrThrow({ where: { id: guild.id } });
  await postDiagnostic(interaction, ctx, updatedRow, { preface: notes.join('\n') });
}

// ---------------------------------------------------------------------------
// /setup roles
// ---------------------------------------------------------------------------

// Server Administrator is deliberately absent from this whole subcommand —
// "there is always one implied administrator through the server owner,"
// via Manage Guild, so there is nothing for `/setup roles` to bind or
// create for that tier. See DESIGN.md, "Provisioning the roles".
type TierRoleSlot = 'referee' | 'organizer';

const TIER_ROLE_LABELS: Record<TierRoleSlot, string> = {
  referee: 'Referee',
  organizer: 'Tournament Organizer',
};

/**
 * Mentionable, so the bot's own escalation mentions actually ping — Discord's
 * `mentionable` flag otherwise silences a role mention from anyone without
 * "Mention @everyone/roles". No color/hoist opinion; DESIGN.md has none,
 * and that's cosmetic for an administrator to set themselves.
 */
async function createTierRole(guild: DiscordGuild, slot: TierRoleSlot) {
  return guild.roles.create({ name: TIER_ROLE_LABELS[slot], mentionable: true });
}

async function handleRoles(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
  guildRow: GuildRow | null,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const guild = interaction.guild!;
  const given = {
    referee: interaction.options.getRole('referee'),
    organizer: interaction.options.getRole('organizer'),
  };

  const resolved: Record<TierRoleSlot, string | null> = {
    referee: guildRow?.refereeRoleId ?? null,
    organizer: guildRow?.toRoleId ?? null,
  };

  // A bound role Discord no longer has — deleted since it was configured —
  // is equivalent to never having been set, same reasoning as a deleted
  // channel in `/setup channels`.
  for (const slot of ['referee', 'organizer'] as const) {
    if (resolved[slot] && !(await guild.roles.fetch(resolved[slot]).catch(() => null))) {
      resolved[slot] = null;
    }
  }

  const notes: string[] = [];
  for (const slot of ['referee', 'organizer'] as const) {
    const pick = given[slot];
    if (pick) {
      resolved[slot] = pick.id;
      notes.push(`${TIER_ROLE_LABELS[slot]} tier → **${pick.name}**.`);
      continue;
    }
    if (resolved[slot]) continue; // already configured, not being changed
    try {
      const created = await createTierRole(guild, slot);
      resolved[slot] = created.id;
      notes.push(`Created role **${created.name}** for ${TIER_ROLE_LABELS[slot]} tier.`);
    } catch (err) {
      notes.push(`Couldn't create a ${TIER_ROLE_LABELS[slot]} role (${(err as Error).message}) — create one yourself and re-run \`/setup roles\` pointing at it.`);
    }
  }

  await ctx.prisma.guild.upsert({
    where: { id: guild.id },
    create: {
      id: guild.id,
      refereeRoleId: resolved.referee,
      toRoleId: resolved.organizer,
    },
    update: {
      refereeRoleId: resolved.referee,
      toRoleId: resolved.organizer,
    },
  });
  await logAction(ctx.prisma, interaction.user.id, 'SETUP_ROLES', 'Guild', guild.id, resolved);

  const updatedRow = await ctx.prisma.guild.findUniqueOrThrow({ where: { id: guild.id } });
  await postDiagnostic(interaction, ctx, updatedRow, { preface: notes.join('\n') });
}

// ---------------------------------------------------------------------------
// The diagnostic itself, shared by all three subcommands
// ---------------------------------------------------------------------------

async function fetchTextChannel(guild: DiscordGuild, id: string | null): Promise<TextChannel | null> {
  if (!id) return null;
  const channel = await guild.channels.fetch(id).catch(() => null);
  return channel && channel.type === ChannelType.GuildText ? channel : null;
}

export type RequiredTierRole = 'referee' | 'organizer';

const REQUIRED_TIER_ROLE_LABELS: Record<RequiredTierRole, string> = {
  referee: 'Referee',
  organizer: 'Tournament Organizer',
};

/**
 * Also the permission-preflight `/tournament start` blocks on — see
 * `tournament.ts`. Reused rather than reimplemented so there is one
 * computation of "what's missing" for both surfaces.
 */
export async function runFullDiagnostic(
  ctx: CommandContext,
  guild: DiscordGuild,
  guildRow: GuildRow,
): Promise<{
  gaps: ChannelGap[];
  refereePoolEmpty: boolean;
  missingChannels: ChannelSlot[];
  missingTierRoles: RequiredTierRole[];
  deletedTierRoles: RequiredTierRole[];
}> {
  const botMember = guild.members.me ?? (await guild.members.fetchMe());
  const gaps: ChannelGap[] = [];
  const missingChannels: ChannelSlot[] = [];

  // Referee and Tournament Organizer are load-bearing, not optional: with
  // no TO role bound, not one `/tournament` lifecycle command is reachable
  // by anyone; with no referee role, a disagreement has nobody to escalate
  // to. Both are required here, unlike Server Administrator, which
  // `/setup` itself can always fall back to Manage Guild for.
  const missingTierRoles: RequiredTierRole[] = [];
  if (!guildRow.refereeRoleId) missingTierRoles.push('referee');
  if (!guildRow.toRoleId) missingTierRoles.push('organizer');

  // Bound, but Discord doesn't have it anymore — deleted since it was
  // configured. Same "equivalent to unconfigured" reasoning as a deleted
  // channel, but reported separately from `missingTierRoles` above: this
  // one says "re-run /setup roles to replace it," not "bind one for the
  // first time."
  const deletedTierRoles: RequiredTierRole[] = [];
  const boundTierRoles: [RequiredTierRole, string | null][] = [
    ['referee', guildRow.refereeRoleId],
    ['organizer', guildRow.toRoleId],
  ];
  for (const [role, id] of boundTierRoles) {
    if (id && !(await guild.roles.fetch(id).catch(() => null))) {
      deletedTierRoles.push(role);
    }
  }

  const channels: [ChannelSlot, string | null][] = [
    ['matches', guildRow.matchesChannelId],
    ['alerts', guildRow.alertChannelId],
    ['results', guildRow.resultsChannelId],
    ['general', guildRow.generalChannelId],
  ];

  for (const [slot, id] of channels) {
    if (!id) continue; // not configured at all — nothing to check
    const channel = await fetchTextChannel(guild, id);
    if (!channel) {
      // Configured, but Discord doesn't have it anymore — deleted, or no
      // longer a text channel. Silently skipping this would make a broken
      // pointer indistinguishable from "nothing missing here."
      missingChannels.push(slot);
      continue;
    }
    gaps.push(...diagnoseBotInChannel(botMember, channel, REQUIRED_BOT_PERMS[slot]));
  }

  // Both the matches channel (thread visibility) and the alerts channel
  // (reading the queue an escalation mention just pinged them into) gate
  // something a tier role actually needs — see REQUIRED_TIER_ROLE_PERMS.
  const tierCheckedChannels: [Exclude<ChannelSlot, 'results' | 'general'>, string | null][] = [
    ['matches', guildRow.matchesChannelId],
    ['alerts', guildRow.alertChannelId],
  ];
  for (const [slot, id] of tierCheckedChannels) {
    const channel = await fetchTextChannel(guild, id);
    if (!channel) continue;
    for (const roleId of refereeTierRoleIds(guildRow)) {
      const role = await guild.roles.fetch(roleId).catch(() => null);
      if (!role) continue;
      gaps.push(...diagnoseTierRoleInChannel(guild, role, channel, REQUIRED_TIER_ROLE_PERMS[slot]));
    }
  }

  // Tiers are cumulative — a Tournament Organizer or Server Administrator
  // can rule on a match too, so "is there anyone who could resolve a
  // dispute" is the union of everyone at Referee tier or above, not just
  // the referee role's own membership. `refereeTierRoleIds` is the same
  // "distinct roles at Referee tier or above" helper the escalation
  // mention already uses. If no tier role is configured at all,
  // `missingTierRoles` above already reports that more specifically, so
  // this stays false rather than doubling up on the same gap.
  let refereePoolEmpty = false;
  const tierRoleIds = refereeTierRoleIds(guildRow);
  if (tierRoleIds.length > 0) {
    await guild.members.fetch().catch(() => undefined);
    const pool = new Set<string>();
    for (const roleId of tierRoleIds) {
      const role = await guild.roles.fetch(roleId).catch(() => null);
      role?.members.forEach((m) => pool.add(m.id));
    }
    refereePoolEmpty = pool.size === 0;
  }

  return { gaps, refereePoolEmpty, missingChannels, missingTierRoles, deletedTierRoles };
}

function channelLabelFor(slot: ChannelSlot | undefined, guildRow: GuildRow | null): string {
  const id =
    !guildRow ? null
    : slot === 'matches' ? guildRow.matchesChannelId
    : slot === 'alerts' ? guildRow.alertChannelId
    : slot === 'results' ? guildRow.resultsChannelId
    : slot === 'general' ? guildRow.generalChannelId
    : null;
  return id ? `<#${id}>` : 'that channel';
}

function slotOfChannelId(id: string, guildRow: GuildRow | null): ChannelSlot | undefined {
  if (!guildRow) return undefined;
  if (id === guildRow.matchesChannelId) return 'matches';
  if (id === guildRow.alertChannelId) return 'alerts';
  if (id === guildRow.resultsChannelId) return 'results';
  if (id === guildRow.generalChannelId) return 'general';
  return undefined;
}

function bindingLine(label: string, mention: string | null): string {
  return `${label}: ${mention ?? '*not configured*'}`;
}

/** Always shown, success or not — DESIGN.md's diagnostic names gaps, but a clean report with no bindings visible at all is not actually reassuring. */
function renderBindingsField(guildRow: GuildRow | null): { name: string; value: string } {
  const channel = (id: string | null | undefined) => (id ? `<#${id}>` : null);
  const role = (id: string | null | undefined) => (id ? `<@&${id}>` : null);
  const lines = [
    bindingLine('Matches', channel(guildRow?.matchesChannelId)),
    bindingLine('Organizer alerts', channel(guildRow?.alertChannelId)),
    bindingLine('Results', channel(guildRow?.resultsChannelId)),
    bindingLine('General', channel(guildRow?.generalChannelId)),
    bindingLine('Referee', role(guildRow?.refereeRoleId)),
    bindingLine('Tournament Organizer', role(guildRow?.toRoleId)),
  ];
  return { name: 'Current bindings', value: lines.join('\n') };
}

function renderDiagnosticEmbed(
  gaps: ChannelGap[],
  refereePoolEmpty: boolean,
  missingChannels: ChannelSlot[],
  missingTierRoles: RequiredTierRole[],
  deletedTierRoles: RequiredTierRole[],
  guildRow: GuildRow | null,
  preface?: string,
): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle('Setup diagnostic');
  const lines: string[] = [];
  if (preface) lines.push(preface, '');

  const configured = guildRow?.matchesChannelId || guildRow?.alertChannelId || guildRow?.resultsChannelId;
  if (!configured) lines.push('No channels configured yet — run `/setup channels`.');

  for (const role of missingTierRoles) {
    lines.push(`- ❌ The ${REQUIRED_TIER_ROLE_LABELS[role]} role is not configured — run \`/setup roles ${role}:<role>\`.`);
  }

  for (const role of deletedTierRoles) {
    lines.push(`- ⚠️ The configured ${REQUIRED_TIER_ROLE_LABELS[role]} role no longer exists — re-run \`/setup roles\` to point at a replacement.`);
  }

  for (const slot of missingChannels) {
    lines.push(`- ⚠️ The configured ${slot} channel no longer exists — re-run \`/setup channels\` to point at a replacement.`);
  }

  const clean =
    gaps.length === 0 &&
    missingChannels.length === 0 &&
    missingTierRoles.length === 0 &&
    deletedTierRoles.length === 0 &&
    configured;
  if (clean) {
    lines.push('✅ Everything required is in place.');
  } else {
    for (const gap of gaps) {
      const channelLabel = channelLabelFor(slotOfChannelId(gap.channelId, guildRow), guildRow);
      lines.push(`- ${describeGap({ permission: gap.permission, layer: gap.layer }, gap.targetLabel, channelLabel)}`);
    }
  }

  if (refereePoolEmpty) {
    lines.push('', '⚠️ Nobody holds a role at Referee tier or above — a dispute has nobody to rule on it yet.');
  }

  embed.setDescription(lines.join('\n') || 'Nothing to report.');
  embed.addFields(renderBindingsField(guildRow));
  return embed;
}

interface DiagnosticOptions {
  preface?: string;
}

/**
 * Posts the diagnostic and attaches "Re-check" (always) and "Repair" (only
 * when a repairable gap exists) — DESIGN.md's "fix-in-Discord → click →
 * see what remains, without retyping." Both buttons are handled with a
 * short-lived `awaitMessageComponent` scoped to this one ephemeral reply,
 * not the stateless custom_id system match-thread buttons use — there is
 * no restart-survival requirement for a one-shot setup wizard.
 *
 * Always called with the interaction already deferred or replied to —
 * every entry point (`/setup channels`, `/setup roles`, `/setup status`,
 * and the Re-check/Repair buttons themselves) defers first, since the
 * diagnostic's own Discord calls can run past the three-second ack window.
 */
async function postDiagnostic(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
  guildRow: GuildRow | null,
  options: DiagnosticOptions,
): Promise<void> {
  const guild = interaction.guild!;
  const row = guildRow ?? (await ctx.prisma.guild.findUnique({ where: { id: guild.id } }));

  const { gaps, refereePoolEmpty, missingChannels, missingTierRoles, deletedTierRoles } = row
    ? await runFullDiagnostic(ctx, guild, row)
    : {
        gaps: [] as ChannelGap[],
        refereePoolEmpty: false,
        missingChannels: [] as ChannelSlot[],
        missingTierRoles: ['referee', 'organizer'] as RequiredTierRole[],
        deletedTierRoles: [] as RequiredTierRole[],
      };

  const embed = renderDiagnosticEmbed(
    gaps,
    refereePoolEmpty,
    missingChannels,
    missingTierRoles,
    deletedTierRoles,
    row,
    options.preface,
  );
  const repairable = gaps.filter(isRepairable);
  const components = buildDiagnosticButtons(repairable.length > 0);

  const message = await interaction.editReply({ embeds: [embed], components });

  await awaitDiagnosticAction(interaction, ctx, guild, row, message, repairable);
}

function buildDiagnosticButtons(hasRepair: boolean): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('setup:recheck').setLabel('Re-check').setStyle(ButtonStyle.Secondary),
  );
  if (hasRepair) {
    row.addComponents(new ButtonBuilder().setCustomId('setup:repair').setLabel('Repair').setStyle(ButtonStyle.Primary));
  }
  return [row];
}

async function awaitDiagnosticAction(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
  guild: DiscordGuild,
  guildRow: GuildRow | null,
  message: Message,
  repairable: ChannelGap[],
): Promise<void> {
  let clicked: ButtonInteraction;
  try {
    clicked = (await message.awaitMessageComponent({
      filter: (i) => i.user.id === interaction.user.id,
      time: 120_000,
    })) as ButtonInteraction;
  } catch {
    return; // timed out — leave the last render as-is
  }

  if (clicked.customId === 'setup:recheck') {
    await clicked.deferUpdate();
    await postDiagnostic(interaction, ctx, guildRow, {});
    return;
  }

  // setup:repair
  await clicked.deferUpdate();
  const results = await applyRepairs(guild, repairable);
  await logAction(ctx.prisma, interaction.user.id, 'SETUP_REPAIR', 'Guild', guild.id, {
    attempted: repairable.length,
    failed: results.failed,
  });
  const preface =
    results.failed.length === 0
      ? `Repaired ${results.succeeded} overwrite(s).`
      : `Repaired ${results.succeeded} overwrite(s); couldn't repair: ${results.failed.join('; ')}.`;
  await postDiagnostic(interaction, ctx, guildRow, { preface });
}

/** Groups repairable gaps by (channel, target) and applies one merged overwrite edit each — bounded by whatever the bot can actually touch; a 50013 here means the ceiling DESIGN.md flags as an open question. */
async function applyRepairs(
  guild: DiscordGuild,
  gaps: ChannelGap[],
): Promise<{ succeeded: number; failed: string[] }> {
  const byTarget = new Map<
    string,
    { channelId: string; targetId: string; type: OverwriteType; label: string; perms: Set<string> }
  >();
  for (const gap of gaps) {
    const isBot = gap.roleId === null;
    const targetId = gap.roleId ?? guild.client.user!.id;
    const key = `${gap.channelId}:${targetId}`;
    const entry =
      byTarget.get(key) ??
      { channelId: gap.channelId, targetId, type: isBot ? OverwriteType.Member : OverwriteType.Role, label: gap.targetLabel, perms: new Set<string>() };
    entry.perms.add(gap.permission);
    byTarget.set(key, entry);
  }

  let succeeded = 0;
  const failed: string[] = [];
  for (const { channelId, targetId, type, label, perms } of byTarget.values()) {
    try {
      const channel = await guild.channels.fetch(channelId);
      if (!channel || channel.type !== ChannelType.GuildText) throw new Error('channel is gone or not text');
      const allow = Object.fromEntries([...perms].map((p) => [p, true]));
      await channel.permissionOverwrites.edit(targetId, allow, { type });
      succeeded += perms.size;
    } catch (err) {
      failed.push(`${label} in <#${channelId}> (${(err as Error).message})`);
    }
  }
  return { succeeded, failed };
}
