import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { materializeBracket } from '../src/services/bracket-service.js';
import {
  computeTournamentStandings,
  disqualifyFromTournament,
  estimateDurationMinutes,
} from '../src/services/advancement-service.js';
import { sequentialRandomPort } from '../src/services/ports.js';
import { cleanupTournament, isReachable, makeTournament, playMatchToChampion, prisma, type TestTournament } from './support.js';

describe.skipIf(!(await isReachable()))('advancement-service', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('a full 8-entrant tournament', () => {
    let t: TestTournament;

    beforeAll(async () => {
      t = await makeTournament(`advancement-8-${Date.now()}`, 8, { perMatchAllocationMinutes: 20 });
      const random = sequentialRandomPort(t.guildId);
      await materializeBracket(prisma, random, t.tournamentId);

      const seedOf = new Map(t.entrantIds.map((id, i) => [id, i + 1]));
      // Play every currently-live match, lower seed always wins, until the
      // tournament completes. Deterministic: no tiebreaks, no reset needed,
      // since the winners-bracket champion (seed 1) always wins game 1 of
      // the grand final too.
      for (;;) {
        const tournament = await prisma.tournament.findUniqueOrThrow({ where: { id: t.tournamentId } });
        if (tournament.state === 'COMPLETE') break;
        const live = await prisma.match.findMany({
          where: { tournamentId: t.tournamentId, status: 'IN_PROGRESS' },
          include: { participants: true },
        });
        if (live.length === 0) throw new Error('stalled before completion');
        for (const m of live) {
          const champion = m.participants.reduce((best, p) =>
            seedOf.get(p.entrantId)! < seedOf.get(best.entrantId)! ? p : best,
          ).entrantId;
          await playMatchToChampion(m.id, champion, random);
        }
      }
    });
    afterAll(() => cleanupTournament(t));

    it('never plays a reset game — the winners finalist won game 1', async () => {
      const reset = await prisma.match.findUniqueOrThrow({
        where: { tournamentId_bracket_round_slot: { tournamentId: t.tournamentId, bracket: 'GRAND_FINAL', round: 2, slot: 0 } },
      });
      expect(reset.status).toBe('PENDING');
    });

    it('produces standings with the structural place-group shape a size-8 bracket implies', async () => {
      const standings = await computeTournamentStandings(prisma, t.tournamentId);
      expect(standings).toHaveLength(8);
      expect(new Set(standings.map((s) => s.entrantId)).size).toBe(8);
      // 1st, 2nd, 3rd, 4th each alone; 5th and 7th each shared by two —
      // fixed by the losers-bracket round shape, independent of who wins.
      expect(standings.map((s) => s.place).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 5, 7, 7]);
      expect(standings.find((s) => s.place === 1)!.entrantId).toBe(t.entrantIds[0]); // seed 1 never lost
    });

    it('estimates duration from the bracket depth and the configured per-match allocation', async () => {
      const minutes = await estimateDurationMinutes(prisma, t.tournamentId);
      // size 8 -> 2*ceil(log2(8))+1 = 7 rounds on the critical path, at 20 min each.
      expect(minutes).toBe(7 * 20);
    });
  });

  describe('tournament-scope disqualification', () => {
    it('forfeits a live match and advances the opponent', async () => {
      const t = await makeTournament(`advancement-dq-a-${Date.now()}`, 4);
      const random = sequentialRandomPort(t.guildId);
      await materializeBracket(prisma, random, t.tournamentId);
      const m = await prisma.match.findUniqueOrThrow({
        where: { tournamentId_bracket_round_slot: { tournamentId: t.tournamentId, bracket: 'WINNERS', round: 1, slot: 0 } },
        include: { participants: true },
      });
      const [dqd, survivor] = m.participants.map((p) => p.entrantId);

      await disqualifyFromTournament(prisma, random, t.tournamentId, dqd!, 'referee-1');

      const resolved = await prisma.match.findUniqueOrThrow({ where: { id: m.id } });
      expect(resolved.status).toBe('COMPLETE');
      expect(resolved.winnerId).toBe(survivor);

      const entrant = await prisma.entrant.findUniqueOrThrow({ where: { id: dqd! } });
      expect(entrant.status).toBe('WITHDRAWN');

      const nextRound = await prisma.match.findUniqueOrThrow({
        where: { tournamentId_bracket_round_slot: { tournamentId: t.tournamentId, bracket: 'WINNERS', round: 2, slot: 0 } },
        include: { participants: true },
      });
      expect(nextRound.participants.map((p) => p.entrantId)).toContain(survivor);
      await cleanupTournament(t);
    });

    it('auto-walks over a not-yet-started match once its second seat fills, lazily', async () => {
      const t = await makeTournament(`advancement-dq-b-${Date.now()}`, 4);
      const random = sequentialRandomPort(t.guildId);
      await materializeBracket(prisma, random, t.tournamentId);

      const m0 = await prisma.match.findUniqueOrThrow({
        where: { tournamentId_bracket_round_slot: { tournamentId: t.tournamentId, bracket: 'WINNERS', round: 1, slot: 0 } },
        include: { participants: true },
      });
      const m1 = await prisma.match.findUniqueOrThrow({
        where: { tournamentId_bracket_round_slot: { tournamentId: t.tournamentId, bracket: 'WINNERS', round: 1, slot: 1 } },
        include: { participants: true },
      });

      // m0's winner is seated into WR2 first, with no opponent yet.
      const m0Winner = m0.participants[0]!.entrantId;
      await playMatchToChampion(m0.id, m0Winner, random);

      const wr2 = await prisma.match.findUniqueOrThrow({
        where: { tournamentId_bracket_round_slot: { tournamentId: t.tournamentId, bracket: 'WINNERS', round: 2, slot: 0 } },
      });
      expect(wr2.status).toBe('PENDING'); // only one seat filled — not started

      // DQ that seated-but-not-yet-opposed winner. Nothing to resolve yet:
      // they have no live match (WR1 is already COMPLETE) and WR2 isn't
      // seated with two, so nothing fires immediately.
      await disqualifyFromTournament(prisma, random, t.tournamentId, m0Winner, 'referee-1');
      const stillPending = await prisma.match.findUniqueOrThrow({ where: { id: wr2.id } });
      expect(stillPending.status).toBe('PENDING');

      // Now the other WR1 match completes, filling WR2's second seat. The
      // fill itself must notice the withdrawal and walk over immediately,
      // rather than starting a real match.
      const m1Winner = m1.participants[0]!.entrantId;
      await playMatchToChampion(m1.id, m1Winner, random);

      const resolvedWr2 = await prisma.match.findUniqueOrThrow({ where: { id: wr2.id }, include: { events: true } });
      expect(resolvedWr2.status).toBe('COMPLETE');
      expect(resolvedWr2.winnerId).toBe(m1Winner);
      expect(resolvedWr2.events.map((e) => e.type)).toEqual(['MATCH_CREATED', 'WALKOVER']);
      await cleanupTournament(t);
    });
  });
});
