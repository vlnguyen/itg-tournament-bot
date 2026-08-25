/**
 * Phase 4 verification harness — NOT shipped bot surface.
 *
 * `/setup`, `/join`, and the tournament lifecycle commands don't exist yet
 * (deferred to later phases), so this is how a real match gets onto a real
 * Discord server for manual verification of the match-thread adapter:
 * seeds a `Guild`/`Tournament`/two entrants/a chart pack directly via
 * Prisma — the same way Phase 3's own tests set up a match — then runs
 * `materializeBracket` and `provisionReadyThreads` against a real bot
 * connection.
 *
 * Usage (from the repo root):
 *   npx tsx packages/server/scripts/seed-verification-match.ts \
 *     --guild <guildId> --matches <channelId> --alerts <channelId> \
 *     --referee-role <roleId> --entrant <userId> --entrant <userId>
 *
 * Requires DISCORD_TOKEN in .env and the bot already invited to the guild
 * with the permissions listed in DESIGN.md's "Required permissions".
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { createDiscordClient, loginDiscordClient } from '../src/discord/client.js';
import { createMatchChannelAdapter } from '../src/discord/match-channel-adapter.js';
import { createPlayerNotificationAdapter } from '../src/discord/player-notification-adapter.js';
import { provisionReadyThreads } from '../src/discord/thread-provisioning.js';
import { materializeBracket } from '../src/services/bracket-service.js';
import { cryptoRandomPort } from '../src/services/ports.js';

process.loadEnvFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env'));

function parseArgs(argv: string[]): {
  guildId: string;
  matchesChannelId: string;
  alertChannelId: string;
  refereeRoleId: string;
  entrantUserIds: string[];
} {
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    const value = argv[i + 1];
    if (!key || value === undefined) throw new Error(`malformed argument at position ${i}: ${argv[i]}`);
    flags.set(key, [...(flags.get(key) ?? []), value]);
  }
  const one = (key: string): string => {
    const v = flags.get(key)?.[0];
    if (!v) throw new Error(`missing required --${key}`);
    return v;
  };
  const entrantUserIds = flags.get('entrant') ?? [];
  if (entrantUserIds.length !== 2) {
    throw new Error(`expected exactly two --entrant flags, got ${entrantUserIds.length}`);
  }
  return {
    guildId: one('guild'),
    matchesChannelId: one('matches'),
    alertChannelId: one('alerts'),
    refereeRoleId: one('referee-role'),
    entrantUserIds,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error('DISCORD_TOKEN is not set in .env');

  const prisma = new PrismaClient();
  const client = createDiscordClient();

  try {
    console.log('Connecting to Discord...');
    await loginDiscordClient(client, token);
    console.log(`Logged in as ${client.user?.tag}`);

    // Resolve real *guild* display names (nickname, if set — never the
    // global username) for a legible thread name, mirroring — not
    // implementing — "the bot resolves each remaining entrant's name as
    // Discord shows it" from DESIGN.md's "Snapshotting the display name".
    // `Entrant.displayName` is itself documented as a snapshot taken at
    // registration; this harness's registration and bracket generation
    // happen back to back, so fetching here doubles as that snapshot.
    const guild = await client.guilds.fetch(args.guildId);
    const members = await Promise.all(args.entrantUserIds.map((id) => guild.members.fetch(id)));

    // Upsert, not create — re-running the harness against the same test
    // server should update the channel/role pointers rather than fail.
    await prisma.guild.upsert({
      where: { id: args.guildId },
      create: {
        id: args.guildId,
        matchesChannelId: args.matchesChannelId,
        alertChannelId: args.alertChannelId,
        refereeRoleId: args.refereeRoleId,
      },
      update: {
        matchesChannelId: args.matchesChannelId,
        alertChannelId: args.alertChannelId,
        refereeRoleId: args.refereeRoleId,
      },
    });

    const tournament = await prisma.tournament.create({
      data: {
        guildId: args.guildId,
        name: `Phase 4 verification ${new Date().toISOString()}`,
        defaultFormatKey: 'bo5-protect-veto',
        config: { perMatchAllocationMinutes: 25 },
        state: 'RUNNING',
      },
    });

    for (const [i, member] of members.entries()) {
      await prisma.entrant.create({
        data: {
          tournamentId: tournament.id,
          discordUserId: member.id,
          displayName: member.displayName,
          seed: i + 1,
          checkedIn: true,
        },
      });
    }

    const packSize = 12;
    for (let i = 0; i < packSize; i++) {
      await prisma.chart.create({
        data: {
          tournamentId: tournament.id,
          title: `Verification Song ${i + 1}`,
          playStyle: 'SINGLE',
          difficulty: 'EXPERT',
          meter: 12 + (i % 6),
        },
      });
    }

    console.log(`Seeded tournament ${tournament.id} with entrants ${members.map((m) => m.displayName).join(', ')}`);

    await materializeBracket(prisma, cryptoRandomPort, tournament.id);
    console.log('Bracket materialized.');

    const matchChannel = createMatchChannelAdapter(
      client,
      prisma,
      args.matchesChannelId,
      args.alertChannelId, // no dedicated results channel for this harness; reused, not posted to yet
    );
    const playerNotification = createPlayerNotificationAdapter(client);
    const threads = await provisionReadyThreads(prisma, matchChannel, playerNotification, tournament.id, '(Test) ');

    console.log(`Provisioned ${threads.length} thread(s):`);
    for (const t of threads) {
      console.log(`  https://discord.com/channels/${args.guildId}/${t.threadId}`);
    }
  } finally {
    await prisma.$disconnect();
    client.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
