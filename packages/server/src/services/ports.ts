import { randomUUID } from 'node:crypto';

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
