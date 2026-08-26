import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type GeneratedBracket,
  type MatchRef,
  generateBracket,
  liveSourceCount,
  matchKey,
  simulateBracket,
} from './bracket.js';

/**
 * Every entrant count worth checking in a realistic range — powers of two,
 * where the stagger's edge cases (m=1, m=2) show up, and non-powers, where
 * byes interact with it. See DESIGN.md: "These run across every entrant
 * count in a realistic range, not just powers of two — the bye path is
 * where this kind of code usually breaks." 64 is the upper bound DESIGN.md
 * itself cites ("a 64-entrant bracket holds 126 matches in total").
 */
const REALISTIC_ENTRANT_COUNTS = [
  2, 3, 4, 5, 6, 7, 8, 9, 11, 13, 16, 17, 24, 31, 32, 33, 40, 47, 48, 55, 63, 64,
];

/** The "chalk" decider from DESIGN.md's worked example: the better (lower-numbered) seed always wins. */
const chalk = (a: number, b: number) => Math.min(a, b);

describe('property: pairing never depends on match results', () => {
  it('generation takes only entrantCount, so it is deterministic across repeated calls', () => {
    for (const n of REALISTIC_ENTRANT_COUNTS) {
      expect(generateBracket(n)).toEqual(generateBracket(n));
    }
  });

  it('round-1 sources are concrete seeds or byes; every later source is a WINNER_OF/LOSER_OF reference, never a seed', () => {
    for (const n of REALISTIC_ENTRANT_COUNTS) {
      const b = generateBracket(n);
      for (const m of b.matches) {
        const isRound1Winners = m.ref.bracket === 'WINNERS' && m.ref.round === 1;
        for (const s of m.sources) {
          if (isRound1Winners) {
            expect(s.kind === 'SEED' || s.kind === 'BYE').toBe(true);
          } else {
            expect(s.kind === 'WINNER_OF' || s.kind === 'LOSER_OF').toBe(true);
          }
        }
      }
    }
  });
});

describe('property: bracket shape is deterministic for a given entrant count', () => {
  it('the same entrant count always yields the same match set (regenerating never shuffles anything)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...REALISTIC_ENTRANT_COUNTS), (n) => {
        const a = generateBracket(n);
        const b = generateBracket(n);
        expect(a).toEqual(b);
      }),
    );
  });
});

describe('property: byes land on the highest seeds', () => {
  it('the free pass into round 2 goes to seeds 1..byeCount — the highest (best) seeds', () => {
    for (const n of REALISTIC_ENTRANT_COUNTS) {
      const b = generateBracket(n);
      const byeCount = b.size - n;
      if (byeCount === 0) continue;
      const round1 = b.matches.filter((m) => m.ref.bracket === 'WINNERS' && m.ref.round === 1);
      const opponentsOfByes = round1
        .filter((m) => m.sources.some((s) => s.kind === 'BYE'))
        .map((m) => m.sources.find((s) => s.kind === 'SEED') as { kind: 'SEED'; seed: number })
        .map((s) => s.seed)
        .sort((x, y) => x - y);
      const expectedTopSeeds = Array.from({ length: byeCount }, (_, i) => i + 1);
      expect(opponentsOfByes).toEqual(expectedTopSeeds);
    }
  });
});

/** Builds, for every match, the set of matches that consume its winner or its loser. */
function forwardEdges(bracket: GeneratedBracket) {
  const consumesWinner = new Map<string, MatchRef[]>();
  const consumesLoser = new Map<string, MatchRef[]>();
  for (const m of bracket.matches) {
    for (const s of m.sources) {
      if (s.kind === 'WINNER_OF') {
        const k = matchKey(s.match);
        consumesWinner.set(k, [...(consumesWinner.get(k) ?? []), m.ref]);
      } else if (s.kind === 'LOSER_OF') {
        const k = matchKey(s.match);
        consumesLoser.set(k, [...(consumesLoser.get(k) ?? []), m.ref]);
      }
    }
  }
  return { consumesWinner, consumesLoser };
}

describe('property: every entrant reaches a reachable path to the final', () => {
  it('a round-1 winners loss still has a forward path to the terminal match, for every entrant count with a losers bracket', () => {
    for (const n of REALISTIC_ENTRANT_COUNTS) {
      const b = generateBracket(n);
      if (b.losersRounds === 0) continue; // the 2-entrant case: no losers path exists by design
      const { consumesWinner, consumesLoser } = forwardEdges(b);
      const terminal = matchKey(b.grandFinalRef!);

      const reaches = (start: MatchRef, edges: Map<string, MatchRef[]>): boolean => {
        const seen = new Set<string>();
        const stack = [start];
        while (stack.length > 0) {
          const cur = stack.pop()!;
          const k = matchKey(cur);
          if (k === terminal) return true;
          if (seen.has(k)) continue;
          seen.add(k);
          for (const next of consumesWinner.get(k) ?? []) stack.push(next);
          for (const next of consumesLoser.get(k) ?? []) stack.push(next);
        }
        return false;
      };

      const round1 = b.matches.filter((m) => m.ref.bracket === 'WINNERS' && m.ref.round === 1);
      for (const m of round1) {
        const hasRealSeed = m.sources.some((s) => s.kind === 'SEED');
        if (!hasRealSeed) continue;
        // Winning round 1 reaches the final via the winners bracket.
        expect(reaches(m.ref, consumesWinner)).toBe(true);
        // Losing round 1, when there was a real opponent to lose to, still
        // has a path down through the losers bracket to the final.
        const bothReal = m.sources.every((s) => s.kind === 'SEED');
        if (bothReal) expect(reaches(m.ref, consumesLoser)).toBe(true);
      }
    }
  });
});

