import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { draw } from './draw.js';

const pack = (n: number): string[] => Array.from({ length: n }, (_, i) => `c${i}`);

const counts = (xs: readonly string[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
};

const all = () => true;

describe('draw', () => {
  it('returns exactly the count requested', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 0, max: 30 }),
        fc.string(),
        (packSize, count, seed) => {
          expect(draw(pack(packSize), count, all, seed)).toHaveLength(count);
        },
      ),
    );
  });

  it('only ever returns charts from the pack', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 1, max: 20 }),
        fc.string(),
        (packSize, count, seed) => {
          const p = pack(packSize);
          for (const c of draw(p, count, all, seed)) expect(p).toContain(c);
        },
      ),
    );
  });

  it('is deterministic for a given seed', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 1, max: 20 }),
        fc.string(),
        (packSize, count, seed) => {
          const p = pack(packSize);
          expect(draw(p, count, all, seed)).toEqual(draw(p, count, all, seed));
        },
      ),
    );
  });

  it('has no duplicates while the pack can cover the draw', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 7, max: 40 }),
        fc.string(),
        (packSize, seed) => {
          const got = draw(pack(packSize), 7, all, seed);
          expect(new Set(got).size).toBe(7);
        },
      ),
    );
  });

  it('respects eligibility while enough eligible charts remain', () => {
    fc.assert(
      fc.property(fc.integer({ min: 10, max: 40 }), fc.string(), (packSize, seed) => {
        const p = pack(packSize);
        const banned = new Set([p[0]!, p[1]!]);
        const got = draw(p, 7, (c) => !banned.has(c), seed);
        for (const c of got) expect(banned.has(c)).toBe(false);
      }),
    );
  });

  describe('exhaustion is normal, not an error', () => {
    it('still returns a full draw from an undersized pack', () => {
      const got = draw(pack(4), 7, all, 'undersized');
      expect(got).toHaveLength(7);
      expect(new Set(got).size).toBe(4);
    });

    it('distributes resets evenly — every chart used before any is reused', () => {
      // A pack of p drawn count times performs floor(count/p) complete cycles
      // plus a remainder, so each chart appears k or k+1 times and never more.
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 8 }),
          fc.integer({ min: 1, max: 40 }),
          fc.string(),
          (packSize, count, seed) => {
            const got = draw(pack(packSize), count, all, seed);
            const k = Math.floor(count / packSize);
            const remainder = count % packSize;
            const freq = [...counts(got).values()];
            const atK1 = freq.filter((f) => f === k + 1).length;
            expect(freq.every((f) => f === k || f === k + 1)).toBe(true);
            expect(atK1).toBe(remainder);
          },
        ),
      );
    });

    it('resets past an eligibility predicate that excludes everything', () => {
      // A tiebreak in a match that has already drawn the whole pack: nothing is
      // eligible, so the reset is what makes a draw possible at all.
      const p = pack(3);
      const got = draw(p, 3, () => false, 'all-excluded');
      expect(got).toHaveLength(3);
      expect(new Set(got)).toEqual(new Set(p));
    });
  });

  describe('draws are independent', () => {
    it('carries no state between calls', () => {
      const p = pack(20);
      const first = draw(p, 7, all, 'match-1');
      draw(p, 7, all, 'match-2');
      draw(p, 3, all, 'match-3');
      // Re-running the first draw after others have happened is unchanged:
      // nothing accumulates, so playing a chart never consumes it.
      expect(draw(p, 7, all, 'match-1')).toEqual(first);
    });

    it('does not mutate the pack it is given', () => {
      const p = pack(10);
      const before = [...p];
      draw(p, 25, all, 'no-mutation');
      expect(p).toEqual(before);
    });

    it('lets the same chart appear in concurrent matches', () => {
      const p = pack(8);
      const a = new Set(draw(p, 7, all, 'wr1-m0'));
      const b = new Set(draw(p, 7, all, 'wr1-m1'));
      expect([...a].some((c) => b.has(c))).toBe(true);
    });
  });

  it('covers the pack roughly evenly across many draws', () => {
    const p = pack(10);
    const freq = new Map<string, number>();
    for (let i = 0; i < 5_000; i++) {
      for (const c of draw(p, 3, all, `seed-${i}`)) {
        freq.set(c, (freq.get(c) ?? 0) + 1);
      }
    }
    const expected = (5_000 * 3) / 10;
    for (const c of p) {
      expect(freq.get(c)!).toBeGreaterThan(expected * 0.9);
      expect(freq.get(c)!).toBeLessThan(expected * 1.1);
    }
  });

  describe('rejects impossible requests', () => {
    it('throws on an empty pack', () => {
      expect(() => draw([], 1, all, 's')).toThrow(RangeError);
    });

    it('returns nothing for a zero count, even from an empty pack', () => {
      expect(draw([], 0, all, 's')).toEqual([]);
    });

    it('throws on a negative or fractional count', () => {
      expect(() => draw(pack(5), -1, all, 's')).toThrow(RangeError);
      expect(() => draw(pack(5), 1.5, all, 's')).toThrow(RangeError);
    });
  });
});
