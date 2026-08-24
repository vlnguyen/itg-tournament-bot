import { describe, expect, it } from 'vitest';
import {
  type GeneratedBracket,
  type MatchRef,
  generateBracket,
  matchKey,
  simulateBracket,
} from './bracket.js';
import { computeStandings, grandFinalNeedsReset, routeCompletedMatch } from './advancement.js';

const REALISTIC_ENTRANT_COUNTS = [
  2, 3, 4, 5, 6, 7, 8, 9, 11, 13, 16, 17, 24, 31, 32, 33, 40, 47, 48, 55, 63, 64,
];

const chalk = (a: number, b: number) => Math.min(a, b);

/**
 * Drives an entire bracket to completion using only `routeCompletedMatch` —
 * the mechanism a real service would use, one committed match at a time —
 * rather than `simulateBracket`'s direct source resolution. Returns final
 * standings plus every match's resolved winner/loser, so both can be
 * cross-checked against `simulateBracket`'s independent computation.
 */
function driveByAdvancement(bracket: GeneratedBracket) {
  const occupancy = new Map<string, [number | null, number | null]>();
  const resolved = new Map<string, { winner: number | null; loser: number | null }>();

  for (const m of bracket.matches) {
    const key = matchKey(m.ref);
    if (!occupancy.has(key)) occupancy.set(key, [null, null]);
    m.sources.forEach((s, i) => {
      if (s.kind === 'SEED') occupancy.get(key)![i] = s.seed;
    });
  }

  const losersEliminations: { ref: MatchRef; loserSeed: number }[] = [];

  const play = (ref: MatchRef) => {
    const [a, b] = occupancy.get(matchKey(ref))!;
    let winner: number | null;
    let loser: number | null;
    if (a != null && b != null) {
      winner = chalk(a, b);
      loser = winner === a ? b : a;
    } else {
      winner = a ?? b;
      loser = null;
    }
    resolved.set(matchKey(ref), { winner, loser });
    if (winner == null) return;

    const placements: { seed: number; place: 1 | 2 }[] = [{ seed: winner, place: 1 }];
    if (loser != null) placements.push({ seed: loser, place: 2 });
    for (const fill of routeCompletedMatch(bracket, ref, placements)) {
      const slots = occupancy.get(matchKey(fill.match)) ?? [null, null];
      slots[fill.slot] = fill.seed;
      occupancy.set(matchKey(fill.match), slots);
    }
    if (ref.bracket === 'LOSERS' && loser != null) {
      losersEliminations.push({ ref, loserSeed: loser });
    }
  };

  const byRound = (side: 'WINNERS' | 'LOSERS') =>
    bracket.matches
      .filter((m) => m.ref.bracket === side)
      .sort((x, y) => x.ref.round - y.ref.round || x.ref.slot - y.ref.slot)
      .map((m) => m.ref);

  for (const ref of byRound('WINNERS')) play(ref);

  let final: { championSeed: number; runnerUpSeed: number };
  if (bracket.grandFinalRef) {
    for (const ref of byRound('LOSERS')) play(ref);
    play(bracket.grandFinalRef);
    const gf1 = resolved.get(matchKey(bracket.grandFinalRef))!;
    const [slot0] = occupancy.get(matchKey(bracket.grandFinalRef))!;
    const winnerSlot = gf1.winner === slot0 ? 0 : 1;
    if (grandFinalNeedsReset(winnerSlot)) {
      play(bracket.grandFinalResetRef!);
      const reset = resolved.get(matchKey(bracket.grandFinalResetRef!))!;
      final = { championSeed: reset.winner!, runnerUpSeed: reset.loser! };
    } else {
      final = { championSeed: gf1.winner!, runnerUpSeed: gf1.loser! };
    }
  } else {
    // Two-entrant case: the winners final decides it directly.
    const wrFinal = resolved.get(matchKey(bracket.matches[0]!.ref))!;
    final = { championSeed: wrFinal.winner!, runnerUpSeed: wrFinal.loser! };
  }

  return { resolved, standings: computeStandings(bracket, { final, losersEliminations }) };
}

describe('property: advancement, driven match-by-match, agrees with direct bracket resolution', () => {
  it('every match resolves to the same winner and loser as simulateBracket', () => {
    for (const n of REALISTIC_ENTRANT_COUNTS) {
      const bracket = generateBracket(n);
      const viaAdvancement = driveByAdvancement(bracket).resolved;
      const viaSimulation = simulateBracket(bracket, chalk);

      for (const m of bracket.matches) {
        const key = matchKey(m.ref);
        // The grand final reset is only *played* by advancement when
        // needed, but simulateBracket resolves it unconditionally (see its
        // own docs) — skip comparing that one match.
        if (bracket.grandFinalResetRef && key === matchKey(bracket.grandFinalResetRef)) continue;
        expect(viaAdvancement.get(key), `n=${n} ${key}`).toEqual(viaSimulation.get(key));
      }
    }
  });

  it('seed 1 always finishes first under chalk, and standings cover every entrant exactly once', () => {
    for (const n of REALISTIC_ENTRANT_COUNTS) {
      const bracket = generateBracket(n);
      const { standings } = driveByAdvancement(bracket);
      expect(standings.find((s) => s.seed === 1)?.place).toBe(1);
      expect(standings.map((s) => s.seed).sort((a, b) => a - b)).toEqual(
        Array.from({ length: n }, (_, i) => i + 1),
      );
    }
  });

  it('standings form a valid competition ranking: sorted, no gaps except by tie-group size, place 1 exists', () => {
    for (const n of REALISTIC_ENTRANT_COUNTS) {
      const bracket = generateBracket(n);
      const { standings } = driveByAdvancement(bracket);
      const byPlace = new Map<number, number>();
      for (const s of standings) byPlace.set(s.place, (byPlace.get(s.place) ?? 0) + 1);

      let expectedNext = 1;
      const places = [...byPlace.keys()].sort((a, b) => a - b);
      for (const place of places) {
        expect(place, `n=${n}`).toBe(expectedNext);
        expectedNext = place + byPlace.get(place)!;
      }
      expect(expectedNext, `n=${n}`).toBe(n + 1);
    }
  });
});
