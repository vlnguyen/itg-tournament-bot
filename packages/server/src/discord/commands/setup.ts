import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild as DiscordGuild,
  type Message,
  type TextChannel,
} from 'discord.js';
import type { Guild as GuildRow } from '@prisma/client';
import type { ChannelSlot, TierRoleSlot } from '@itg/shared';
import { logAction } from '../../services/audit-log.js';
import { isRepairable, type ChannelGap } from '../setup-diagnostic.js';
import { describeGap } from '../permission-diagnostic.js';
import { refereeTierRoleIds } from '../tier.js';
import {
  applyRepairs,
  EMPTY_TIER_CONFIG,
  fetchTextChannel,
  resolveChannelSetup,
  resolveRoleSetup,
  runFullDiagnostic,
  TIER_ROLE_LABELS,
  type ChannelPick,
} from '../setup-effects.js';
import type { CommandContext } from './context.js';

function currentChannelId(guildRow: GuildRow | null, slot: Exclude<ChannelSlot, 'general'>): string | null {
  if (!guildRow) return null;
  if (slot === 'matches') return guildRow.matchesChannelId;
  if (slot === 'alerts') return guildRow.alertChannelId;
  return guildRow.resultsChannelId;
}

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

async function handleChannels(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
  guildRow: GuildRow | null,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const guild = interaction.guild!;
  // `/setup channels`' own bootstrap default — bare invocation, nothing
  // configured yet, creates everything — lives here, not in
  // `resolveChannelSetup`: an explicit `'CREATE'` is synthesized only when
  // nothing was picked *and* nothing currently resolves (unconfigured, or
  // configured but deleted). The console never does this — see
  // `resolveChannelSetup`'s comment.
  const given: Partial<Record<ChannelSlot, ChannelPick>> = {};
  for (const slot of ['matches', 'alerts', 'results'] as const) {
    const picked = interaction.options.getChannel(slot)?.id;
    if (picked) {
      given[slot] = picked;
      continue;
    }
    const existing = currentChannelId(guildRow, slot);
    if (!existing || !(await fetchTextChannel(guild, existing))) given[slot] = 'CREATE';
  }
  const generalPick = interaction.options.getChannel('general')?.id;
  if (generalPick) given.general = generalPick;

  const tierRoleIds = refereeTierRoleIds(guildRow ?? EMPTY_TIER_CONFIG);
  const botId = ctx.client.user!.id;
  const { resolved, notes } = await resolveChannelSetup(guild, guildRow, given, tierRoleIds, botId);

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

async function handleRoles(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
  guildRow: GuildRow | null,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const guild = interaction.guild!;
  // Same bootstrap-default synthesis as `handleChannels` — see its comment.
  const given: Partial<Record<TierRoleSlot, ChannelPick>> = {};
  for (const slot of ['referee', 'organizer'] as const) {
    const picked = interaction.options.getRole(slot)?.id;
    if (picked) {
      given[slot] = picked;
      continue;
    }
    const existing = slot === 'referee' ? guildRow?.refereeRoleId : guildRow?.toRoleId;
    if (!existing || !(await guild.roles.fetch(existing).catch(() => null))) given[slot] = 'CREATE';
  }

  const { resolved, notes } = await resolveRoleSetup(guild, guildRow, given);

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
  missingTierRoles: TierRoleSlot[],
  deletedTierRoles: TierRoleSlot[],
  guildRow: GuildRow | null,
  preface?: string,
): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle('Setup diagnostic');
  const lines: string[] = [];
  if (preface) lines.push(preface, '');

  const configured = guildRow?.matchesChannelId || guildRow?.alertChannelId || guildRow?.resultsChannelId;
  if (!configured) lines.push('No channels configured yet — run `/setup channels`.');

  for (const role of missingTierRoles) {
    lines.push(`- ❌ The ${TIER_ROLE_LABELS[role]} role is not configured — run \`/setup roles ${role}:<role>\`.`);
  }

  for (const role of deletedTierRoles) {
    lines.push(`- ⚠️ The configured ${TIER_ROLE_LABELS[role]} role no longer exists — re-run \`/setup roles\` to point at a replacement.`);
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
    ? await runFullDiagnostic(guild, row)
    : {
        gaps: [] as ChannelGap[],
        refereePoolEmpty: false,
        missingChannels: [] as ChannelSlot[],
        missingTierRoles: ['referee', 'organizer'] as TierRoleSlot[],
        deletedTierRoles: [] as TierRoleSlot[],
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
