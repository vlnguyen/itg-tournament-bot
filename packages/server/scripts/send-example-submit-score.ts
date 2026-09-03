/**
 * One-off: DM a live example of the "submit score" state message (the
 * dialog that waits for each player to post their EX% and a photo), so it
 * can be eyeballed without running a full match.
 *
 * Builds a `MatchState` with `MatchDriver` (same fixture the domain tests
 * use) up through Protect/Veto, then renders it exactly the way the bot
 * would via `renderStateMessage` — no copy of that logic here.
 *
 * Usage (from the repo root):
 *   npx tsx packages/server/scripts/send-example-submit-score.ts [--user <userId>]
 *
 * Requires DISCORD_TOKEN in .env. The recipient must share a server with
 * the bot and allow DMs from server members.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createDiscordClient, loginDiscordClient } from '../src/discord/client.js';
import { renderStateMessage } from '../src/discord/state-message.js';
import { MatchDriver } from '../src/domain/testkit.js';

process.loadEnvFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env'));

const DEFAULT_USER_ID = '95626481656410112';

function parseUserId(argv: string[]): string {
  const i = argv.indexOf('--user');
  return i === -1 ? DEFAULT_USER_ID : argv[i + 1] ?? DEFAULT_USER_ID;
}

async function main(): Promise<void> {
  const userId = parseUserId(process.argv.slice(2));
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error('DISCORD_TOKEN is not set in .env');

  const client = createDiscordClient();

  try {
    console.log('Connecting to Discord...');
    await loginDiscordClient(client, token);
    console.log(`Logged in as ${client.user?.tag}`);

    const driver = new MatchDriver().create('entrant-a', 'entrant-b').chooseSeed('FIRST').runProtectVeto();
    if (driver.pending.kind !== 'SUBMIT_SCORE') {
      throw new Error(`expected SUBMIT_SCORE after Protect/Veto, got ${driver.pending.kind}`);
    }

    const players = new Map([
      ['entrant-a', { discordUserId: '111111111111111111', displayName: 'Alice' }],
      ['entrant-b', { discordUserId: '222222222222222222', displayName: 'Bob' }],
    ]);

    const rendered = renderStateMessage('example-match', driver.pending, driver.state, players);

    const user = await client.users.fetch(userId);
    await user.send(rendered);
    console.log(`Sent example submit-score message to user ${userId}`);
  } finally {
    client.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
