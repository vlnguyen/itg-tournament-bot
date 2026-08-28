import { ChannelType, EmbedBuilder, type Client } from 'discord.js';
import type { PrismaClient } from '@prisma/client';
import type { PlayerNotificationPort, ThreadRef } from './ports.js';
import { LOG_COLOR } from './render/draw.js';
import { matchUrl, tournamentUrl } from '../web-url.js';

const CANNOT_SEND_TO_USER = 50007;
const NO_MUTUAL_GUILDS = 50278;

function isExpectedDmFailure(err: unknown): err is { code: number } {
  return typeof err === 'object' && err !== null && 'code' in err &&
    ((err as { code: unknown }).code === CANNOT_SEND_TO_USER || (err as { code: unknown }).code === NO_MUTUAL_GUILDS);
}

/**
 * Best-effort DM to one user — the shared failure semantics behind both
 * `matchReady` and `checkinOpened`: an expected closed-DM/departed-player
 * code is logged at debug and swallowed, never retried, never raised as an
 * error. Returns whether it actually landed, so a caller can report who it
 * could not reach.
 */
async function tryDm(client: Client, userId: string, embed: EmbedBuilder): Promise<boolean> {
  try {
    const user = await client.users.fetch(userId);
    await user.send({ embeds: [embed] });
    return true;
  } catch (err) {
    if (!isExpectedDmFailure(err)) throw err;
    console.debug(`[discord] DM to ${userId} failed as expected (code ${err.code})`);
    return false;
  }
}

/** Posts a no-mentions announcement to the guild's general channel, if one is configured — a silent no-op otherwise, same as every other use of that optional forward target. */
async function postToGeneralChannel(
  client: Client,
  prisma: PrismaClient,
  guildId: string,
  content: string,
  opts: { title?: string; color?: number } = {},
): Promise<void> {
  const guild = await prisma.guild.findUnique({ where: { id: guildId } });
  if (!guild?.generalChannelId) return;
  const channel = await client.channels.fetch(guild.generalChannelId).catch(() => null);
  if (channel && channel.type === ChannelType.GuildText) {
    const embed = new EmbedBuilder().setDescription(content);
    if (opts.title) embed.setTitle(opts.title);
    if (opts.color !== undefined) embed.setColor(opts.color);
    await channel.send({ embeds: [embed] });
  }
}

