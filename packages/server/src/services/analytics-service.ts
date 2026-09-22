import type { PrismaClient } from '@prisma/client';
import { FORMAT_SONG_LABELS, FORMAT_STATIC_SONG_POOL, type FormatKey } from '@itg/shared';
import type { EntrantId, MatchState } from '../domain/types.js';

export interface ChartTally {
  chartId: string;
  title: string;
  count: number;
}

export interface PoolChartRow {
  chartId: string;
  title: string;
  /** The assigned pool label (RD1, FT2, TB, ...) — what `charts`' default order is sorted by, not exposed as its own column since the chart title already implies it via row order. */
  label: string;
  vetoes: number;
  picks: number;
}

export interface PoolTally {
  formatKey: string;
  /** Every chart labeled into this pool, counts included even at zero, in the pool's own draw order (RD1 → RD2 → ... → TB) by default — never truncated to a top N. The web page re-sorts client-side; this is only the initial order. */
  charts: PoolChartRow[];
}

function isPoolFormat(formatKey: string): boolean {
  return FORMAT_STATIC_SONG_POOL[formatKey as FormatKey] === true;
}

export interface PlayerTally {
  entrantId: EntrantId;
  displayName: string | null;
  protects: number;
  vetoes: number;
  picks: number;
}

export interface TournamentAnalytics {
  /** From the `AuditLog` row `tournament-service.ts`'s `startTournament` writes — `null` if the tournament never started. */
  startedAt: Date | null;
  /** The timestamp of whichever `MatchEvent` decided the tournament — `MAX(MatchEvent.createdAt)`, since nothing more gets appended after completion. `null` until `COMPLETE`. */
  endedAt: Date | null;
  /** `endedAt - startedAt`, or `now - startedAt` while still running. `null` without a `startedAt` to measure from. */
  elapsedMinutes: number | null;
  /**
   * Each round's wall-clock span (`max(createdAt) - min(createdAt)` across
   * every match in that round), averaged across every round with more than
   * one event. `null` if there's nothing to average yet. This is one
   * reasonable reading of "average time per round" — the alternative,
   * "average time per match," is a different number; ask if this isn't the
   * one wanted.
   */
  averageRoundMinutes: number | null;
  /** The shortest single match's wall-clock span (`max(createdAt) - min(createdAt)` across that match's own events) — distinct from `averageRoundMinutes`, which spans a whole round's matches, possibly running in parallel. `null` if no match has more than one event yet. */
  minMatchMinutes: number | null;
  /** The longest single match's wall-clock span — same basis as `minMatchMinutes`. */
  maxMatchMinutes: number | null;
  /** Not pool-scoped — a protect-veto match draws randomly from the whole imported pack, so there's no fixed pool to enumerate; this stays a top-10. */
  mostProtectedCharts: ChartTally[];
  /** One entry per song pool actually in play (static-pool formats only) — vetoes and picks as two columns on the same chart list, rather than two separate breakdowns. */
  songPools: PoolTally[];
  /** Vetoes from a non-pool (protect-veto) format, if any — no pool to group by, so this stays a top-10 the same way `mostProtectedCharts` does. Never has picks — protect-veto formats don't pick. */
  vetoedNoPool: ChartTally[];
  perPlayer: PlayerTally[];
}

function bumpChart(tallies: Map<string, ChartTally>, chartId: string | undefined, title: string | undefined): void {
  if (!chartId) return;
  const existing = tallies.get(chartId);
  if (existing) existing.count++;
  else tallies.set(chartId, { chartId, title: title ?? chartId, count: 1 });
}

function bumpPlayer(tallies: Map<EntrantId, PlayerTally>, entrantId: EntrantId, field: 'protects' | 'vetoes' | 'picks'): void {
  const existing = tallies.get(entrantId) ?? { entrantId, displayName: null, protects: 0, vetoes: 0, picks: 0 };
  existing[field]++;
  tallies.set(entrantId, existing);
}

