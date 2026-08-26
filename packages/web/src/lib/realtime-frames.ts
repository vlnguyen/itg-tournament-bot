import { deriveBracketMatch } from '@itg/shared';
import type { PublicMatch, RealtimeFrame, TournamentSnapshot } from '@itg/shared';

/**
 * "Each frame carries `{ matchId, seq, projection }`... dropping any whose
 * `seq` is not greater than what it holds." See DESIGN.md, "Realtime".
 * Pure so it's testable without a socket or a query client in the loop —
 * the actual TanStack Query wiring (`hooks/use-realtime-tournament.ts`) is
 * a thin shell around this.
 *
 * The comparison always reads `seq` off whatever is *currently cached*
 * (`PublicMatch.seq`/`BracketMatch.seq`) rather than a side-tracked value —
 * a REST refetch (`refetchOnReconnect`) naturally re-seeds the baseline
 * this way, with no separate bookkeeping to keep in sync with it.
 */
export function shouldApplyFrame(cachedSeq: number | undefined, frameSeq: number): boolean {
  return cachedSeq === undefined || frameSeq > cachedSeq;
}

/**
 * Patches one match's cell in a tournament snapshot from a frame's
 * `PublicMatch`, narrowed the same way the server's own `toBracketMatch`
 * would. Returns the same object reference — safe to pass straight to
 * `setQueryData` — when there's nothing to do: the frame's match isn't in
 * this snapshot (every match is pre-materialized at bracket generation, so
 * this is defensive rather than expected), or the frame is stale.
 */
export function applyFrameToSnapshot(snapshot: TournamentSnapshot, frame: RealtimeFrame): TournamentSnapshot {
  const index = snapshot.matches.findIndex((m) => m.id === frame.matchId);
  if (index === -1) return snapshot;
  if (!shouldApplyFrame(snapshot.matches[index]!.match.seq, frame.seq)) return snapshot;

  const matches = [...snapshot.matches];
  matches[index] = { ...matches[index]!, match: deriveBracketMatch(frame.projection) };
  return { ...snapshot, matches };
}

/** Same staleness check, for the per-match detail cache — the projection itself is already the full wire shape, nothing to narrow. */
export function applyFrameToMatchDetail(current: PublicMatch | undefined, frame: RealtimeFrame): PublicMatch | undefined {
  if (current && !shouldApplyFrame(current.seq, frame.seq)) return current;
  return frame.projection;
}
