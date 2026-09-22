import { describe, expect, it } from 'vitest';
import { computeTournamentAnalytics } from '../src/services/analytics-service.js';
import { materializeBracket } from '../src/services/bracket-service.js';
import { createSongPoolTab, saveSongPoolLabels } from '../src/services/song-pool-service.js';
import { sequentialRandomPort } from '../src/services/ports.js';
import { cleanupTournament, driveToCompletion, isReachable, makeTournament, prisma, type TestTournament } from './support.js';

const HB11 = 'hb11-static-pool';

describe.skipIf(!(await isReachable()))('computeTournamentAnalytics', () => {
  it('returns empty aggregates and no timestamps for a tournament with no matches yet', async () => {
    const t: TestTournament = await makeTournament(`analytics-empty-${Date.now()}`, 0);
    try {
      const analytics = await computeTournamentAnalytics(prisma, t.tournamentId);
      expect(analytics.startedAt).toBeNull();
      expect(analytics.endedAt).toBeNull();
      expect(analytics.elapsedMinutes).toBeNull();
      expect(analytics.averageRoundMinutes).toBeNull();
      expect(analytics.minMatchMinutes).toBeNull();
      expect(analytics.maxMatchMinutes).toBeNull();
      expect(analytics.mostProtectedCharts).toEqual([]);
      expect(analytics.songPools).toEqual([]);
      expect(analytics.vetoedNoPool).toEqual([]);
      expect(analytics.perPlayer).toEqual([]);
    } finally {
      await cleanupTournament(t);
    }
  });

  it('tallies protects/vetoes per chart and per player, and sets endedAt once complete', async () => {
    const t: TestTournament = await makeTournament(`analytics-2p-${Date.now()}`, 2);
    try {
      const random = sequentialRandomPort(t.guildId);
      await materializeBracket(prisma, random, t.tournamentId);
      await driveToCompletion(t.tournamentId, t.entrantIds, random);

      const analytics = await computeTournamentAnalytics(prisma, t.tournamentId);

      // A 2-entrant Bo5-protect-veto match runs its whole sequence — some
      // protects and vetoes exist, attributed to real charts and players.
      // Bo5 has no song pool, so its vetoes land in vetoedNoPool, not songPools.
      expect(analytics.mostProtectedCharts.length).toBeGreaterThan(0);
      expect(analytics.vetoedNoPool.length).toBeGreaterThan(0);
      expect(analytics.songPools).toEqual([]); // Bo5 has no song pool, and never picks
      expect(analytics.mostProtectedCharts[0]!.count).toBeGreaterThan(0);

      expect(analytics.perPlayer).toHaveLength(2);
      const ids = analytics.perPlayer.map((p) => p.entrantId).sort();
      expect(ids).toEqual([...t.entrantIds].sort());
      for (const p of analytics.perPlayer) {
        expect(p.displayName).toBeNull(); // makeTournament never sets one
        expect(p.protects + p.vetoes).toBeGreaterThan(0);
      }

      // driveToCompletion never runs startTournament, so there is no
      // TOURNAMENT_STARTED audit row to find.
      expect(analytics.startedAt).toBeNull();
      expect(analytics.elapsedMinutes).toBeNull(); // nothing to measure from without a start
      expect(analytics.endedAt).not.toBeNull();

      // Exactly one match exists in a 2-entrant tournament, so its own span
      // is both the shortest and the longest — degenerate, but still a real
      // assertion that per-match grouping (not per-round) is what's happening.
      expect(analytics.minMatchMinutes).not.toBeNull();
      expect(analytics.minMatchMinutes).toBe(analytics.maxMatchMinutes);
    } finally {
      await cleanupTournament(t);
    }
  });

  it('reports the shortest and longest match by wall-clock span, distinct from the per-round average', async () => {
    const guildId = `analytics-matchtime-${Date.now()}`;
    await prisma.guild.upsert({ where: { id: guildId }, create: { id: guildId }, update: {} });
    const tournament = await prisma.tournament.create({
      data: { guildId, name: 'Match Time Test', defaultFormatKey: 'bo5-protect-veto', config: {}, state: 'RUNNING' },
    });
    const tournamentId = tournament.id;
    try {
      const short = await prisma.match.create({
        data: { tournamentId, bracket: 'WINNERS', round: 1, slot: 0, formatKey: 'bo5-protect-veto', status: 'COMPLETE' },
      });
      const long = await prisma.match.create({
        data: { tournamentId, bracket: 'WINNERS', round: 1, slot: 1, formatKey: 'bo5-protect-veto', status: 'COMPLETE' },
      });

      const base = new Date('2026-01-01T00:00:00Z');
      const minutes = (n: number) => new Date(base.getTime() + n * 60000);

      // Short match: a 5-minute span. Long match: 20 minutes. Same round,
      // so the round-level average (which spans across both matches at
      // once, since they're concurrent) would report something entirely
      // different from either individual match's own duration.
      await prisma.matchEvent.createMany({
        data: [
          { matchId: short.id, seq: 1, type: 'MATCH_CREATED', payload: {}, createdAt: minutes(0) },
          { matchId: short.id, seq: 2, type: 'WALKOVER', payload: {}, createdAt: minutes(5) },
          { matchId: long.id, seq: 1, type: 'MATCH_CREATED', payload: {}, createdAt: minutes(0) },
          { matchId: long.id, seq: 2, type: 'WALKOVER', payload: {}, createdAt: minutes(20) },
        ],
      });

      const analytics = await computeTournamentAnalytics(prisma, tournamentId);
      expect(analytics.minMatchMinutes).toBe(5);
      expect(analytics.maxMatchMinutes).toBe(20);
      expect(analytics.averageRoundMinutes).toBe(20); // the round's own span covers both matches at once
    } finally {
      await prisma.guild.delete({ where: { id: guildId } }).catch(() => undefined);
    }
  });

  it('groups vetoes and picks into one row per pool chart, ordered by label rather than insertion or count', async () => {
    const guildId = `analytics-pool-${Date.now()}`;
    await prisma.guild.upsert({ where: { id: guildId }, create: { id: guildId }, update: {} });
    const tournament = await prisma.tournament.create({
      data: { guildId, name: 'Pool Analytics Test', defaultFormatKey: HB11, config: {}, state: 'DRAFT' },
    });
    const tournamentId = tournament.id;
    try {
      const charts = [];
      for (let i = 0; i < 3; i++) {
        charts.push(
          await prisma.chart.create({
            data: { tournamentId, title: `Song ${i}`, playStyle: 'SINGLE', difficulty: 'EXPERT', meter: 12 },
          }),
        );
      }
      const [vetoed, picked, untouched] = charts;

      await createSongPoolTab(prisma, tournamentId, HB11, 'to-user');
      // Deliberately out of RD order — the first chart created gets the
      // *last* label, so a passing "default order is the label order, not
      // insertion order" assertion actually proves something.
      await saveSongPoolLabels(prisma, tournamentId, HB11, { [vetoed!.id]: 'RD3', [picked!.id]: 'RD1', [untouched!.id]: 'RD2' }, 'to-user');

      const draw = charts.map((c) => ({ chartId: c.id, title: c.title, poolLabel: null }));
      await prisma.match.create({
        data: {
          tournamentId,
          bracket: 'WINNERS',
          round: 1,
          slot: 0,
          formatKey: HB11,
          status: 'IN_PROGRESS',
          state: {
            seq: 3,
            participants: [{ entrantId: 'p1', seed: 1 }, { entrantId: 'p2', seed: 2 }],
            requirePhotos: true,
            a: 'p1',
            b: 'p2',
            draw,
            protects: [],
            vetoes: [{ drawIndex: 0, by: 'p1' }],
            picks: [{ drawIndex: 1, by: 'p2' }],
            songs: [],
            points: {},
            tiebreaks: [],
            setWinnerSelections: {},
          },
        },
      });

      const analytics = await computeTournamentAnalytics(prisma, tournamentId);

      expect(analytics.songPools).toHaveLength(1);
      const pool = analytics.songPools[0]!;
      expect(pool.formatKey).toBe(HB11);
      // All three labeled charts appear, including the one nobody touched — never a top N.
      expect(pool.charts).toHaveLength(3);
      // RD1 (picked) -> RD2 (untouched) -> RD3 (vetoed), regardless of creation or veto/pick order.
      expect(pool.charts.map((c) => c.chartId)).toEqual([picked!.id, untouched!.id, vetoed!.id]);

      const vetoedRow = pool.charts.find((c) => c.chartId === vetoed!.id)!;
      expect(vetoedRow.vetoes).toBe(1);
      expect(vetoedRow.picks).toBe(0);

      const pickedRow = pool.charts.find((c) => c.chartId === picked!.id)!;
      expect(pickedRow.vetoes).toBe(0);
      expect(pickedRow.picks).toBe(1);

      const untouchedRow = pool.charts.find((c) => c.chartId === untouched!.id)!;
      expect(untouchedRow.vetoes).toBe(0);
      expect(untouchedRow.picks).toBe(0);

      expect(analytics.vetoedNoPool).toEqual([]); // the only match here is a pool format
    } finally {
      await prisma.guild.delete({ where: { id: guildId } }).catch(() => undefined);
    }
  });
});
