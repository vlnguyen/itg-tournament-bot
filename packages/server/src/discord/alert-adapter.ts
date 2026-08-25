import { ChannelType, type Client } from 'discord.js';
import type { AlertPort, AlertRef, RenderedMessage } from './ports.js';

/**
 * Discord-backed `AlertPort`. A disagreement or settings-violation
 * escalation, posted to the alert channel and resolved by editing that
 * same message in place — "buttons removed, body replaced with who ruled
 * and what they chose." See DESIGN.md, "Resolution is an edit, not a
 * reply".
 */
export function createAlertAdapter(client: Client, alertChannelId: string): AlertPort {
  async function getChannel() {
    const channel = await client.channels.fetch(alertChannelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      throw new Error(`alert channel ${alertChannelId} is not a text channel`);
    }
    return channel;
  }

  return {
    async raise(message: RenderedMessage): Promise<AlertRef> {
      const channel = await getChannel();
      const posted = await channel.send(message);
      return { messageId: posted.id };
    },

    async resolve(ref: AlertRef, resolution: RenderedMessage): Promise<void> {
      const channel = await getChannel();
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
