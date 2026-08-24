import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Exercises the participation model. A match holds participants rather than a
 * player A and a player B — see DESIGN.md, "Seating more than two players".
 * Skipped when no database is reachable.
 */
const prisma = new PrismaClient();

let reachable = false;
try {
  await prisma.$queryRaw`SELECT 1`;
  reachable = true;
} catch {
  reachable = false;
}

describe.skipIf(!reachable)('match participation', () => {
  const guildId = `participation-guild-${Date.now()}`;
  let tournamentId: string;
  const entrantIds: string[] = [];

  beforeAll(async () => {
    await prisma.guild.create({ data: { id: guildId } });
    const t = await prisma.tournament.create({
      data: {
        guildId,
        name: 'participation',
        defaultFormatKey: 'bo5-protect-veto',
        config: {},
        state: 'DRAFT',
      },
    });
    tournamentId = t.id;
    for (let i = 0; i < 4; i++) {
      const e = await prisma.entrant.create({
        data: { tournamentId, discordUserId: `p${i}`, seed: i + 1 },
      });
      entrantIds.push(e.id);
    }
  });

  afterAll(async () => {
    await prisma.guild.delete({ where: { id: guildId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  let nextSlot = 0;
  const makeMatch = () =>
    prisma.match.create({
      data: {
        tournamentId,
        bracket: 'WINNERS',
        round: 1,
        slot: nextSlot++,
        formatKey: 'bo5-protect-veto',
      },
    });

  it('a materialized match starts with no participants', async () => {
    const m = await makeMatch();
    await expect(
      prisma.matchParticipant.count({ where: { matchId: m.id } }),
    ).resolves.toBe(0);
  });

  it('seats two competitors in distinct slots', async () => {
    const m = await makeMatch();
    await prisma.matchParticipant.createMany({
      data: [
        { matchId: m.id, entrantId: entrantIds[0]!, slot: 0 },
        { matchId: m.id, entrantId: entrantIds[1]!, slot: 1 },
      ],
    });
    const seated = await prisma.matchParticipant.findMany({
      where: { matchId: m.id },
      orderBy: { slot: 'asc' },
    });
    expect(seated.map((p) => p.entrantId)).toEqual([entrantIds[0], entrantIds[1]]);
    expect(seated.every((p) => p.points === 0 && p.place === null)).toBe(true);
  });

  it('rejects two participants in the same slot', async () => {
    const m = await makeMatch();
    await prisma.matchParticipant.create({
      data: { matchId: m.id, entrantId: entrantIds[0]!, slot: 0 },
    });
    await expect(
      prisma.matchParticipant.create({
        data: { matchId: m.id, entrantId: entrantIds[1]!, slot: 0 },
      }),
    ).rejects.toThrow();
  });

  it('rejects the same entrant seated twice in one match', async () => {
    const m = await makeMatch();
    await prisma.matchParticipant.create({
      data: { matchId: m.id, entrantId: entrantIds[0]!, slot: 0 },
    });
    await expect(
      prisma.matchParticipant.create({
        data: { matchId: m.id, entrantId: entrantIds[0]!, slot: 1 },
      }),
    ).rejects.toThrow();
  });

  it('structurally permits more than two, which is the point of the join table', async () => {
    const m = await makeMatch();
    await expect(
      prisma.matchParticipant.createMany({
        data: entrantIds.map((entrantId, slot) => ({ matchId: m.id, entrantId, slot })),
      }),
    ).resolves.toEqual({ count: 4 });
  });

  it('records placement and points per participant', async () => {
    const m = await makeMatch();
    await prisma.matchParticipant.createMany({
      data: [
        { matchId: m.id, entrantId: entrantIds[0]!, slot: 0, points: 3, place: 1 },
        { matchId: m.id, entrantId: entrantIds[1]!, slot: 1, points: 1, place: 2 },
      ],
    });
    await prisma.match.update({
      where: { id: m.id },
      data: { winnerId: entrantIds[0]!, status: 'COMPLETE' },
    });

    const winner = await prisma.matchParticipant.findFirst({
      where: { matchId: m.id, place: 1 },
    });
    const match = await prisma.match.findUniqueOrThrow({ where: { id: m.id } });
    // winnerId is a cache of place 1; the two must agree.
    expect(winner?.entrantId).toBe(match.winnerId);
    expect(winner?.points).toBe(3);
  });

  it('drops participation when the match is deleted', async () => {
    const m = await makeMatch();
    await prisma.matchParticipant.create({
      data: { matchId: m.id, entrantId: entrantIds[0]!, slot: 0 },
    });
    await prisma.match.delete({ where: { id: m.id } });
    await expect(
      prisma.matchParticipant.count({ where: { matchId: m.id } }),
    ).resolves.toBe(0);
  });
});
