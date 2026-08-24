import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Proves the two constraints Prisma's schema language cannot express, against
 * a real Postgres. Skipped when no database is reachable, so `npm test` stays
 * green without Docker running.
 */
const prisma = new PrismaClient();

let reachable = false;
try {
  await prisma.$queryRaw`SELECT 1`;
  reachable = true;
} catch {
  reachable = false;
}

describe.skipIf(!reachable)('constraints added by hand in the initial migration', () => {
  const guildId = `test-guild-${Date.now()}`;

  beforeAll(async () => {
    await prisma.guild.create({ data: { id: guildId } });
  });

  afterAll(async () => {
    await prisma.guild.delete({ where: { id: guildId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  const makeTournament = (name: string, state: 'DRAFT' | 'RUNNING' | 'COMPLETE') =>
    prisma.tournament.create({
      data: { guildId, name, defaultFormatKey: 'bo5-protect-veto', config: {}, state },
    });

  it('allows many DRAFT tournaments in one guild', async () => {
    await expect(makeTournament('draft a', 'DRAFT')).resolves.toBeDefined();
    await expect(makeTournament('draft b', 'DRAFT')).resolves.toBeDefined();
  });

  it('allows only one active tournament per guild', async () => {
    await makeTournament('running', 'RUNNING');
    await expect(makeTournament('second running', 'RUNNING')).rejects.toThrow();
  });

  it('does not count COMPLETE against the active slot', async () => {
    await expect(makeTournament('finished', 'COMPLETE')).resolves.toBeDefined();
  });

  it('lets a whole seed reorder land as one statement', async () => {
    const t = await makeTournament('seeding', 'DRAFT');
    await prisma.entrant.createMany({
      data: [1, 2, 3, 4].map((seed) => ({
        tournamentId: t.id,
        discordUserId: `u${seed}`,
        seed,
      })),
    });

    // A single statement that transiently collides: 1<->2 and 3<->4 swap.
    // Postgres checks unique INDEXES per row within a statement, so this only
    // succeeds because the constraint is DEFERRABLE INITIALLY DEFERRED.
    await expect(
      prisma.$executeRaw`
        UPDATE "Entrant"
           SET "seed" = CASE WHEN "seed" % 2 = 1 THEN "seed" + 1 ELSE "seed" - 1 END
         WHERE "tournamentId" = ${t.id}`,
    ).resolves.toBe(4);

    const seeds = await prisma.entrant.findMany({
      where: { tournamentId: t.id },
      orderBy: { discordUserId: 'asc' },
      select: { discordUserId: true, seed: true },
    });
    expect(seeds.map((e) => e.seed)).toEqual([2, 1, 4, 3]);
  });

  it('still rejects a genuine duplicate seed at commit', async () => {
    const t = await makeTournament('dupes', 'DRAFT');
    await prisma.entrant.create({
      data: { tournamentId: t.id, discordUserId: 'a', seed: 1 },
    });
    await expect(
      prisma.entrant.create({ data: { tournamentId: t.id, discordUserId: 'b', seed: 1 } }),
    ).rejects.toThrow();
  });

  it('allows many unseeded entrants, because NULLs stay distinct', async () => {
    const t = await makeTournament('unseeded', 'DRAFT');
    await expect(
      prisma.entrant.createMany({
        data: ['x', 'y', 'z'].map((discordUserId) => ({ tournamentId: t.id, discordUserId })),
      }),
    ).resolves.toEqual({ count: 3 });
  });
});
