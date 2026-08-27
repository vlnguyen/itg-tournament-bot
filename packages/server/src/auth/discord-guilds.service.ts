import type { GuildSummary } from '@itg/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Client, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { DISCORD_CLIENT } from '../discord/discord.tokens.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { requireEnv } from './env.js';

const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token';
const DISCORD_API_BASE = 'https://discord.com/api/v10';
const MANAGE_GUILD = BigInt(PermissionFlagsBits.ManageGuild);

/**
 * The base guild-level permissions this app's own "Add to server" link
 * requests — DESIGN.md's "Inviting the bot" required set, plus the two
 * optional-but-recommended ones (`ManageChannels`, `ManageRoles`), since
 * someone clicking this link has already decided to add the bot and should
 * get everything `/setup` can make use of, not the bare minimum.
 */
const INVITE_PERMISSIONS = new PermissionsBitField([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.CreatePrivateThreads,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageRoles,
]).bitfield.toString();

interface DiscordPartialGuild {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  permissions: string;
}

interface DiscordTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

function iconUrlFrom(guild: DiscordPartialGuild): string | null {
  return guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=64` : null;
}

/**
 * "Which servers does this user administer" — unlike `TierService`'s tier
 * resolution, this can't be answered from the bot's own gateway cache: a
 * server the bot has never joined is invisible to it. Answering it needs
 * Discord's own `guilds` OAuth2 scope, so this reads the token pair
 * `AuthController`'s callback stored on `User`, refreshing it here when
 * expired — the same client credentials `/login` already trusts.
 */
@Injectable()
export class DiscordGuildsService {
  private readonly logger = new Logger(DiscordGuildsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(DISCORD_CLIENT) private readonly client: Client,
  ) {}

  /**
   * Every server this user holds Manage Guild (or ownership) in, whether
   * or not the bot has ever been added to it. `botPresent` true means "link
   * into `/g/:guildId`"; false means "offer `inviteUrl` instead" — there's
   * no tournament data to show for a guild the bot was never invited to.
   *
   * Sorted bot-present servers first, then alphabetically within each
   * group. Discord's own client sidebar order (including folders) is
   * account-settings state the public/OAuth API never exposes — there's no
   * "the user's own order" available to sub-sort by, so name is the only
   * stable tiebreaker.
   */
  async manageableGuildsFor(discordUserId: string): Promise<GuildSummary[]> {
    const accessToken = await this.accessTokenFor(discordUserId);
    if (!accessToken) return [];

    const res = await fetch(`${DISCORD_API_BASE}/users/@me/guilds`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      this.logger.warn(`GET /users/@me/guilds failed for ${discordUserId}: ${res.status}`);
      return [];
    }
    const guilds = (await res.json()) as DiscordPartialGuild[];
    const clientId = requireEnv('DISCORD_CLIENT_ID');

    return guilds
      .filter((g) => g.owner || (BigInt(g.permissions) & MANAGE_GUILD) !== 0n)
      .map((g) => {
        const present = this.client.guilds.cache.get(g.id) ?? null;
        return {
          id: g.id,
          name: present?.name ?? g.name,
          iconUrl: present ? present.iconURL({ size: 64 }) : iconUrlFrom(g),
          botPresent: present !== null,
          inviteUrl: present
            ? null
            : `https://discord.com/api/oauth2/authorize?client_id=${clientId}&scope=bot+applications.commands&permissions=${INVITE_PERMISSIONS}&guild_id=${g.id}&disable_guild_select=true`,
        };
      })
      .sort((a, b) => Number(b.botPresent) - Number(a.botPresent) || a.name.localeCompare(b.name));
  }

  /** Null when the user never granted `guilds` (signed in before this scope existed) or the refresh itself was rejected — either way, "can't answer this," not an error. */
  private async accessTokenFor(discordUserId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({ where: { discordUserId } });
    if (!user?.discordAccessToken || !user.discordRefreshToken || !user.discordTokenExpiresAt) return null;

    // A minute of slack so a request doesn't lose a race against expiry mid-flight.
    if (user.discordTokenExpiresAt.getTime() > Date.now() + 60_000) return user.discordAccessToken;

    const res = await fetch(DISCORD_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: user.discordRefreshToken,
        client_id: requireEnv('DISCORD_CLIENT_ID'),
        client_secret: requireEnv('DISCORD_CLIENT_SECRET'),
      }),
    });
    if (!res.ok) {
      this.logger.warn(`Refresh token rejected for ${discordUserId}: ${res.status}`);
      return null;
    }

    const token = (await res.json()) as DiscordTokenResponse;
    await this.prisma.user.update({
      where: { discordUserId },
      data: {
        discordAccessToken: token.access_token,
        discordRefreshToken: token.refresh_token,
        discordTokenExpiresAt: new Date(Date.now() + token.expires_in * 1000),
      },
    });
    return token.access_token;
  }
}
