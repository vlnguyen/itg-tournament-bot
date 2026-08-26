import { Inject, Injectable } from '@nestjs/common';
import { Client } from 'discord.js';
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

  private async tierConfigFor(guildId: string): Promise<TierRoleConfig> {
    const guildRow = await this.prisma.guild.findUnique({ where: { id: guildId } });
    return guildRow ?? EMPTY_TIER_CONFIG;
  }

  /** Cache first — a fetch only crosses the gateway when a member's roles were never observed. */
  private async memberRoleIds(guildId: string, discordUserId: string): Promise<string[]> {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return [];

    const cached = guild.members.cache.get(discordUserId);
    if (cached) return [...cached.roles.cache.keys()];

    try {
      const fetched = await guild.members.fetch(discordUserId);
      return [...fetched.roles.cache.keys()];
    } catch {
      // Not a member of this guild — left, never joined, or the fetch failed. No tier.
      return [];
    }
  }
}
