import { describe, expect, it } from 'vitest';
import { generateBracket, matchKey, nextPowerOfTwo, sectionLabel } from './bracket.js';

/**
 * The invariant `bracket-service.ts`'s regeneration resize rule rests on:
 * per-match format assignments are keyed by `matchKey(ref)`, and are safe to
 * carry across a rebuild exactly when the ref set hasn't changed. This
 * confirms the ref set is a pure function of `nextPowerOfTwo(entrantCount)`
 * alone — identical within a band, different across one — over the whole
 * range a real tournament ever hits.
 */
describe('the bracket ref set depends only on nextPowerOfTwo(entrantCount)', () => {
  const matchKeySet = (entrantCount: number): string[] => generateBracket(entrantCount).matches.map((m) => matchKey(m.ref)).sort();

  it('is identical for any two counts in the same power-of-two band, and different otherwise', () => {
    for (let n = 2; n <= 64; n++) {
      for (let m = 2; m <= 64; m++) {
        if (nextPowerOfTwo(n) === nextPowerOfTwo(m)) {
          expect(matchKeySet(n)).toEqual(matchKeySet(m));
        } else {
          expect(matchKeySet(n)).not.toEqual(matchKeySet(m));
        }
      }
    }
  });
});

describe('sectionLabel', () => {
  it('returns plain numbered rounds when called without a shape — the back-compat guarantee every existing call site relies on', () => {
    expect(sectionLabel('WINNERS', 1)).toBe('Winners Round 1');
    expect(sectionLabel('WINNERS', 3)).toBe('Winners Round 3');
    expect(sectionLabel('LOSERS', 2)).toBe('Losers Round 2');
    expect(sectionLabel('GRAND_FINAL', 1)).toBe('Grand Final');
    expect(sectionLabel('GRAND_FINAL', 2)).toBe('Grand Final Reset');
  });

  it('names the last three rounds on each side, given the bracket shape', () => {
    const b = generateBracket(16); // winnersRounds 4, losersRounds 6
    expect(b.winnersRounds).toBe(4);
    expect(b.losersRounds).toBe(6);

    // Winners: depth 0/1/2 from round 4 down.
    expect(sectionLabel('WINNERS', 4, b)).toBe('Winners Finals');
    expect(sectionLabel('WINNERS', 3, b)).toBe('Winners Semifinals');
    expect(sectionLabel('WINNERS', 2, b)).toBe('Winners Quarterfinals');
    expect(sectionLabel('WINNERS', 1, b)).toBe('Winners Round 1'); // depth 3, falls back

    // Losers: same depth measure against losersRounds.
    expect(sectionLabel('LOSERS', 6, b)).toBe('Losers Finals');
    expect(sectionLabel('LOSERS', 5, b)).toBe('Losers Semifinals');
    expect(sectionLabel('LOSERS', 4, b)).toBe('Losers Quarterfinals');
    expect(sectionLabel('LOSERS', 3, b)).toBe('Losers Round 3'); // depth 3, falls back

    // Grand final is unaffected by the shape.
    expect(sectionLabel('GRAND_FINAL', 1, b)).toBe('Grand Final');
    expect(sectionLabel('GRAND_FINAL', 2, b)).toBe('Grand Final Reset');
  });

  it('names rounds correctly at match counts the depth naming is meant to track — 1/2/4 winners, 1/1/2 losers', () => {
    const b = generateBracket(32); // winnersRounds 5, losersRounds 8
    const winnersFinals = b.matches.filter((m) => m.ref.bracket === 'WINNERS' && m.ref.round === 5);
    const winnersSemis = b.matches.filter((m) => m.ref.bracket === 'WINNERS' && m.ref.round === 4);
    const winnersQuarters = b.matches.filter((m) => m.ref.bracket === 'WINNERS' && m.ref.round === 3);
    expect(winnersFinals).toHaveLength(1);
    expect(winnersSemis).toHaveLength(2);
    expect(winnersQuarters).toHaveLength(4);
    expect(sectionLabel('WINNERS', 5, b)).toBe('Winners Finals');
    expect(sectionLabel('WINNERS', 4, b)).toBe('Winners Semifinals');
    expect(sectionLabel('WINNERS', 3, b)).toBe('Winners Quarterfinals');

    const losersFinals = b.matches.filter((m) => m.ref.bracket === 'LOSERS' && m.ref.round === 8);
    const losersSemis = b.matches.filter((m) => m.ref.bracket === 'LOSERS' && m.ref.round === 7);
    const losersQuarters = b.matches.filter((m) => m.ref.bracket === 'LOSERS' && m.ref.round === 6);
    expect(losersFinals).toHaveLength(1);
    expect(losersSemis).toHaveLength(1);
    expect(losersQuarters).toHaveLength(2);
    expect(sectionLabel('LOSERS', 8, b)).toBe('Losers Finals');
    expect(sectionLabel('LOSERS', 7, b)).toBe('Losers Semifinals');
    expect(sectionLabel('LOSERS', 6, b)).toBe('Losers Quarterfinals');
  });

  it('names the winners side fully in a small (8-entrant) bracket, and the losers side down to one early round', () => {
    const b = generateBracket(8); // winnersRounds 3, losersRounds 4
    expect(sectionLabel('WINNERS', 3, b)).toBe('Winners Finals');
    expect(sectionLabel('WINNERS', 2, b)).toBe('Winners Semifinals');
    expect(sectionLabel('WINNERS', 1, b)).toBe('Winners Quarterfinals');
    expect(sectionLabel('LOSERS', 4, b)).toBe('Losers Finals');
    expect(sectionLabel('LOSERS', 3, b)).toBe('Losers Semifinals');
    expect(sectionLabel('LOSERS', 2, b)).toBe('Losers Quarterfinals');
    expect(sectionLabel('LOSERS', 1, b)).toBe('Losers Round 1'); // depth 3, falls back
  });

  it('labels the two-entrant case "Final", not "Winners Finals" — there is no losers side to distinguish it from', () => {
    const b = generateBracket(2);
    expect(sectionLabel('WINNERS', 1, b)).toBe('Final');
  });
});
