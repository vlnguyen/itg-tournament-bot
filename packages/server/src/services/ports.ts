import { randomUUID } from 'node:crypto';
import type { BracketSide } from '@itg/shared';
import type { PublicMatch } from '../domain/projection.js';

/**
 * Seeds a draw. "Randomness is seeded per draw and the seed is stored in the
 * event, so a disputed draw can be shown to have been fair" — see
 * DESIGN.md, "Drawing Charts". This port supplies only the seed string;
 * `domain/rng.ts`'s `makeRng` turns it into the actual shuffle, and is pure.
 */
export interface RandomPort {
  newSeed(): string;
}

export const cryptoRandomPort: RandomPort = {
  newSeed: () => randomUUID(),
};

/** Deterministic seeds for tests: `${prefix}-1`, `${prefix}-2`, ... */
export function sequentialRandomPort(prefix = 'seed'): RandomPort {
  let n = 0;
  return {
    newSeed: () => `${prefix}-${++n}`,
  };
}

/**
 * "Domain services emit an internal event after committing a MatchEvent;
 * RealtimeModule fans it out." See DESIGN.md, "Realtime". Not
 * Discord-specific — the same commit that updates a match thread also
 * needs to reach a browser watching the bracket, so this lives beside
 * `RandomPort` rather than in `discord/ports.ts`. `projection` is always
 * `toPublicMatch`'s output — the one function public data is allowed to
 * flow through, per DESIGN.md, "Public Projections and Hidden State" — the
 * adapter maps it into the shared wire schema at the actual transport
 * boundary, not here.
 */
export interface RealtimeBroadcastPort {
  /**
   * `bracket`/`round` ride along as an intersection, not part of
   * `PublicMatch` itself — they're `Match` row columns, not derived from
   * `MatchState`, so the pure domain projection has no idea they exist any
   * more than it does `displayName`. Every caller already has the `Match`
   * row in hand (that's how it got `format`/`ref` in the first place), so
   * joining them in here costs nothing extra the way a gateway-side DB
   * lookup would.
   */
  publish(tournamentId: string, matchId: string, seq: number, projection: PublicMatch & { bracket: BracketSide; round: number }): void;
  /**
   * "The seeding page is sensitive to real-time roster changes" — a join,
   * check-in, un-check-in, withdrawal, removal, or reorder from *any*
   * surface (a Discord command included) needs to reach a browser with the
   * roster/seeding page open. Unlike `publish`, this carries no payload:
   * a roster row's shape is cheap to refetch in full and there's no
   * `seq`-ordered projection to patch in place the way a match frame has,
   * so the client just invalidates and refetches on receipt — the same
   * "resync by refetch" posture DESIGN.md's Realtime section already uses
   * for reconnection.
   */
  publishRosterChanged(tournamentId: string): void;
  /**
   * A lifecycle transition — open/close registration, open/close check-in,
   * start, cancel, rename — from *any* surface, a Discord command
   * included. Same "no payload, client refetches" shape as
   * `publishRosterChanged`: a `Tournament` row is cheap to refetch whole,
   * and the client needs to re-derive both its own snapshot query and its
   * legal-actions checklist, not patch a field in place.
   */
  publishLifecycleChanged(tournamentId: string): void;
}

/** No-op for tests and any caller that doesn't care about realtime fan-out. */
export const noopRealtimePort: RealtimeBroadcastPort = {
  publish: () => undefined,
  publishRosterChanged: () => undefined,
  publishLifecycleChanged: () => undefined,
};
