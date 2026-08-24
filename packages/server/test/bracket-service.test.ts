import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateBracket } from '../src/domain/bracket.js';
import { materializeBracket } from '../src/services/bracket-service.js';
import { sequentialRandomPort } from '../src/services/ports.js';
import { cleanupTournament, isReachable, makeTournament, prisma, type TestTournament } from './support.js';

/**
 * "The whole bracket is materialized up front, byes included." See
 * DESIGN.md, "Bracket Generation" and "Advancement, Walkovers, and
 * Standings". Skipped when no database is reachable.
 */
describe.skipIf(!(await isReachable()))('bracket materialization', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('a field with no byes (8 entrants)', () => {
    let t: TestTournament;

    beforeAll(async () => {
      t = await makeTournament(`bracket-8-${Date.now()}`, 8);
      await materializeBracket(prisma, sequentialRandomPort('t1'), t.tournamentId);
    });
    afterAll(() => cleanupTournament(t));

    it('creates every match in the generated graph', async () => {
      const matches = await prisma.match.findMany({ where: { tournamentId: t.tournamentId } });
      expect(matches).toHaveLength(generateBracket(8).matches.length);
    });

    it('starts every round-1 match immediately, both real entrants seated', async () => {
      const round1 = await prisma.match.findMany({
        where: { tournamentId: t.tournamentId, bracket: 'WINNERS', round: 1 },
        include: { participants: true },
      });
      expect(round1).toHaveLength(4);
      for (const m of round1) {
        expect(m.status).toBe('IN_PROGRESS');
        expect(m.participants).toHaveLength(2);
      }
    });

    it('leaves every later round unseated', async () => {
      const later = await prisma.match.findMany({
        where: { tournamentId: t.tournamentId, NOT: { bracket: 'WINNERS', round: 1 } },
        include: { participants: true },
      });
      for (const m of later) {
        expect(m.status).toBe('PENDING');
        expect(m.participants).toHaveLength(0);
      }
    });
  });

  describe('a field with byes that cascade into a real match (5 entrants)', () => {
    let t: TestTournament;

    beforeAll(async () => {
      t = await makeTournament(`bracket-5-${Date.now()}`, 5);
      await materializeBracket(prisma, sequentialRandomPort('t2'), t.tournamentId);
    });
    afterAll(() => cleanupTournament(t));

    // seedOrder(8) = [1,8,4,5,2,7,3,6]; entrantCount 5 -> seeds 6,7,8 are byes.
    // WR1: M0=1v8(bye), M1=4v5(real), M2=2v7(bye), M3=3v6(bye).
    // WR2 slot1 sources winnerOf(M2), winnerOf(M3) -> both already known from
    // byes alone, so it must auto-start without anyone touching it.
    const seedEntrant = (t: TestTournament, seed: number) => t.entrantIds[seed - 1]!;

    it('resolves a bye as a walkover with no thread-worthy match ever starting', async () => {
      const m0 = await prisma.match.findUniqueOrThrow({
        where: { tournamentId_bracket_round_slot: { tournamentId: t.tournamentId, bracket: 'WINNERS', round: 1, slot: 0 } },
        include: { events: true, participants: true },
      });
      expect(m0.status).toBe('COMPLETE');
      expect(m0.winnerId).toBe(seedEntrant(t, 1));
      expect(m0.participants).toHaveLength(1);
      expect(m0.events.map((e) => e.type)).toEqual(['MATCH_CREATED', 'WALKOVER']);
    });

    it('leaves the real round-1 pairing actually in progress', async () => {
      const m1 = await prisma.match.findUniqueOrThrow({
        where: { tournamentId_bracket_round_slot: { tournamentId: t.tournamentId, bracket: 'WINNERS', round: 1, slot: 1 } },
        include: { participants: true },
      });
      expect(m1.status).toBe('IN_PROGRESS');
      expect(m1.participants.map((p) => p.entrantId).sort()).toEqual(
        [seedEntrant(t, 4), seedEntrant(t, 5)].sort(),
      );
    });

    it('seats the winners-round-2 slot waiting on the real match with just its bye winner', async () => {
      const wr2s0 = await prisma.match.findUniqueOrThrow({
        where: { tournamentId_bracket_round_slot: { tournamentId: t.tournamentId, bracket: 'WINNERS', round: 2, slot: 0 } },
        include: { participants: true },
      });
      expect(wr2s0.status).toBe('PENDING');
      expect(wr2s0.participants).toHaveLength(1);
      expect(wr2s0.participants[0]!.entrantId).toBe(seedEntrant(t, 1));
    });

    it('cascades two byes straight into a real, auto-started round-2 match', async () => {
      const wr2s1 = await prisma.match.findUniqueOrThrow({
        where: { tournamentId_bracket_round_slot: { tournamentId: t.tournamentId, bracket: 'WINNERS', round: 2, slot: 1 } },
        include: { participants: true, events: true },
      });
      expect(wr2s1.status).toBe('IN_PROGRESS');
      expect(wr2s1.participants.map((p) => p.entrantId).sort()).toEqual(
        [seedEntrant(t, 2), seedEntrant(t, 3)].sort(),
      );
      expect(wr2s1.events.map((e) => e.type)).toEqual(['MATCH_CREATED', 'DRAW_MADE']);
    });
  });
});
