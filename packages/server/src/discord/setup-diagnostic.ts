import type { Guild, GuildMember, PermissionsBitField, Role, TextChannel } from 'discord.js';
import { diagnosePermissions, type OverwriteLayer, type PermissionResolutionInput } from './permission-diagnostic.js';

/**
 * Translates real `discord.js` guild/channel/role data into the pure shapes
 * `permission-diagnostic.ts` reasons about. Kept separate from that module
 * so the resolution *logic* stays discord.js-free and unit-testable, while
 * everything Discord-specific — bitfields, overwrite collections, the
 * `@everyone` role's id being the guild id — lives here instead.
 */

export const REQUIRED_BOT_PERMS = {
  matches: [
    'ViewChannel',
    'SendMessages',
    'SendMessagesInThreads',
    'CreatePrivateThreads',
    'ManageThreads',
    'AttachFiles',
    'EmbedLinks',
    'ReadMessageHistory',
  ],
  alerts: ['ViewChannel', 'SendMessages', 'EmbedLinks', 'ReadMessageHistory'],
  results: ['ViewChannel', 'SendMessages', 'EmbedLinks'],
  general: ['ViewChannel', 'SendMessages', 'EmbedLinks'],
} as const;

/**
 * The matches channel gates thread *visibility* on a tier role — a
 * Referee/Tournament Organizer needs `ManageThreads` there to see private
 * match threads at all. The alerts channel gates *reading the queue*: a
 * tier role needs `ViewChannel`/`ReadMessageHistory` there or the
 * escalation mention that pings them lands somewhere they can't see. See
 * DESIGN.md's diagnostic table.
 */
export const REQUIRED_TIER_ROLE_PERMS = {
  matches: ['ViewChannel', 'ManageThreads'],
  alerts: ['ViewChannel', 'ReadMessageHistory'],
} as const;

function toSet(bits: PermissionsBitField): Set<string> {
  return new Set(bits.toArray());
}

function overwriteLayerFor(channel: TextChannel, targetId: string): OverwriteLayer {
  const ow = channel.permissionOverwrites.cache.get(targetId);
  return ow ? { allow: toSet(ow.allow), deny: toSet(ow.deny) } : { allow: new Set(), deny: new Set() };
}

/** Merges overwrites across several role ids the same way Discord merges a member's own roles: allow-union, deny-union. */
function mergedRoleLayer(channel: TextChannel, roleIds: readonly string[]): OverwriteLayer {
  const allow = new Set<string>();
  const deny = new Set<string>();
  for (const id of roleIds) {
    const layer = overwriteLayerFor(channel, id);
    for (const p of layer.allow) allow.add(p);
    for (const p of layer.deny) deny.add(p);
  }
  return { allow, deny };
}

/** What the bot itself resolves to in `channel`, for the required-bot-permission checks. */
export function botResolutionInput(botMember: GuildMember, channel: TextChannel): PermissionResolutionInput {
  const everyoneId = channel.guild.id;
  const ownRoleIds = [...botMember.roles.cache.keys()].filter((id) => id !== everyoneId);
  return {
    base: toSet(botMember.permissions),
    everyone: overwriteLayerFor(channel, everyoneId),
    role: mergedRoleLayer(channel, ownRoleIds),
    member: overwriteLayerFor(channel, botMember.id),
  };
}

/** What a single tier role (not a specific member) resolves to in `channel`. */
export function tierRoleResolutionInput(guild: Guild, role: Role, channel: TextChannel): PermissionResolutionInput {
  const everyoneRole = guild.roles.everyone;
  return {
    base: new Set([...toSet(everyoneRole.permissions), ...toSet(role.permissions)]),
    everyone: overwriteLayerFor(channel, everyoneRole.id),
    role: overwriteLayerFor(channel, role.id),
  };
}

export interface ChannelGap {
  channelId: string;
  /** null for a gap in the bot's own permissions; the tier role's id otherwise. */
  roleId: string | null;
  targetLabel: string;
  permission: string;
  layer: ReturnType<typeof diagnosePermissions>[number]['layer'];
}

/** A gap is addressable by `/setup`'s repair flow only when it was lost at a channel-overwrite layer — never `ROLE_BASE` (fix the role itself in Discord) or `MEMBER_OVERWRITE` (nothing in this design creates one). */
export function isRepairable(gap: Pick<ChannelGap, 'layer'>): boolean {
  return gap.layer === 'EVERYONE_OVERWRITE' || gap.layer === 'ROLE_OVERWRITE';
}

export function diagnoseBotInChannel(
  botMember: GuildMember,
  channel: TextChannel,
  required: readonly string[],
): ChannelGap[] {
  const input = botResolutionInput(botMember, channel);
  return diagnosePermissions(input, required).map((g) => ({
    channelId: channel.id,
    roleId: null,
    targetLabel: 'the bot',
    permission: g.permission,
    layer: g.layer,
  }));
}

export function diagnoseTierRoleInChannel(
  guild: Guild,
  role: Role,
  channel: TextChannel,
  required: readonly string[],
): ChannelGap[] {
  const input = tierRoleResolutionInput(guild, role, channel);
  return diagnosePermissions(input, required).map((g) => ({
    channelId: channel.id,
    roleId: role.id,
    targetLabel: `the ${role.name} role`,
    permission: g.permission,
    layer: g.layer,
  }));
}
