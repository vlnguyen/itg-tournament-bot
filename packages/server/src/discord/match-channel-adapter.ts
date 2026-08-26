import { ChannelType, type Client, type ThreadChannel } from 'discord.js';
import type { PrismaClient } from '@prisma/client';
import type { MatchChannelPort, RenderedMessage, ThreadRef } from './ports.js';

const DISCORD_UNKNOWN_MESSAGE = 10008;

function isUnknownMessage(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === DISCORD_UNKNOWN_MESSAGE;
}

/**
 * Discord-backed `MatchChannelPort`. Mechanics only — the thread and
 * message lifecycle — never match rules. See DESIGN.md, "The Match
 * Thread".
 *
 * Takes no channel IDs at construction — one instance serves every guild
 * the bot is in. `createMatchThread`/`publishResult` resolve the guild's
 * configured matches/results channel from the `Guild` row per call (via
 * the match's `tournamentId`), so a channel `/setup` repoints takes effect
 * on the next call with no restart, and boot never depends on a guild
 * already being configured.
 */
export function createMatchChannelAdapter(client: Client, prisma: PrismaClient): MatchChannelPort {
  async function guildIdOfMatch(matchId: string): Promise<string> {
    const match = await prisma.match.findUniqueOrThrow({
      where: { id: matchId },
      select: { tournament: { select: { guildId: true } } },
    });
    return match.tournament.guildId;
  }
  /**
   * Per-match debounce for the state message: coalesces a burst of
   * triggers (two photos landing within the same second) into one repost.
   * Purely an optimization — unlike a button collector, losing this on a
   * restart costs an eager repost instead of a coalesced one, never a
   * dropped or duplicated message, which is what makes it safe to hold in
   * memory. See DESIGN.md, "Keeping the prompt last" — "debounce" and
   * "repost, do not duplicate."
   */
  const pending = new Map<string, { message: RenderedMessage; result: Promise<void> }>();
  const DEBOUNCE_MS = 900;

  async function getThread(threadId: string): Promise<ThreadChannel> {
    const channel = await client.channels.fetch(threadId);
    if (!channel || !channel.isThread()) {
      throw new Error(`expected a thread channel for ${threadId}, got ${channel?.type ?? 'null'}`);
    }
    return channel;
  }

  /** Edits the state message in place if it's still the thread's last message; deletes and reposts otherwise. */
  async function applyStateMessage(matchId: string, threadId: string, message: RenderedMessage): Promise<void> {
    const thread = await getThread(threadId);
    const match = await prisma.match.findUniqueOrThrow({ where: { id: matchId } });

    if (match.stateMsgId) {
      if (thread.lastMessageId === match.stateMsgId) {
        try {
          const existing = await thread.messages.fetch(match.stateMsgId);
          // `Message#edit` leaves a field unchanged when it's omitted, not
          // cleared — a render with no embeds/components (e.g. a plain
          // placeholder) would otherwise leave the *previous* prompt's
          // select menu or buttons still attached. The state message must
          // always fully reflect the current render, never a merge with
          // whatever was there before.
          await existing.edit({ content: message.content ?? '', embeds: message.embeds ?? [], components: message.components ?? [] });
          return;
        } catch (err) {
          // 10008: deleted from under us — a repost already in flight, or a
          // manual deletion. Fall through and repost.
          if (!isUnknownMessage(err)) throw err;
        }
      } else {
        try {
          await thread.messages.delete(match.stateMsgId);
        } catch (err) {
          if (!isUnknownMessage(err)) throw err;
        }
      }
    }

    const posted = await thread.send(message);
    await prisma.match.update({ where: { id: matchId }, data: { stateMsgId: posted.id } });
  }

  return {
    async createMatchThread({ matchId, title }): Promise<ThreadRef> {
      const guildId = await guildIdOfMatch(matchId);
      const guild = await prisma.guild.findUniqueOrThrow({ where: { id: guildId } });
      if (!guild.matchesChannelId) throw new Error(`guild ${guildId} has no matches channel configured`);
      const parent = await client.channels.fetch(guild.matchesChannelId);
      if (!parent || parent.type !== ChannelType.GuildText) {
        throw new Error(`matches channel ${guild.matchesChannelId} is not a text channel`);
      }
      const thread = await parent.threads.create({
        name: title,
        type: ChannelType.PrivateThread,
        invitable: false,
      });
      // Competitors join via the mention in PlayerNotificationPort.matchReady,
      // not an explicit add here — see ports.ts.
      return { matchId, threadId: thread.id };
    },

    async postLogMessage(ref, message) {
      const thread = await getThread(ref.threadId);
      await thread.send(message);
    },

    async postMatchState(ref, message) {
      const existing = pending.get(ref.matchId);
      if (existing) {
        existing.message = message; // latest payload wins; timer already running
        return existing.result;
      }
      const entry: { message: RenderedMessage; result: Promise<void> } = {
        message,
        result: undefined as unknown as Promise<void>,
      };
      entry.result = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          pending.delete(ref.matchId);
          applyStateMessage(ref.matchId, ref.threadId, entry.message).then(resolve, reject);
        }, DEBOUNCE_MS);
      });
      pending.set(ref.matchId, entry);
      return entry.result;
    },

    async archiveThread(ref) {
      const thread = await getThread(ref.threadId);
      await thread.setArchived(true);
    },

    async publishResult(ref, message) {
      const guildId = await guildIdOfMatch(ref.matchId);
      const guild = await prisma.guild.findUniqueOrThrow({ where: { id: guildId } });
      if (!guild.resultsChannelId) throw new Error(`guild ${guildId} has no results channel configured`);
      const channel = await client.channels.fetch(guild.resultsChannelId);
      if (!channel || channel.type !== ChannelType.GuildText) {
        throw new Error(`results channel ${guild.resultsChannelId} is not a text channel`);
      }
      const posted = await channel.send(message);

      // "Each result line is then forwarded to the general channel, using
      // Discord's native message forward... rather than a re-post." See
      // DESIGN.md, "Provisioning the channels". Optional and best-effort —
      // "if the forward fails the result still stands in the results
      // channel, so it is logged and not retried."
      if (guild.generalChannelId) {
        try {
          await posted.forward(guild.generalChannelId);
        } catch (err) {
          console.warn(`[discord] forwarding result to the general channel failed for guild ${guildId}`, err);
        }
      }
    },
  };
}
