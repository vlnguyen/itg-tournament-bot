import type { Client } from 'discord.js';
import type { PlayerNotificationPort, ThreadRef } from './ports.js';

const CANNOT_SEND_TO_USER = 50007;
const NO_MUTUAL_GUILDS = 50278;

function isExpectedDmFailure(err: unknown): err is { code: number } {
  return typeof err === 'object' && err !== null && 'code' in err &&
    ((err as { code: unknown }).code === CANNOT_SEND_TO_USER || (err as { code: unknown }).code === NO_MUTUAL_GUILDS);
}

/**
 * "Match-ready lands twice: a mention in the thread, and a direct
 * message... The thread mention is the notification of record — nothing
 * depends on the DM arriving." Both failure codes Discord raises for a
 * closed-DM or departed player are expected outcomes, not errors: logged
 * at debug, never retried, no alert raised. See DESIGN.md, "Notifying
 * players, and the channels".
 */
export function createPlayerNotificationAdapter(client: Client): PlayerNotificationPort {
  return {
    async matchReady(playerIds: string[], thread: ThreadRef): Promise<void> {
      const channel = await client.channels.fetch(thread.threadId);
      if (!channel || !channel.isThread()) {
        throw new Error(`expected a thread channel for ${thread.threadId}, got ${channel?.type ?? 'null'}`);
      }

      await channel.send({ content: `${playerIds.map((id) => `<@${id}>`).join(' ')} — your match is ready.` });

      const link = `https://discord.com/channels/${channel.guildId}/${channel.id}`;
      for (const userId of playerIds) {
        try {
          const user = await client.users.fetch(userId);
          await user.send(`Your match is ready: ${link}`);
        } catch (err) {
          if (!isExpectedDmFailure(err)) throw err;
          console.debug(`[discord] DM to ${userId} failed as expected (code ${err.code})`);
        }
      }
    },
  };
}
