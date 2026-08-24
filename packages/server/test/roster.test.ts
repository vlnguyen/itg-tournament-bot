import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The roster predicate. Attendance lives on `checkedIn` alone; EntrantStatus
 * records removal and nothing else. See DESIGN.md, "Who is on the roster".
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

describe.skipIf(!reachable)('who is on the roster', () => {
  const guildId = `roster-guild-${Date.now()}`;
  let tournamentId: string;

  beforeAll(async () => {
    await prisma.guild.create({ data: { id: guildId } });
    const t = await prisma.tournament.create({
      data: {
        guildId,
        name: 'roster',
        defaultFormatKey: 'bo5-protect-veto',
        config: {},
        state: 'CHECKIN_CLOSED',
      },
    });
    tournamentId = t.id;

    await prisma.entrant.createMany({
      data: [
        { tournamentId, discordUserId: 'plays', checkedIn: true, status: 'ACTIVE' },
        { tournamentId, discordUserId: 'no-show', checkedIn: false, status: 'ACTIVE' },
        { tournamentId, discordUserId: 'left-early', checkedIn: false, status: 'WITHDRAWN' },
        { tournamentId, discordUserId: 'left-late', checkedIn: true, status: 'WITHDRAWN' },
      ],
    });
  });

  afterAll(async () => {
    await prisma.guild.delete({ where: { id: guildId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  /** The one predicate, valid at any point after check-in closes. */
  const roster = () =>
    prisma.entrant.findMany({
      where: { tournamentId, status: 'ACTIVE', checkedIn: true },
      select: { discordUserId: true },
    });

  it('includes only entrants who checked in and were not withdrawn', async () => {
    expect((await roster()).map((e) => e.discordUserId)).toEqual(['plays']);
  });

  it('keeps both facts for someone who checked in and then withdrew', async () => {
    const e = await prisma.entrant.findFirstOrThrow({
      where: { tournamentId, discordUserId: 'left-late' },
    });
    // checkedIn cannot express withdrawal, and status cannot express attendance.
    expect(e.checkedIn).toBe(true);
    expect(e.status).toBe('WITHDRAWN');
  });

  it('re-checking someone in after the window is a single field flip', async () => {
    await prisma.entrant.update({
      where: { tournamentId_discordUserId: { tournamentId, discordUserId: 'no-show' } },
      data: { checkedIn: true },
    });
    expect((await roster()).map((e) => e.discordUserId).sort()).toEqual(['no-show', 'plays']);
  });

  it('has no status value that could disagree with checkedIn', async () => {
    const { EntrantStatus } = await import('@itg/shared');
    expect(EntrantStatus.options).toEqual(['ACTIVE', 'WITHDRAWN']);
  });
});
