/**
 * The real bot entrypoint — supersedes `scripts/run-bot.ts` for actual use.
 * That script and `scripts/seed-verification-match.ts` remain as dev/testing
 * conveniences (the latter is still useful for seeding a chart pack into a
 * tournament, since real pack import doesn't exist yet); this is what a
 * deployment actually runs.
 *
 * Unlike the dev scripts, this isn't scoped to one pre-seeded guild: it
 * registers commands for every guild it's already in at boot, and again
 * whenever it joins a new one, and every adapter resolves its channels from
 * the `Guild` row per call rather than at construction — see
 * `match-channel-adapter.ts`/`alert-adapter.ts`. A guild with no `Guild` row
 * yet just has `/setup` available and nothing else, which is the intended
 * bootstrap state.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Events } from 'discord.js';
import { PrismaClient } from '@prisma/client';
import { createAlertAdapter } from './discord/alert-adapter.js';
import { createDiscordClient, loginDiscordClient } from './discord/client.js';
import { registerCommandsForAllGuilds, registerGuildCommands } from './discord/commands/register.js';
import { registerInteractionHandlers } from './discord/interactions.js';
import { createMatchChannelAdapter } from './discord/match-channel-adapter.js';
import { registerMessageListener } from './discord/message-listener.js';
import { createPlayerNotificationAdapter } from './discord/player-notification-adapter.js';
import { cryptoRandomPort } from './services/ports.js';

process.loadEnvFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env'));

async function main(): Promise<void> {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error('DISCORD_TOKEN is not set in .env');

  const prisma = new PrismaClient();
  const client = createDiscordClient();

  const matchChannel = createMatchChannelAdapter(client, prisma);
  const alert = createAlertAdapter(client, prisma);
  const playerNotification = createPlayerNotificationAdapter(client, prisma);
  registerInteractionHandlers(client, prisma, cryptoRandomPort, matchChannel, alert, playerNotification);
  registerMessageListener(client, prisma, cryptoRandomPort, matchChannel);

  // A guild joined while already running gets its commands the moment it's
  // available — no separate registration script or restart to remember.
  client.on(Events.GuildCreate, (guild) => {
    registerGuildCommands(client, guild.id).catch((err: unknown) => {
      console.error(`[discord] failed to register commands for newly-joined guild ${guild.id}`, err);
    });
  });

  await loginDiscordClient(client, token);
  console.log(`Logged in as ${client.user?.tag}, serving ${client.guilds.cache.size} guild(s)`);

  await registerCommandsForAllGuilds(client);
  console.log('Commands registered. Listening. Ctrl-C to stop.');

  const shutdown = async (): Promise<void> => {
    console.log('Shutting down...');
    client.destroy();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
