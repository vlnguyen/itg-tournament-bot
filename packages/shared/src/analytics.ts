import { z } from 'zod';

/** `GET /api/tournaments/:id/analytics` — `computeTournamentAnalytics`'s output, unchanged, over the wire. Organizer-only. */
export const ChartTally = z.object({
  chartId: z.string().min(1),
  title: z.string(),
  // `vetoedNoPool` is a top-N, but `PoolTally.charts` below never is — a
  // pool row can legitimately be a chart nobody touched, count 0.
  count: z.number().int().nonnegative(),
});
export type ChartTally = z.infer<typeof ChartTally>;

/** One chart's row in a song-pool breakdown — vetoes and picks as two columns on the same chart, not two separate lists. See `PoolTally`'s own comment in `analytics-service.ts`. */
export const PoolChartRow = z.object({
  chartId: z.string().min(1),
  title: z.string(),
  vetoes: z.number().int().nonnegative(),
  picks: z.number().int().nonnegative(),
});
export type PoolChartRow = z.infer<typeof PoolChartRow>;

/** One song pool's full membership — every chart labeled into it, in the pool's own draw order by default (RD1 → RD2 → ... → TB), never truncated to a top N. The web page re-sorts client-side. */
export const PoolTally = z.object({
  formatKey: z.string().min(1),
  charts: z.array(PoolChartRow),
});
export type PoolTally = z.infer<typeof PoolTally>;

export const PlayerTally = z.object({
  entrantId: z.string().min(1),
  displayName: z.string().nullable(),
  protects: z.number().int().nonnegative(),
  vetoes: z.number().int().nonnegative(),
  picks: z.number().int().nonnegative(),
});
export type PlayerTally = z.infer<typeof PlayerTally>;

export const TournamentAnalytics = z.object({
  startedAt: z.string().datetime().nullable(),
  endedAt: z.string().datetime().nullable(),
  elapsedMinutes: z.number().nonnegative().nullable(),
  averageRoundMinutes: z.number().nonnegative().nullable(),
  minMatchMinutes: z.number().nonnegative().nullable(),
  maxMatchMinutes: z.number().nonnegative().nullable(),
  mostProtectedCharts: z.array(ChartTally),
  songPools: z.array(PoolTally),
  vetoedNoPool: z.array(ChartTally),
  perPlayer: z.array(PlayerTally),
});
export type TournamentAnalytics = z.infer<typeof TournamentAnalytics>;
