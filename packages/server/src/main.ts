/**
 * The real bot entrypoint — supersedes `scripts/run-bot.ts` for actual use.
 * That script and `scripts/seed-verification-match.ts` remain as dev/testing
 * conveniences (the latter is still useful for seeding a chart pack into a
 * tournament, since real pack import doesn't exist yet); this is what a
 * deployment actually runs.
 *
 * NestJS bootstrap only — the discord.js wiring itself lives in
 * `DiscordModule`/`DiscordBootstrapService`, unchanged from before Nest was
 * introduced. `app.listen(port)` opens an HTTP server with no routes yet;
 * the web client's API and static build attach to this same process in a
 * later step.
 */
import 'reflect-metadata';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

process.loadEnvFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env'));

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`Listening on port ${port}. Ctrl-C to stop.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
