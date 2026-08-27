import {
  ChannelType,
  OverwriteType,
  type CategoryChannel,
  type Guild as DiscordGuild,
  type PermissionsString,
  type TextChannel,
} from 'discord.js';
import type { Guild as GuildRow } from '@prisma/client';
import type { ChannelSlot, TierRoleSlot } from '@itg/shared';
import { refereeTierRoleIds, type TierRoleConfig } from './tier.js';
import {
  diagnoseBotInChannel,
  diagnoseTierRoleInChannel,
  REQUIRED_BOT_PERMS,
  REQUIRED_TIER_ROLE_PERMS,
  type ChannelGap,
} from './setup-diagnostic.js';

/**
 * `/setup`'s actual work — resolving what channels/roles a guild should be
 * pointed at, creating them when nothing was given and nothing already
 * exists, and running the live permission diagnostic — pulled out of
 * `commands/setup.ts` so the web console's server-reconfiguration panel
 * can call the exact same logic `/setup channels`/`/setup roles`/`/setup
 * status` do. Same "one implementation, shared by both transports"
 * reasoning as `start-tournament-effects.ts`. `commands/setup.ts` keeps
 * only what's actually Discord-transport-specific: parsing interaction
 * options, rendering the embed, and the Re-check/Repair buttons.
 */

export const EMPTY_TIER_CONFIG: TierRoleConfig = { refereeRoleId: null, toRoleId: null, adminRoleId: null };

export const TIER_ROLE_LABELS: Record<TierRoleSlot, string> = {
  referee: 'Referee',
  organizer: 'Tournament Organizer',
};

// ---------------------------------------------------------------------------
// Channels
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

/** Reuses an existing "Tournament" category if one is already there, rather than creating a duplicate on every re-run. */
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

export async function fetchTextChannel(guild: DiscordGuild, id: string | null): Promise<TextChannel | null> {
  if (!id) return null;
  const channel = await guild.channels.fetch(id).catch(() => null);
  return channel && channel.type === ChannelType.GuildText ? channel : null;
}

export interface ChannelSetupResult {
  resolved: Record<ChannelSlot, string | null>;
  notes: string[];
}

/** A slot's explicit instruction: point at a specific channel, or create a new one. No entry at all is a strict no-op — see `ChannelPick`'s own comment. */
export type ChannelPick = string | 'CREATE';

/**
 * `given[slot]` a channel id → point at it, even repointing an
 * already-configured slot. `given[slot] === 'CREATE'` → create one in (or
 * alongside) a "Tournament" category, creating that category on first
 * need — regardless of whatever was already configured. No entry for a
 * slot at all is a strict no-op: it is left exactly as already resolved,
 * never auto-created. `/setup channels`'s own bootstrap default —
 * "nothing given and nothing configured means create it" — lives in the
 * Discord command layer (`commands/setup.ts`), which synthesizes `CREATE`
 * for exactly that case before calling this; the console never does,
 * since a blank picker there is a deliberate no-op, not an implicit
 * request to create something. `general` has no `'CREATE'` path at all —
 * it is only ever pointed at.
 */
export async function resolveChannelSetup(
  guild: DiscordGuild,
  guildRow: GuildRow | null,
  given: Partial<Record<ChannelSlot, ChannelPick>>,
  tierRoleIds: readonly string[],
  botId: string,
): Promise<ChannelSetupResult> {
  const notes: string[] = [];
  const resolved: Record<ChannelSlot, string | null> = {
    matches: guildRow?.matchesChannelId ?? null,
    alerts: guildRow?.alertChannelId ?? null,
    results: guildRow?.resultsChannelId ?? null,
    general: guildRow?.generalChannelId ?? null,
  };

  // A channel id already on file might point at something Discord no
  // longer has — deleted since it was configured. Cleared rather than
  // kept as a stale pointer, whether or not this call also creates a
  // replacement.
  for (const slot of ['matches', 'alerts', 'results', 'general'] as const) {
    if (resolved[slot] && !(await fetchTextChannel(guild, resolved[slot]))) {
      resolved[slot] = null;
    }
  }

  const needsCreation = (['matches', 'alerts', 'results'] as const).some((slot) => given[slot] === 'CREATE');
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
    if (pick && pick !== 'CREATE') {
      resolved[slot] = pick;
      notes.push(`Pointed at the ${slot} channel.`);
      continue;
    }
    if (pick !== 'CREATE') continue; // no explicit instruction — leave it exactly as resolved above
    if (categoryError) {
      notes.push(
        `Couldn't create a ${slot} channel (no "${TOURNAMENT_CATEGORY_NAME}" category: ${categoryError}) — create one yourself and point at it.`,
      );
      continue;
    }
    try {
      const created = await createManagedChannel(guild, slot, tierRoleIds, botId, categoryId!);
      resolved[slot] = created.id;
      notes.push(`Created #${created.name} for the ${slot} channel.`);
    } catch (err) {
      notes.push(`Couldn't create a ${slot} channel (${(err as Error).message}) — create one yourself and point at it.`);
    }
  }
  if (given.general && given.general !== 'CREATE') {
    resolved.general = given.general;
    notes.push('Pointed at the general channel.');
  }

  return { resolved, notes };
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/**
 * Mentionable, so the bot's own escalation mentions actually ping — Discord's
 * `mentionable` flag otherwise silences a role mention from anyone without
 * "Mention @everyone/roles". No color/hoist opinion; DESIGN.md has none,
 * and that's cosmetic for an administrator to set themselves.
 */
