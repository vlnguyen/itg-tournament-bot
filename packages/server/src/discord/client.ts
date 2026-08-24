import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';

/**
 * `MessageContent` and `GuildMembers` are privileged intents — both must be
 * toggled on in the Developer Portal (Bot tab) before `login` will succeed.
 * See DESIGN.md, "Privileged intents": `MessageContent` is what lets the
 * bot see a result-screen photo's attachment at all; `GuildMembers` backs
 * `GuildMemberRemove` for departure handling (not load-bearing until
 * timers/alerts land, requested now rather than reapproved later).
 */
export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    ],
    // Threads only fire message events for members added to them by
    // default; a private match thread's two competitors are always added
    // explicitly, but partials keep uncached thread messages (e.g. after a
    // restart) resolvable instead of silently dropped.
    partials: [Partials.Message, Partials.Channel, Partials.ThreadMember],
  });
}

/**
 * `Client#login` resolves once the identify handshake succeeds, not once
 * the gateway session is fully established — an interaction can plausibly
 * arrive (or a handler start racing setup) before that. Waiting for
 * `ClientReady` too is what makes "logged in" actually mean "ready to
 * dispatch," which is what the caller wants before registering handlers
 * or announcing itself up.
 */
export async function loginDiscordClient(client: Client, token: string): Promise<void> {
  const ready = new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()));
  await client.login(token);
  await ready;
}
