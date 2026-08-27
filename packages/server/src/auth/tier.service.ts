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

  /**
   * The homepage's server list: DESIGN.md's rejection of the `guilds`
   * OAuth scope ("which servers a user may act in is resolved from role
   * membership in the gateway cache") generalizes cleanly from "is this
   * user a member of *this* guild" to "which of the bot's guilds is this
   * user a member of" — no new scope or token storage needed, just
   * `memberIn` run across every guild the bot is already in instead of
   * one looked up by id.
   */
  async guildsFor(discordUserId: string): Promise<{ id: string; name: string; iconUrl: string | null }[]> {
    const guilds = [...this.client.guilds.cache.values()];
    const results = await Promise.all(
      guilds.map(async (guild) => ({ guild, member: await this.memberIn(guild, discordUserId) })),
    );
    return results.filter((r) => r.member !== null).map((r) => ({ id: r.guild.id, name: r.guild.name, iconUrl: r.guild.iconURL({ size: 64 }) }));
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
