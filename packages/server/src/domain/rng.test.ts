import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { makeRng } from './rng.js';

describe('makeRng', () => {
  it('is deterministic for a given seed', () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 1, max: 1000 }), (seed, bound) => {
        const a = makeRng(seed);
        const b = makeRng(seed);
        const left = Array.from({ length: 20 }, () => a.nextInt(bound));
        const right = Array.from({ length: 20 }, () => b.nextInt(bound));
        expect(left).toEqual(right);
      }),
    );
  });

  it('stays within bounds', () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 1, max: 10_000 }), (seed, bound) => {
        const rng = makeRng(seed);
        for (let i = 0; i < 50; i++) {
          const v = rng.nextInt(bound);
          expect(Number.isInteger(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThan(bound);
        }
      }),
    );
  });

  it('rejects a non-positive or non-integer bound', () => {
    const rng = makeRng('x');
    expect(() => rng.nextInt(0)).toThrow(RangeError);
    expect(() => rng.nextInt(-1)).toThrow(RangeError);
    expect(() => rng.nextInt(1.5)).toThrow(RangeError);
  });

  it('always returns 0 when the bound is 1', () => {
    const rng = makeRng('x');
    for (let i = 0; i < 10; i++) expect(rng.nextInt(1)).toBe(0);
  });

  it('produces different streams for different seeds', () => {
    const a = Array.from({ length: 10 }, (_, i) => makeRng('seed-a').nextInt(1000) + i * 0);
    const b = Array.from({ length: 10 }, (_, i) => makeRng('seed-b').nextInt(1000) + i * 0);
    expect(a[0]).not.toBe(b[0]);
  });

  /**
   * Pins the algorithm. An audit reproduces a draw from its stored seed, so a
   * silent change to the PRNG breaks that promise — this fails loudly instead.
   */
  it('matches its pinned output', () => {
    const rng = makeRng('audit-seed');
    const got = Array.from({ length: 8 }, () => rng.nextInt(100));
    expect(got).toEqual([0, 35, 91, 60, 93, 72, 22, 39]);
  });

  it('is close to uniform', () => {
    const buckets = new Array(10).fill(0);
    const rng = makeRng('uniformity');
    const n = 100_000;
    for (let i = 0; i < n; i++) buckets[rng.nextInt(10)]!++;
    // Expected 10,000 per bucket; a 10% band is far outside plausible noise
    // for this sample size but catches a genuinely skewed generator.
    for (const count of buckets) {
      expect(count).toBeGreaterThan(n / 10 - n / 100);
      expect(count).toBeLessThan(n / 10 + n / 100);
    }
  });
});
