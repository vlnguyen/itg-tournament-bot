import type { APIInteractionGuildMember, Guild, GuildMember, User } from 'discord.js';

type InteractionMember = GuildMember | APIInteractionGuildMember | null | undefined;

/**
 * Handles both shapes an interaction's `member` can come back as: a cached
 * `GuildMember` (whose `displayName` getter already resolves nickname →
 * global name → username) or the raw API partial, which carries `nick`
 * directly and falls back the same way.
 */
function isCachedMember(member: NonNullable<InteractionMember>): member is GuildMember {
  return !Array.isArray(member.roles);
}

/**
 * Server nickname if set, else global display name, else username — "the
 * name the server shows." Used to attribute a referee ruling, a
 * Protect/Veto reset, or an organizer roster action to how this guild
 * currently displays them.
 */
export function memberDisplayName(member: InteractionMember, user: User): string {
  if (member && isCachedMember(member)) return member.displayName;
  const nick = member && 'nick' in member ? member.nick : undefined;
  return nick ?? user.globalName ?? user.username;
}

/**
 * The same "nickname, else global name, else username" resolution, but for
 * a `User` that isn't the one who invoked the interaction — e.g. `/roster`'s
 * `player` option — so there is no `interaction.member` already in hand and
 * a live fetch is needed instead. Falls back to `user`'s own name fields if
 * they can no longer be fetched as a member (they left the guild) — "a
 * missing name should not be the thing that blocks" an organizer action,
 * same reasoning DESIGN.md gives for the display-name snapshot at
 * tournament start.
 */
export async function fetchMemberDisplayName(guild: Guild, user: User): Promise<string> {
  const member = await guild.members.fetch(user.id).catch(() => null);
  return member?.displayName ?? user.globalName ?? user.username;
}

/**
 * Same resolution again, for a caller that only has a Discord user id on
 * hand — an `Entrant` row, say, which stores `discordUserId` and nothing
 * else. Falls back to a bare user fetch (global name, then username) if
 * they're no longer a member, and to the raw id as a last resort so this
 * never throws.
 */
export async function fetchDisplayNameById(guild: Guild, userId: string): Promise<string> {
  const member = await guild.members.fetch(userId).catch(() => null);
  if (member) return member.displayName;
  const user = await guild.client.users.fetch(userId).catch(() => null);
  return user?.globalName ?? user?.username ?? userId;
}
