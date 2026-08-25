/**
 * "Tiers are cumulative and totally ordered, so a check is
 * `tierOf(member) >= required` rather than a set intersection." See
 * DESIGN.md, "Three tiers of privilege". Pure — takes the member's role ids
 * and the guild's configured tier roles, nothing from `discord.js` — so a
 * server that collapses two or three tier slots onto one role is handled
 * for free: `tierOf` returns the *highest* tier whose role the member
 * holds, checked highest first.
 */

export const Tier = {
  NONE: 0,
  REFEREE: 1,
  TOURNAMENT_ORGANIZER: 2,
  SERVER_ADMINISTRATOR: 3,
} as const;

export type Tier = (typeof Tier)[keyof typeof Tier];

export interface TierRoleConfig {
  refereeRoleId: string | null;
  toRoleId: string | null;
  adminRoleId: string | null;
}

export function tierOf(memberRoleIds: Iterable<string>, config: TierRoleConfig): Tier {
  const roles = new Set(memberRoleIds);
  if (config.adminRoleId && roles.has(config.adminRoleId)) return Tier.SERVER_ADMINISTRATOR;
  if (config.toRoleId && roles.has(config.toRoleId)) return Tier.TOURNAMENT_ORGANIZER;
  if (config.refereeRoleId && roles.has(config.refereeRoleId)) return Tier.REFEREE;
  return Tier.NONE;
}

export function hasTier(memberRoleIds: Iterable<string>, config: TierRoleConfig, required: Tier): boolean {
  return tierOf(memberRoleIds, config) >= required;
}

/**
 * "Escalations mention every distinct role configured at Referee tier or
 * above." See DESIGN.md, "Two classes, one inbox" — deduplicated, so a
 * server that has collapsed its tiers onto one role produces one mention.
 */
export function refereeTierRoleIds(config: TierRoleConfig): string[] {
  return [...new Set([config.refereeRoleId, config.toRoleId, config.adminRoleId].filter((id): id is string => Boolean(id)))];
}
