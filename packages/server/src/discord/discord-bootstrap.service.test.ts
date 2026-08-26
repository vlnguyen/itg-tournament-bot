import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import { DiscordBootstrapService } from './discord-bootstrap.service.js';
import { DISCORD_CLIENT } from './discord.tokens.js';

/**
 * Regression guard for a real bug: an undecorated constructor param mixed
 * with an `@Inject`-decorated one resolves to `undefined` at runtime under
 * this project's esbuild/tsx toolchain, even though `tsc --noEmit` sees
 * nothing wrong and — in this specific ordering — Nest didn't even throw
 * at boot. It just left `prisma` unset, so every Discord command failed
 * with "the application did not respond" instead of a diagnosable startup
 * error. Fixed by making every constructor param an explicit `@Inject`;
 * this test is what would have caught it before a live server did.
 */
describe('DiscordBootstrapService DI wiring', () => {
  it('resolves every constructor dependency to the real provided instance, not undefined', async () => {
    const fakePrisma = { tournament: { findFirst: async () => null } };
    const fakeClient = { on: () => undefined, guilds: { cache: new Map() } };

    const moduleRef = await Test.createTestingModule({
      providers: [
        DiscordBootstrapService,
        { provide: DISCORD_CLIENT, useValue: fakeClient },
        { provide: PrismaService, useValue: fakePrisma },
      ],
    }).compile();

    const service = moduleRef.get(DiscordBootstrapService);
    expect((service as unknown as { client: unknown }).client).toBe(fakeClient);
    expect((service as unknown as { prisma: unknown }).prisma).toBe(fakePrisma);
  });
});