describe('property: rematches are delayed as far as the structure permits', () => {
  // What the stagger actually guarantees is narrower than "no two seeds ever
  // meet twice before the grand final" — that blanket claim is false even
  // under the correct transform (e.g. n=8: seeds 2 and 3, both strong
  // enough to beat everyone but seed 1, are structurally forced into the
  // winners semifinal together by the seeding order alone, and the survivor
  // of that meets seed 2 again in the losers final regardless of which
  // transform is used — DESIGN.md's own caveat that the reasoning "is
  // weaker than it looks at small sizes").
  //
  // What *is* guaranteed, and is exactly the mechanism the M4 worked
  // example demonstrates: a major round's routing transform never maps a
  // dropper straight down to the survivor descended from its own bracket
  // neighbor. Mapping straight down is precisely what produces the
  // immediate, structurally-guaranteed rematch DESIGN.md's stagger exists
  // to avoid — "an immediate rematch is not bad luck, it is structural."
  it('the major-round routing transform has no fixed points once there is a choice to make (m >= 2)', () => {
    for (const n of REALISTIC_ENTRANT_COUNTS) {
      const b = generateBracket(n);
      // Recover, per losers-bracket major round, the (dropper index -> recipient slot)
      // mapping implied by the generated sources, and check it moves everyone.
      const majorRounds = new Map<number, { slot: number; dropperMatch: MatchRef }[]>();
      for (const m of b.matches) {
        if (m.ref.bracket !== 'LOSERS') continue;
        const loserSource = m.sources.find((s) => s.kind === 'LOSER_OF');
        const winnerSource = m.sources.find((s) => s.kind === 'WINNER_OF');
        if (!loserSource || !winnerSource) continue;
        if (loserSource.kind !== 'LOSER_OF' || (loserSource.match as MatchRef).bracket !== 'WINNERS')
          continue; // only major rounds take a winners-side dropper
        const list = majorRounds.get(m.ref.round) ?? [];
        list.push({ slot: m.ref.slot, dropperMatch: loserSource.match });
        majorRounds.set(m.ref.round, list);
      }

      for (const [, entries] of majorRounds) {
        const m = entries.length;
        if (m < 2) continue;
        entries.sort((x, y) => x.slot - y.slot);
        for (const { slot, dropperMatch } of entries) {
          expect(
            dropperMatch.slot,
            `n=${n}: recipient slot ${slot} received the dropper from its own neighbor`,
          ).not.toBe(slot);
        }
      }
    }
  });

  it('the specific case DESIGN.md works through: M4s loser does not meet LM0s survivor', () => {
    const results = simulateBracket(generateBracket(8), chalk);
    const lb2slot1 = results.get(matchKey({ bracket: 'LOSERS', round: 2, slot: 1 }))!;
    // slot 1 pairs LM1's survivor (6) against M4's loser (4) — not LM0's survivor (5).
    expect(lb2slot1).toEqual({ winner: 4, loser: 6 });
  });

  // `liveSourceCount` is a *static* prediction, made without knowing any
  // result; `simulateBracket` is the dynamic ground truth once `chalk`
  // decides every match. They must agree for every match, for every
  // realistic entrant count — this is what lets `engine.ts` trust the
  // static count to resolve a structural bye immediately, rather than
  // waiting to see whether a second occupant ever actually arrives.
  it('liveSourceCount predicts exactly which matches simulateBracket resolves with a real winner/loser', () => {
    for (const n of REALISTIC_ENTRANT_COUNTS) {
      const bracket = generateBracket(n);
      const results = simulateBracket(bracket, chalk);
      for (const m of bracket.matches) {
        const result = results.get(matchKey(m.ref))!;
        const expected = liveSourceCount(bracket, m.ref);
        expect(result.winner !== null, `n=${n} ${matchKey(m.ref)}: winner nullness`).toBe(expected >= 1);
        expect(result.loser !== null, `n=${n} ${matchKey(m.ref)}: loser nullness`).toBe(expected === 2);
      }
    }
  });

  it('a losers-bracket match can have fewer than two live sources only when a winners-round-1 bye is in play', () => {
    // Cross-check against the earlier finding for n=5: LR1 slot 1 is fed by
    // two winners-round-1 byes and so is never played at all (0), while
    // slot 0 is fed by one real match and one bye (1) — this is the exact
    // shape RIP 12.5 hit live, generalized rather than hand-verified once.
    const bracket = generateBracket(5);
    expect(liveSourceCount(bracket, { bracket: 'LOSERS', round: 1, slot: 0 })).toBe(1);
    expect(liveSourceCount(bracket, { bracket: 'LOSERS', round: 1, slot: 1 })).toBe(0);
  });

  it('every winners-bracket match past round 1, and the grand final, always has two live sources', () => {
    for (const n of REALISTIC_ENTRANT_COUNTS) {
      const bracket = generateBracket(n);
      for (const m of bracket.matches) {
        const isWinnersPastRound1 = m.ref.bracket === 'WINNERS' && m.ref.round > 1;
        const isGrandFinal = m.ref.bracket === 'GRAND_FINAL';
        if (!isWinnersPastRound1 && !isGrandFinal) continue;
        expect(liveSourceCount(bracket, m.ref), `n=${n} ${matchKey(m.ref)}`).toBe(2);
      }
    }
  });
});
