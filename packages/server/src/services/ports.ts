import { randomUUID } from 'node:crypto';
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
  publish(tournamentId: string, matchId: string, seq: number, projection: PublicMatch): void;
}

/** No-op for tests and any caller that doesn't care about realtime fan-out. */
export const noopRealtimePort: RealtimeBroadcastPort = {
  publish: () => undefined,
};
