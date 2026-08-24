import { makeRng } from './rng.js';

/**
 * The one rule governing every draw the bot makes — the initial Draw and every
 * tiebreak draw alike.
 *
 *   1. Draw uniformly at random from the eligible charts in the pack.
 *   2. If more are needed than remain eligible, take all the remaining ones,
 *      make every chart in the pack eligible again, and continue.
 *
 * Exhaustion is normal behaviour rather than an error: a pack of four still
 * produces a seven-chart Draw, it simply contains duplicates.
 *
 * Two properties this deliberately has:
 *
 * - **Draws are independent.** Playing a chart does not consume it. There is no
 *   state here beyond the arguments, so nothing accumulates between draws and
 *   what one match drew has no bearing on another. The only memory anywhere is
 *   the caller's `eligible` predicate, which a tiebreak uses to exclude charts
 *   already drawn *in that match*.
 * - **After a reset the predicate is discarded.** "Every chart in the pack
 *   eligible again" means exactly that, and it is what lets an undersized pack
 *   — or a tiebreak that has exhausted the pack — produce a full draw at all.
 */
export function draw<T>(
  pack: readonly T[],
  count: number,
  eligible: (item: T) => boolean,
  seed: string,
): T[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`draw count must be a non-negative integer, got ${count}`);
  }
  if (count === 0) return [];
  if (pack.length === 0) {
    throw new RangeError('cannot draw from an empty pack');
  }

  const rng = makeRng(seed);
  const drawn: T[] = [];

  // Sampling without replacement from `available`; when it empties, every chart
  // in the pack becomes available again and sampling continues. A pack smaller
  // than `count` therefore resets more than once.
  let available = pack.filter(eligible);

  while (drawn.length < count) {
    if (available.length === 0) available = [...pack];
    const index = rng.nextInt(available.length);
    // Swap-with-last removal: O(1), and order within `available` is never
    // observable because the next pick is uniform over whatever remains.
    const picked = available[index]!;
    available[index] = available[available.length - 1]!;
    available.pop();
    drawn.push(picked);
  }

  return drawn;
}