/** A deep link straight to a channel — lands a DM recipient inside the server, not just told to go find it. */
function channelLink(guildId: string, channelId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}`;
}

/**
 * "Match-ready lands twice: a mention in the thread, and a direct
 * message... The thread mention is the notification of record — nothing
 * depends on the DM arriving." See DESIGN.md, "Notifying players, and the
 * channels". `checkinOpened` is the other of the two events DMs are used
 * for at all — see REQUIREMENTS.md, "Notifications".
 */
export function createPlayerNotificationAdapter(client: Client, prisma: PrismaClient): PlayerNotificationPort {
  return {
    async matchReady(players: readonly { discordUserId: string; displayName: string }[], thread: ThreadRef, tournamentId: string): Promise<void> {
      const channel = await client.channels.fetch(thread.threadId);
      if (!channel || !channel.isThread()) {
        throw new Error(`expected a thread channel for ${thread.threadId}, got ${channel?.type ?? 'null'}`);
      }

      const threadLink = `https://discord.com/channels/${channel.guildId}/${channel.id}`;
      const [p0, p1] = players;

      // The mention has to live in `content` to actually notify — Discord
      // does not reliably deliver a push/highlight notification for a
      // mention that appears only inside an embed. Same split
      // `buildEscalationAlert` already uses for its referee-role mention.
      await channel.send({
        content: players.map((p) => `<@${p.discordUserId}>`).join(' '),
        embeds: [
          new EmbedBuilder()
            .setTitle(`${p0!.displayName} vs ${p1!.displayName}`)
            .setColor(LOG_COLOR.MATCH_READY)
            .setDescription(`Your match is ready.\n\n**[Match Link](${matchUrl(tournamentId, thread.matchId)})**`),
        ],
      });

      const dm = new EmbedBuilder().setTitle('Your match is ready').setColor(LOG_COLOR.MATCH_READY).setDescription(`**Match Thread**\n${threadLink}`);
      for (const p of players) {
        await tryDm(client, p.discordUserId, dm);
      }
    },

    async checkinOpened(guildId: string, tournamentName: string, playerIds: string[]): Promise<{ unreachable: string[] }> {
      // "The channel post carries no mentions."
      await postToGeneralChannel(
        client,
        prisma,
        guildId,
        `Check-in is now open for **${tournamentName}**. Registered players: check your DMs, or use \`/checkin\`.`,
      );

      // `/checkin` is a guild-scoped command — it can't be run from the DM
      // itself, so the DM needs a way back into the server. The general
      // channel is the natural landing spot when one is configured; without
      // it, the player is on their own to find their way back in.
      const guild = await prisma.guild.findUnique({ where: { id: guildId } });
      const landingLink = guild?.generalChannelId ? `\n${channelLink(guildId, guild.generalChannelId)}` : '';

      const dm = new EmbedBuilder()
        .setTitle('Tournament starting')
        .setColor(LOG_COLOR.TOURNAMENT_STARTING)
        .setDescription(`Check-in is now open for **${tournamentName}**. Use \`/checkin\` to confirm you're playing.${landingLink}`);

      const unreachable: string[] = [];
      for (const userId of playerIds) {
        const reached = await tryDm(client, userId, dm);
        if (!reached) unreachable.push(userId);
      }
      return { unreachable };
    },

    // Same lead phrasing as the ephemeral reply in `discord/commands/tournament.ts`
    // ("Registration is open for **{name}**"), with a different addendum —
    // this one is public, so it points a reader at the command instead of
    // confirming the transition to the TO who ran it.
    async registrationOpened(guildId: string, tournamentId: string, tournamentName: string): Promise<void> {
      await postToGeneralChannel(
        client,
        prisma,
        guildId,
        `Registration is open for [**${tournamentName}**](${tournamentUrl(tournamentId)}). Type \`/join\` to enter.`,
        { title: '📝 Registration open', color: LOG_COLOR.REGISTRATION_OPEN },
      );
    },

    async entrantJoined(guildId: string, displayName: string, tournamentId: string, tournamentName: string): Promise<void> {
      await postToGeneralChannel(
        client,
        prisma,
        guildId,
        `📝 **${displayName}** joined [**${tournamentName}**](${tournamentUrl(tournamentId)}). Type \`/join\` to enter the tournament.`,
        { color: LOG_COLOR.ENTRANT_JOINED },
      );
    },

    async entrantCheckedIn(guildId: string, displayName: string): Promise<void> {
      await postToGeneralChannel(client, prisma, guildId, `✅ **${displayName}** checked in. Type \`/checkin\` to confirm your spot.`, {
        color: LOG_COLOR.ENTRANT_CHECKED_IN,
      });
    },

    // Same lead phrasing as the ephemeral reply in `discord/commands/tournament.ts`.
    async tournamentCancelled(guildId: string, tournamentId: string, tournamentName: string): Promise<void> {
      await postToGeneralChannel(client, prisma, guildId, `🚫 [**${tournamentName}**](${tournamentUrl(tournamentId)}) is cancelled.`, {
        color: LOG_COLOR.GENERAL_TOURNAMENT_CANCELLED,
      });
    },

    async checkinClosed(guildId: string, tournamentId: string, tournamentName: string): Promise<void> {
      await postToGeneralChannel(client, prisma, guildId, `🔒 Check-in is closed for [**${tournamentName}**](${tournamentUrl(tournamentId)}).`, {
        color: LOG_COLOR.CHECKIN_CLOSED,
      });
    },

    // Deliberately just the headline, not the operational detail (thread
    // count, pack-size/tier-role/referee-pool warnings) the ephemeral reply
    // and organizer-alert log carry — those are for the TO, not spectators.
    async tournamentStarted(guildId: string, tournamentId: string, tournamentName: string): Promise<void> {
      await postToGeneralChannel(client, prisma, guildId, `🏁 [**${tournamentName}**](${tournamentUrl(tournamentId)}) has started!`, {
        color: LOG_COLOR.TOURNAMENT_STARTED,
      });
    },
  };
}
