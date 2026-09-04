import type { GuildSummary } from '@itg/shared';
import { Inject, Injectable } from '@nestjs/common';
import { Client, Guild, GuildMember, PermissionFlagsBits } from 'discord.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DISCORD_CLIENT } from '../discord/discord.tokens.js';
import { hasTier, Tier, tierOf, type TierRoleConfig } from '../discord/tier.js';

const EMPTY_TIER_CONFIG: TierRoleConfig = { refereeRoleId: null, toRoleId: null, adminRoleId: null };

/**
 * The transport-independent half of `tierOf`/`hasTier` — see DESIGN.md,
 * "Authentication and Authorization": "Authorization is one service,
 * transport-independent." A Discord interaction already carries the
 * invoking member's role ids for free (`authz.ts`'s `rolesOfMember`); a
 * signed-in web session carries only a Discord user id from its cookie, so
 * this is the path that resolves the rest — the guild's configured tier
 * roles from Postgres, and the member's actual roles in that guild from the
 * bot's own gateway membership cache, the same source of truth Discord
 * interactions already trust.
 */
@Injectable()
export class TierService {
  constructor(
    // Explicit @Inject on both params — mixing one undecorated param with a
    // later @Inject one tripped up esbuild's emitDecoratorMetadata output
    // (the undecorated PrismaService param resolved as undefined at
    // runtime, even though `tsc --noEmit` saw nothing wrong).
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(DISCORD_CLIENT) private readonly client: Client,
  ) {}

  async resolveTier(guildId: string, discordUserId: string): Promise<Tier> {
    const [tierConfig, roleIds] = await Promise.all([
      this.tierConfigFor(guildId),
      this.memberRoleIds(guildId, discordUserId),
    ]);
    return tierOf(roleIds, tierConfig);
  }

  async hasTier(guildId: string, discordUserId: string, required: Tier): Promise<boolean> {
    const [tierConfig, roleIds] = await Promise.all([
      this.tierConfigFor(guildId),
      this.memberRoleIds(guildId, discordUserId),
    ]);
    return hasTier(roleIds, tierConfig, required);
  }

  /**
   * "Reconfiguring the server itself is gated on Discord's own Manage
   * Guild permission rather than a third bound role." See DESIGN.md,
   * "Bootstrap: the one place Discord permissions gate anything" — the
   * same check `/setup` makes via `interaction.memberPermissions`, just
   * resolved from the gateway cache instead of a live interaction.
   * `GuildMember.permissions` is already the effective *guild-level*
   * permission set (role-based), which is exactly what Manage Guild is —
   * no channel-overwrite resolution needed, unlike the bot's own
   * per-channel permissions (`permission-diagnostic.ts`).
   */
  async hasManageGuild(guildId: string, discordUserId: string): Promise<boolean> {
    const member = await this.memberOf(guildId, discordUserId);
    return member?.permissions.has(PermissionFlagsBits.ManageGuild) ?? false;
  }

  /**
   * "Which servers does this user organize" — the Tournament Organizer
   * counterpart to `DiscordGuildsService.manageableGuildsFor`, and
   * necessarily a different shape: TO role membership isn't something
   * Discord's OAuth `guilds` scope ever exposes (it returns a computed
   * permissions bitfield, not per-guild role ids), so this can only answer
   * for guilds the bot's own gateway cache already knows — the same
   * `client.guilds.cache` enumeration `AdminController.getGuilds` uses.
   * Excludes anywhere the user already holds Manage Guild, since that
   * server belongs to the homepage's other list instead.
   */
  async organizerOnlyGuildsFor(discordUserId: string): Promise<GuildSummary[]> {
    const guilds = [...this.client.guilds.cache.values()];
    const results = await Promise.all(
      guilds.map(async (guild): Promise<GuildSummary | null> => {
        const [isOrganizer, isManager] = await Promise.all([
          this.hasTier(guild.id, discordUserId, Tier.TOURNAMENT_ORGANIZER),
          this.hasManageGuild(guild.id, discordUserId),
        ]);
        if (!isOrganizer || isManager) return null;
        return { id: guild.id, name: guild.name, iconUrl: guild.iconURL({ size: 64 }), botPresent: true, inviteUrl: null };
      }),
    );
    return results.filter((g): g is GuildSummary => g !== null).sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * "The name the server shows" — same resolution as
   * `member-display-name.ts`'s `fetchDisplayNameById` (nickname, else
   * global name, else username, else the raw id as a last resort so this
   * never throws), just reusing `memberOf`'s cache-first lookup instead of
   * a bare `guild.members.fetch`. This is what a web-originated action
   * should attribute itself as everywhere a Discord-originated one already
   * does — a referee ruling's thread log line, a lifecycle transition's
   * organizer-alert entry — rather than the `User` table's cached OAuth
   * name, which is global, not this guild's, and can be null for anyone
   * who signed in but was never given a nickname.
   */
  async resolveDisplayName(guildId: string, discordUserId: string): Promise<string> {
    const member = await this.memberOf(guildId, discordUserId);
    if (member) return member.displayName;

    const user = await this.client.users.fetch(discordUserId).catch(() => null);
    return user?.globalName ?? user?.username ?? discordUserId;
  }

  private async tierConfigFor(guildId: string): Promise<TierRoleConfig> {
    const guildRow = await this.prisma.guild.findUnique({ where: { id: guildId } });
    return guildRow ?? EMPTY_TIER_CONFIG;
  }

  /** Cache first — a fetch only crosses the gateway when a member was never observed. */
  private async memberIn(guild: Guild, discordUserId: string): Promise<GuildMember | null> {
    const cached = guild.members.cache.get(discordUserId);
    if (cached) return cached;

    try {
      return await guild.members.fetch(discordUserId);
    } catch {
      // Not a member of this guild — left, never joined, or the fetch failed.
      return null;
    }
  }

  private async memberOf(guildId: string, discordUserId: string): Promise<GuildMember | null> {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return null;
    return this.memberIn(guild, discordUserId);
  }

  private async memberRoleIds(guildId: string, discordUserId: string): Promise<string[]> {
    const member = await this.memberOf(guildId, discordUserId);
    return member ? [...member.roles.cache.keys()] : [];
  }
}
