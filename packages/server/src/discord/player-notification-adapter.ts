import { ChannelType, type Client } from 'discord.js';
import type { PrismaClient } from '@prisma/client';
import type { PlayerNotificationPort, ThreadRef } from './ports.js';

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
async function tryDm(client: Client, userId: string, content: string): Promise<boolean> {
  try {
    const user = await client.users.fetch(userId);
    await user.send(content);
    return true;
  } catch (err) {
    if (!isExpectedDmFailure(err)) throw err;
    console.debug(`[discord] DM to ${userId} failed as expected (code ${err.code})`);
    return false;
  }
}

/** Posts a no-mentions announcement to the guild's general channel, if one is configured — a silent no-op otherwise, same as every other use of that optional forward target. */
async function postToGeneralChannel(client: Client, prisma: PrismaClient, guildId: string, content: string): Promise<void> {
  const guild = await prisma.guild.findUnique({ where: { id: guildId } });
  if (!guild?.generalChannelId) return;
  const channel = await client.channels.fetch(guild.generalChannelId).catch(() => null);
  if (channel && channel.type === ChannelType.GuildText) {
    await channel.send({ content });
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
    async matchReady(playerIds: string[], thread: ThreadRef): Promise<void> {
      const channel = await client.channels.fetch(thread.threadId);
      if (!channel || !channel.isThread()) {
        throw new Error(`expected a thread channel for ${thread.threadId}, got ${channel?.type ?? 'null'}`);
      }

      await channel.send({ content: `${playerIds.map((id) => `<@${id}>`).join(' ')} — your match is ready.` });

      const link = `https://discord.com/channels/${channel.guildId}/${channel.id}`;
      for (const userId of playerIds) {
        await tryDm(client, userId, `Your match is ready: ${link}`);
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

      const unreachable: string[] = [];
      for (const userId of playerIds) {
        const reached = await tryDm(
          client,
          userId,
          `Check-in is now open for **${tournamentName}** — use \`/checkin\` to confirm you're playing.${landingLink}`,
        );
        if (!reached) unreachable.push(userId);
      }
      return { unreachable };
    },

    // Same lead phrasing as the ephemeral reply in `discord/commands/tournament.ts`
    // ("Registration is open for **{name}**"), with a different addendum —
    // this one is public, so it points a reader at the command instead of
    // confirming the transition to the TO who ran it.
    async registrationOpened(guildId: string, tournamentName: string): Promise<void> {
      await postToGeneralChannel(client, prisma, guildId, `Registration is open for **${tournamentName}** — Type \`/join\` to enter.`);
    },

    async entrantJoined(guildId: string, displayName: string): Promise<void> {
      await postToGeneralChannel(client, prisma, guildId, `**${displayName}** joined the tournament. Type \`/join\` to enter the tournament.`);
    },

    async entrantCheckedIn(guildId: string, displayName: string): Promise<void> {
      await postToGeneralChannel(client, prisma, guildId, `**${displayName}** checked in. Type \`/checkin\` to confirm your spot.`);
    },

    // Same lead phrasing as the ephemeral reply in `discord/commands/tournament.ts`.
    async tournamentCancelled(guildId: string, tournamentName: string): Promise<void> {
      await postToGeneralChannel(client, prisma, guildId, `**${tournamentName}** is cancelled.`);
    },

    async checkinClosed(guildId: string, tournamentName: string): Promise<void> {
      await postToGeneralChannel(client, prisma, guildId, `Check-in is closed for **${tournamentName}** — seeds are renumbered and locked in.`);
    },

    // Deliberately just the headline, not the operational detail (thread
    // count, pack-size/tier-role/referee-pool warnings) the ephemeral reply
    // and organizer-alert log carry — those are for the TO, not spectators.
    async tournamentStarted(guildId: string, tournamentName: string): Promise<void> {
      await postToGeneralChannel(client, prisma, guildId, `🏁 **${tournamentName}** has started!`);
    },
  };
}