async function createTierRole(guild: DiscordGuild, slot: TierRoleSlot) {
  return guild.roles.create({ name: TIER_ROLE_LABELS[slot], mentionable: true });
}

export interface RoleSetupResult {
  resolved: Record<TierRoleSlot, string | null>;
  notes: string[];
}

/**
 * Same shape of decision as `resolveChannelSetup`, for the two tier
 * roles — a role id points at it, `'CREATE'` creates one regardless of
 * what's already bound, and no entry at all is a strict no-op. Server
 * Administrator is deliberately absent — see DESIGN.md, "Provisioning
 * the roles": there is no slot to bind, point at, or create for it.
 */
export async function resolveRoleSetup(
  guild: DiscordGuild,
  guildRow: GuildRow | null,
  given: Partial<Record<TierRoleSlot, ChannelPick>>,
): Promise<RoleSetupResult> {
  const notes: string[] = [];
  const resolved: Record<TierRoleSlot, string | null> = {
    referee: guildRow?.refereeRoleId ?? null,
    organizer: guildRow?.toRoleId ?? null,
  };

  // A bound role Discord no longer has — deleted since it was configured —
  // is cleared rather than kept as a stale pointer, same as a deleted
  // channel above.
  for (const slot of ['referee', 'organizer'] as const) {
    if (resolved[slot] && !(await guild.roles.fetch(resolved[slot]!).catch(() => null))) {
      resolved[slot] = null;
    }
  }

  for (const slot of ['referee', 'organizer'] as const) {
    const pick = given[slot];
    if (pick && pick !== 'CREATE') {
      resolved[slot] = pick;
      notes.push(`${TIER_ROLE_LABELS[slot]} tier role updated.`);
      continue;
    }
    if (pick !== 'CREATE') continue; // no explicit instruction — leave it exactly as resolved above
    try {
      const created = await createTierRole(guild, slot);
      resolved[slot] = created.id;
      notes.push(`Created role **${created.name}** for ${TIER_ROLE_LABELS[slot]} tier.`);
    } catch (err) {
      notes.push(`Couldn't create a ${TIER_ROLE_LABELS[slot]} role (${(err as Error).message}) — create one yourself and point at it.`);
    }
  }

  return { resolved, notes };
}

// ---------------------------------------------------------------------------
// The diagnostic itself, shared by every surface that needs "is this guild
// actually usable right now" — /setup status, /tournament start's
// preflight, and the web console's setup panel.
// ---------------------------------------------------------------------------

export interface FullDiagnostic {
  gaps: ChannelGap[];
  refereePoolEmpty: boolean;
  missingChannels: ChannelSlot[];
  missingTierRoles: TierRoleSlot[];
  deletedTierRoles: TierRoleSlot[];
}

export async function runFullDiagnostic(guild: DiscordGuild, guildRow: GuildRow): Promise<FullDiagnostic> {
  const botMember = guild.members.me ?? (await guild.members.fetchMe());
  const gaps: ChannelGap[] = [];
  const missingChannels: ChannelSlot[] = [];

  // Referee and Tournament Organizer are load-bearing, not optional: with
  // no TO role bound, not one `/tournament` lifecycle command is reachable
  // by anyone; with no referee role, a disagreement has nobody to escalate
  // to. Both are required here, unlike Server Administrator, which
  // `/setup` itself can always fall back to Manage Guild for.
  const missingTierRoles: TierRoleSlot[] = [];
  if (!guildRow.refereeRoleId) missingTierRoles.push('referee');
  if (!guildRow.toRoleId) missingTierRoles.push('organizer');

  // Bound, but Discord doesn't have it anymore — deleted since it was
  // configured. Same "equivalent to unconfigured" reasoning as a deleted
  // channel, but reported separately from `missingTierRoles` above: this
  // one says "re-point it," not "bind one for the first time."
  const deletedTierRoles: TierRoleSlot[] = [];
  const boundTierRoles: [TierRoleSlot, string | null][] = [
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

/** Groups repairable gaps by (channel, target) and applies one merged overwrite edit each — bounded by whatever the bot can actually touch; a 50013 here means the ceiling DESIGN.md flags as an open question. */
export async function applyRepairs(guild: DiscordGuild, gaps: ChannelGap[]): Promise<{ succeeded: number; failed: string[] }> {
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
