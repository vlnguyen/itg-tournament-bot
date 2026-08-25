import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Proves the two constraints Prisma's schema language cannot express, against
 * a real Postgres. Skipped when no database is reachable, so `npm test` stays
 * green without Docker running. Each test gets its own guild — "one
 * tournament held per guild" is exactly what's under test here, so tests
 * can't share one the way earlier revisions of this file did.
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
  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function makeTournament(guildId: string, name: string, state: 'DRAFT' | 'RUNNING' | 'COMPLETE' | 'CANCELLED') {
    await prisma.guild.upsert({ where: { id: guildId }, create: { id: guildId }, update: {} });
    return prisma.tournament.create({
      data: { guildId, name, defaultFormatKey: 'bo5-protect-veto', config: {}, state },
    });
  }

  async function dropGuild(guildId: string): Promise<void> {
    await prisma.guild.delete({ where: { id: guildId } }).catch(() => undefined);
  }

  it('occupies the slot from the moment it is DRAFT — a second tournament in the same guild is refused', async () => {
    const guildId = `constraints-draft-${Date.now()}`;
    try {
      await makeTournament(guildId, 'draft a', 'DRAFT');
      await expect(makeTournament(guildId, 'draft b', 'DRAFT')).rejects.toThrow();
    } finally {
      await dropGuild(guildId);
    }
  });

  it('allows only one active tournament per guild', async () => {
    const guildId = `constraints-running-${Date.now()}`;
    try {
      await makeTournament(guildId, 'running', 'RUNNING');
      await expect(makeTournament(guildId, 'second running', 'RUNNING')).rejects.toThrow();
    } finally {
      await dropGuild(guildId);
    }
  });

  it('does not count COMPLETE or CANCELLED against the slot', async () => {
    const guildId = `constraints-terminal-${Date.now()}`;
    try {
      await expect(makeTournament(guildId, 'finished', 'COMPLETE')).resolves.toBeDefined();
      await expect(makeTournament(guildId, 'called off', 'CANCELLED')).resolves.toBeDefined();
    } finally {
      await dropGuild(guildId);
    }
  });

  it('lets a whole seed reorder land as one statement', async () => {
    const guildId = `constraints-reorder-${Date.now()}`;
    try {
      const t = await makeTournament(guildId, 'seeding', 'DRAFT');
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
    } finally {
      await dropGuild(guildId);
    }
  });

  it('still rejects a genuine duplicate seed at commit', async () => {
    const guildId = `constraints-dupeseed-${Date.now()}`;
    try {
      const t = await makeTournament(guildId, 'dupes', 'DRAFT');
      await prisma.entrant.create({
        data: { tournamentId: t.id, discordUserId: 'a', seed: 1 },
      });
      await expect(
        prisma.entrant.create({ data: { tournamentId: t.id, discordUserId: 'b', seed: 1 } }),
      ).rejects.toThrow();
    } finally {
      await dropGuild(guildId);
    }
  });

  it('allows many unseeded entrants, because NULLs stay distinct', async () => {
    const guildId = `constraints-unseeded-${Date.now()}`;
    try {
      const t = await makeTournament(guildId, 'unseeded', 'DRAFT');
      await expect(
        prisma.entrant.createMany({
          data: ['x', 'y', 'z'].map((discordUserId) => ({ tournamentId: t.id, discordUserId })),
        }),
      ).resolves.toEqual({ count: 3 });
    } finally {
      await dropGuild(guildId);
    }
  });
});
