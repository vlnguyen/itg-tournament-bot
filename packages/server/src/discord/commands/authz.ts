import type { ChatInputCommandInteraction } from 'discord.js';
import type { Guild as GuildRow } from '@prisma/client';
import { hasTier, Tier, type TierRoleConfig } from '../tier.js';

/**
 * Tier authorization shared by every slash-command handler that needs it.
 * See DESIGN.md, "Rulings": "Button interactions and organizer slash
 * commands are authorized by resolving the acting user's tier... and
 * comparing it against what the action requires."
 */

const EMPTY_TIER_CONFIG: TierRoleConfig = { refereeRoleId: null, toRoleId: null, adminRoleId: null };

/**
 * Every role's roles come back shaped differently depending on whether
 * discord.js resolved a full cached `GuildMember` or the raw API partial —
 * both carry the same role ids, just under different shapes. Mirrors
 * `interactions.ts`'s identical helper for button/select interactions.
 */
export function rolesOfMember(member: ChatInputCommandInteraction['member']): string[] {
  if (!member) return [];
  if (Array.isArray(member.roles)) return member.roles;
  return [...member.roles.cache.keys()];
}

/**
 * Replies ephemerally and returns `false` if the invoking member is below
 * Tournament Organizer tier; otherwise returns `true` without replying.
 * "Tier is Tournament Organizer, not Referee. Roster composition is
 * tournament management rather than unblocking a match" — see DESIGN.md,
 * "Acting on a player's behalf" — so this is the one tier check every
 * `/tournament` and `/roster` command shares.
 */
export async function requireOrganizerTier(interaction: ChatInputCommandInteraction, guildRow: GuildRow | null): Promise<boolean> {
  const tierConfig = guildRow ?? EMPTY_TIER_CONFIG;
  if (hasTier(rolesOfMember(interaction.member), tierConfig, Tier.TOURNAMENT_ORGANIZER)) return true;
  await interaction.reply({
    ephemeral: true,
    content: guildRow?.toRoleId
      ? 'You need **Tournament Organizer** tier to run this command.'
      : 'This server has no Tournament Organizer role configured yet — ask someone with **Manage Server** to run `/setup roles`.',
  });
  return false;
}
