import { describe, expect, it } from 'vitest';
import { generateBracket } from './bracket.js';
import {
  computeStandings,
  criticalPathRounds,
  grandFinalNeedsReset,
  routeCompletedMatch,
} from './advancement.js';

describe('routeCompletedMatch', () => {
  const b = generateBracket(8);

  it('routes place 1 to the successor winners match and place 2 to the successor losers match', () => {
    const m0 = { bracket: 'WINNERS', round: 1, slot: 0 } as const; // seeds 1 v 8
    const fills = routeCompletedMatch(b, m0, [
      { seed: 1, place: 1 },
      { seed: 8, place: 2 },
    ]);
    expect(fills).toHaveLength(2);
    expect(fills).toContainEqual({
      match: { bracket: 'WINNERS', round: 2, slot: 0 },
      slot: 0,
      seed: 1,
    });
    expect(fills).toContainEqual({
      match: { bracket: 'LOSERS', round: 1, slot: 0 },
      slot: 0,
      seed: 8,
    });
  });

  it('eliminates place 2 of a losers-bracket match — no fill, because nothing references its loser', () => {
    const lb1 = { bracket: 'LOSERS', round: 1, slot: 0 } as const;
    const fills = routeCompletedMatch(b, lb1, [
      { seed: 5, place: 1 },
      { seed: 8, place: 2 },
    ]);
    expect(fills).toEqual([
      { match: { bracket: 'LOSERS', round: 2, slot: 0 }, slot: 0, seed: 5 },
    ]);
  });

  it('feeds the winners final into grand final slot 0 (both the first game and the reset) and drops its loser into the losers final', () => {
    const winnersFinal = { bracket: 'WINNERS', round: 3, slot: 0 } as const;
    const losersFinal = { bracket: 'LOSERS', round: 4, slot: 0 } as const;

    expect(
      routeCompletedMatch(b, winnersFinal, [
        { seed: 1, place: 1 },
        { seed: 2, place: 2 },
      ]),
    ).toEqual([
      { match: losersFinal, slot: 1, seed: 2 },
      { match: b.grandFinalRef, slot: 0, seed: 1 },
      { match: b.grandFinalResetRef, slot: 0, seed: 1 },
    ]);
  });

  it('feeds the losers final into grand final slot 1 — both the first game and the reset — and eliminates its loser', () => {
    const losersFinal = { bracket: 'LOSERS', round: 4, slot: 0 } as const;

    expect(
      routeCompletedMatch(b, losersFinal, [
        { seed: 2, place: 1 },
        { seed: 3, place: 2 },
      ]),
    ).toEqual([
      { match: b.grandFinalRef, slot: 1, seed: 2 },
      { match: b.grandFinalResetRef, slot: 1, seed: 2 },
    ]);
  });

  it('produces no fills for the grand final itself — whether a reset is needed is a separate question', () => {
    const fills = routeCompletedMatch(b, b.grandFinalRef!, [
      { seed: 1, place: 1 },
      { seed: 2, place: 2 },
    ]);
    expect(fills).toEqual([]);
  });
});

describe('grandFinalNeedsReset', () => {
  it('is needed when the losers-bracket finalist (slot 1) wins game 1', () => {
    expect(grandFinalNeedsReset(1)).toBe(true);
  });

  it('is not needed when the winners-bracket finalist (slot 0) wins game 1', () => {
    expect(grandFinalNeedsReset(0)).toBe(false);
  });
});

describe('criticalPathRounds', () => {
  it('is 1 for the two-entrant case — a single match decides everything', () => {
    expect(criticalPathRounds(generateBracket(2))).toBe(1);
  });

  it('follows 2k + 1 for k winners rounds once a losers bracket exists — one grand final game plus a possible reset', () => {
    const cases: [entrants: number, expectedK: number][] = [
      [3, 2],
      [4, 2],
      [5, 3],
      [8, 3],
      [9, 4],
      [16, 4],
      [17, 5],
      [32, 5],
      [64, 6],
    ];
    for (const [n, k] of cases) {
      expect(criticalPathRounds(generateBracket(n))).toBe(2 * k + 1);
    }
  });
});

describe('computeStandings', () => {
  it('reproduces the classic 8-player double-elimination standings (1,2,3,4,5,5,7,7) under chalk', () => {
    const b = generateBracket(8);
    const ref = (round: number, slot: number) => ({ bracket: 'LOSERS' as const, round, slot });

    const standings = computeStandings(b, {
      final: { championSeed: 1, runnerUpSeed: 2 },
      losersEliminations: [
        { ref: ref(1, 0), loserSeed: 8 },
        { ref: ref(1, 1), loserSeed: 7 },
        { ref: ref(2, 0), loserSeed: 5 },
        { ref: ref(2, 1), loserSeed: 6 },
        { ref: ref(3, 0), loserSeed: 4 },
        { ref: ref(4, 0), loserSeed: 3 },
      ],
    });

    const bySeed = new Map(standings.map((s) => [s.seed, s.place]));
    expect(bySeed).toEqual(
      new Map([
        [1, 1],
        [2, 2],
        [3, 3],
        [4, 4],
        [5, 5],
        [6, 5],
        [7, 7],
        [8, 7],
      ]),
    );
  });

  it('places by elimination depth regardless of cause — a walkover elimination counts the same as a played loss', () => {
    // Same shape as above, but seed 8's round-1 "loss" is a walkover (bye
    // opponent never existed) rather than a played match. Standings do not
    // care why an elimination happened, only when.
    const b = generateBracket(8);
    const ref = (round: number, slot: number) => ({ bracket: 'LOSERS' as const, round, slot });
    const standings = computeStandings(b, {
      final: { championSeed: 1, runnerUpSeed: 2 },
      losersEliminations: [{ ref: ref(4, 0), loserSeed: 3 }],
    });
    expect(standings).toEqual([
      { seed: 1, place: 1 },
      { seed: 2, place: 2 },
      { seed: 3, place: 3 },
    ]);
  });

  it('handles the two-entrant case: just a champion and a runner-up', () => {
    const b = generateBracket(2);
    const standings = computeStandings(b, {
      final: { championSeed: 1, runnerUpSeed: 2 },
      losersEliminations: [],
    });
    expect(standings).toEqual([
      { seed: 1, place: 1 },
      { seed: 2, place: 2 },
    ]);
  });
});