function topByCount(tallies: Map<string, ChartTally>, limit = 10): ChartTally[] {
  return [...tallies.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

/**
 * Merges actual veto/pick tallies onto `poolMembers` (every chart actually
 * labeled into each pool, per `ChartLabel`, carrying its assigned label) —
 * the merge, not the tally, is what guarantees a chart that was never
 * vetoed/picked still shows up at count 0, and that nothing gets truncated
 * to a top N. Only static-pool formats produce an entry — a protect-veto
 * format's vetoes have their own, non-pool handling (`vetoedNoPool`), and
 * it never picks at all.
 *
 * Default row order is the pool's own draw order (`FORMAT_SONG_LABELS`,
 * e.g. RD1 → RD2 → ... → TB) — "the display order," same convention
 * `song-pool-filter.ts`'s `sortByLabelOrder` uses for the web pack view's
 * locked pool tab. The web page re-sorts client-side from there; this is
 * only the order it starts in.
 */
function mergeByPool(
  poolMembers: Map<string, Map<string, PoolChartRow>>,
  vetoTalliesByFormat: Map<string, Map<string, ChartTally>>,
  pickTalliesByFormat: Map<string, Map<string, ChartTally>>,
): PoolTally[] {
  const formatKeys = new Set([...poolMembers.keys(), ...vetoTalliesByFormat.keys(), ...pickTalliesByFormat.keys()].filter(isPoolFormat));
  return [...formatKeys]
    .map((formatKey) => {
      const charts = new Map(poolMembers.get(formatKey) ?? []);
      for (const [chartId, tally] of vetoTalliesByFormat.get(formatKey) ?? []) {
        const row = charts.get(chartId);
        if (row) row.vetoes = tally.count;
        else charts.set(chartId, { chartId, title: tally.title, label: '', vetoes: tally.count, picks: 0 });
      }
      for (const [chartId, tally] of pickTalliesByFormat.get(formatKey) ?? []) {
        const row = charts.get(chartId);
        if (row) row.picks = tally.count;
        else charts.set(chartId, { chartId, title: tally.title, label: '', vetoes: 0, picks: tally.count });
      }
      const requiredLabels = FORMAT_SONG_LABELS[formatKey as FormatKey] ?? [];
      const labelIndex = (label: string): number => {
        const i = requiredLabels.indexOf(label);
        return i === -1 ? requiredLabels.length : i;
      };
      const sorted = [...charts.values()].sort((a, b) => labelIndex(a.label) - labelIndex(b.label) || a.title.localeCompare(b.title));
      return { formatKey, charts: sorted };
    })
    .sort((a, b) => a.formatKey.localeCompare(b.formatKey));
}

/**
 * Post-event aggregates for TOs — protect/veto/pick patterns across the
 * whole tournament, plus start/end/average-round-time. Read-only, no
 * interaction with live match state. Reads each match's cached
 * `state.protects/vetoes/picks` (cheap, sufficient for aggregate counts)
 * rather than replaying the full `MatchEvent` history — the timing figures
 * are the one place raw `MatchEvent` timestamps are actually needed, since
 * the cached state carries no chronology.
 */
export async function computeTournamentAnalytics(prisma: PrismaClient, tournamentId: string): Promise<TournamentAnalytics> {
  const matches = await prisma.match.findMany({ where: { tournamentId }, select: { state: true, formatKey: true } });

  const protectTallies = new Map<string, ChartTally>();
  const vetoTalliesByFormat = new Map<string, Map<string, ChartTally>>();
  const pickTalliesByFormat = new Map<string, Map<string, ChartTally>>();
  const playerTallies = new Map<EntrantId, PlayerTally>();

  for (const m of matches) {
    const state = m.state as unknown as MatchState | null;
    if (!state) continue;
    for (const p of state.protects) {
      bumpChart(protectTallies, state.draw[p.drawIndex]?.chartId, state.draw[p.drawIndex]?.title);
      bumpPlayer(playerTallies, p.by, 'protects');
    }
    for (const v of state.vetoes) {
      const byFormat = vetoTalliesByFormat.get(m.formatKey) ?? new Map<string, ChartTally>();
      bumpChart(byFormat, state.draw[v.drawIndex]?.chartId, state.draw[v.drawIndex]?.title);
      vetoTalliesByFormat.set(m.formatKey, byFormat);
      bumpPlayer(playerTallies, v.by, 'vetoes');
    }
    for (const pk of state.picks) {
      const byFormat = pickTalliesByFormat.get(m.formatKey) ?? new Map<string, ChartTally>();
      bumpChart(byFormat, state.draw[pk.drawIndex]?.chartId, state.draw[pk.drawIndex]?.title);
      pickTalliesByFormat.set(m.formatKey, byFormat);
      bumpPlayer(playerTallies, pk.by, 'picks');
    }
  }

  // Every chart actually labeled into a pool, per format — the source of
  // "all songs in a pool," independent of whether this tournament's play
  // ever touched them.
  const labels = await prisma.chartLabel.findMany({ where: { tournamentId }, include: { chart: { select: { title: true } } } });
  const poolMembers = new Map<string, Map<string, PoolChartRow>>();
  for (const l of labels) {
    const pool = poolMembers.get(l.formatKey) ?? new Map<string, PoolChartRow>();
    if (!pool.has(l.chartId)) pool.set(l.chartId, { chartId: l.chartId, title: l.chart.title, label: l.label, vetoes: 0, picks: 0 });
    poolMembers.set(l.formatKey, pool);
  }

  const songPools = mergeByPool(poolMembers, vetoTalliesByFormat, pickTalliesByFormat);

  const vetoedNoPoolMap = new Map<string, ChartTally>();
  for (const [formatKey, tallies] of vetoTalliesByFormat) {
    if (isPoolFormat(formatKey)) continue;
    for (const tally of tallies.values()) {
      const existing = vetoedNoPoolMap.get(tally.chartId);
      if (existing) existing.count += tally.count;
      else vetoedNoPoolMap.set(tally.chartId, { ...tally });
    }
  }
  const vetoedNoPool = topByCount(vetoedNoPoolMap);

  const entrants = await prisma.entrant.findMany({ where: { tournamentId }, select: { id: true, displayName: true } });
  const nameById = new Map(entrants.map((e) => [e.id, e.displayName]));
  for (const p of playerTallies.values()) p.displayName = nameById.get(p.entrantId) ?? null;

  const startedLog = await prisma.auditLog.findFirst({
    where: { action: 'TOURNAMENT_STARTED', targetType: 'Tournament', targetId: tournamentId },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
  });

  const tournament = await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId }, select: { state: true } });
  const events = await prisma.matchEvent.findMany({
    where: { match: { tournamentId } },
    select: { createdAt: true, matchId: true, match: { select: { bracket: true, round: true } } },
  });

  let endedAt: Date | null = null;
  if (tournament.state === 'COMPLETE') {
    for (const e of events) {
      if (!endedAt || e.createdAt > endedAt) endedAt = e.createdAt;
    }
  }

  const roundSpans = new Map<string, { min: Date; max: Date }>();
  for (const e of events) {
    const key = `${e.match.bracket}:${e.match.round}`;
    const span = roundSpans.get(key);
    if (!span) {
      roundSpans.set(key, { min: e.createdAt, max: e.createdAt });
    } else {
      if (e.createdAt < span.min) span.min = e.createdAt;
      if (e.createdAt > span.max) span.max = e.createdAt;
    }
  }
  const roundMinutes = [...roundSpans.values()]
    .map((s) => (s.max.getTime() - s.min.getTime()) / 60000)
    .filter((minutes) => minutes > 0);
  const averageRoundMinutes = roundMinutes.length > 0 ? roundMinutes.reduce((a, b) => a + b, 0) / roundMinutes.length : null;

  const matchSpans = new Map<string, { min: Date; max: Date }>();
  for (const e of events) {
    const span = matchSpans.get(e.matchId);
    if (!span) {
      matchSpans.set(e.matchId, { min: e.createdAt, max: e.createdAt });
    } else {
      if (e.createdAt < span.min) span.min = e.createdAt;
      if (e.createdAt > span.max) span.max = e.createdAt;
    }
  }
  const matchMinutes = [...matchSpans.values()]
    .map((s) => (s.max.getTime() - s.min.getTime()) / 60000)
    .filter((minutes) => minutes > 0);
  const minMatchMinutes = matchMinutes.length > 0 ? Math.min(...matchMinutes) : null;
  const maxMatchMinutes = matchMinutes.length > 0 ? Math.max(...matchMinutes) : null;

  const startedAt = startedLog?.createdAt ?? null;
  const elapsedMinutes = startedAt ? ((endedAt ?? new Date()).getTime() - startedAt.getTime()) / 60000 : null;

  return {
    startedAt,
    endedAt,
    elapsedMinutes,
    averageRoundMinutes,
    minMatchMinutes,
    maxMatchMinutes,
    mostProtectedCharts: topByCount(protectTallies),
    songPools,
    vetoedNoPool,
    perPlayer: [...playerTallies.values()],
  };
}
