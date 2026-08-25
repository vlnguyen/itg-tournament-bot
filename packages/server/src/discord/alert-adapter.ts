import { ChannelType, type Client } from 'discord.js';
import type { PrismaClient } from '@prisma/client';
import type { AlertPort, AlertRef, RenderedMessage } from './ports.js';

/**
 * Discord-backed `AlertPort`. A disagreement or settings-violation
 * escalation, posted to the alert channel and resolved by editing that
 * same message in place — "buttons removed, body replaced with who ruled
 * and what they chose." See DESIGN.md, "Resolution is an edit, not a
 * reply".
 *
 * Takes no channel ID at construction — one instance serves every guild;
 * the alert channel is resolved from the `Guild` row per call, same
 * reasoning as `match-channel-adapter.ts`.
 */
export function createAlertAdapter(client: Client, prisma: PrismaClient): AlertPort {
  async function getChannel(guildId: string) {
    const guild = await prisma.guild.findUniqueOrThrow({ where: { id: guildId } });
    if (!guild.alertChannelId) throw new Error(`guild ${guildId} has no alert channel configured`);
    const channel = await client.channels.fetch(guild.alertChannelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      throw new Error(`alert channel ${guild.alertChannelId} is not a text channel`);
    }
    return channel;
  }

  return {
    async raise(guildId: string, message: RenderedMessage): Promise<AlertRef> {
      const channel = await getChannel(guildId);
      const posted = await channel.send(message);
      return { messageId: posted.id };
    },

    async resolve(guildId: string, ref: AlertRef, resolution: RenderedMessage): Promise<void> {
      const channel = await getChannel(guildId);
      const message = await channel.messages.fetch(ref.messageId);
      // Explicitly cleared, not merely omitted — see match-channel-adapter.ts's
      // own note on Message#edit leaving an unset field unchanged rather
      // than clearing it.
      await message.edit({
        content: resolution.content ?? '',
        embeds: resolution.embeds ?? [],
        components: [],
      });
    },
  };
}
