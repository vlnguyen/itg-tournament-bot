/**
 * Phase 4 verification harness — long-lived process. NOT shipped bot
 * surface (there's no `/setup` yet to configure a real one).
 *
 * `seed-verification-match.ts` seeds data and exits; interactions need a
 * process that stays connected to actually handle them. Reads the
 * matches/alert channel config from the `Guild` row the seeding script
 * already wrote, so only the guild id is needed here.
 *
 * Usage (from the repo root, after seed-verification-match.ts has run):
 *   npx tsx packages/server/scripts/run-bot.ts --guild <guildId>
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { createAlertAdapter } from '../src/discord/alert-adapter.js';
import { createDiscordClient, loginDiscordClient } from '../src/discord/client.js';
import { registerInteractionHandlers } from '../src/discord/interactions.js';
import { createMatchChannelAdapter } from '../src/discord/match-channel-adapter.js';
import { registerMessageListener } from '../src/discord/message-listener.js';
import { createPlayerNotificationAdapter } from '../src/discord/player-notification-adapter.js';
import { cryptoRandomPort, noopRealtimePort } from '../src/services/ports.js';

process.loadEnvFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env'));

function parseArgs(argv: string[]): { guildId: string } {
  const idx = argv.indexOf('--guild');
  const guildId = idx >= 0 ? argv[idx + 1] : undefined;
  if (!guildId) throw new Error('missing required --guild');
  return { guildId };
}

async function main(): Promise<void> {
  const { guildId } = parseArgs(process.argv.slice(2));
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error('DISCORD_TOKEN is not set in .env');

  const prisma = new PrismaClient();
  const guild = await prisma.guild.findUniqueOrThrow({ where: { id: guildId } });
  if (!guild.matchesChannelId || !guild.alertChannelId || !guild.resultsChannelId) {
    throw new Error(`guild ${guildId} is missing matchesChannelId, alertChannelId, or resultsChannelId`);
  }

  const client = createDiscordClient();
  await loginDiscordClient(client, token);
  console.log(`Logged in as ${client.user?.tag}, serving guild ${guildId}`);

  const matchChannel = createMatchChannelAdapter(client, prisma);
  const alert = createAlertAdapter(client, prisma);
  const playerNotification = createPlayerNotificationAdapter(client, prisma);
  // No websocket gateway here — this dev harness has no web client to
  // broadcast to (see the file header).
  registerInteractionHandlers(client, prisma, cryptoRandomPort, matchChannel, alert, playerNotification, noopRealtimePort);
  registerMessageListener(client, prisma, cryptoRandomPort, matchChannel, noopRealtimePort);

  console.log('Listening for interactions. Ctrl-C to stop.');

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
