import { describe, expect, it } from 'vitest';
import {
  type GeneratedBracket,
  type MatchRef,
  generateBracket,
  matchKey,
  seedOrder,
} from './bracket.js';

function findMatch(bracket: GeneratedBracket, ref: MatchRef) {
  const m = bracket.matches.find((m) => matchKey(m.ref) === matchKey(ref));
  if (!m) throw new Error(`no match at ${matchKey(ref)}`);
  return m;
}

describe('seedOrder', () => {
  it('matches the worked values from DESIGN.md', () => {
    expect(seedOrder(1)).toEqual([1]);
    expect(seedOrder(2)).toEqual([1, 2]);
    expect(seedOrder(4)).toEqual([1, 4, 2, 3]);
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
  });

  it('rejects a non-power-of-two size', () => {
    expect(() => seedOrder(6)).toThrow(RangeError);
  });
});

describe('generateBracket: the two-entrant degenerate case', () => {
  it('has one winners round, no losers bracket, and no grand final', () => {
    const b = generateBracket(2);
    expect(b.winnersRounds).toBe(1);
    expect(b.losersRounds).toBe(0);
    expect(b.grandFinalRef).toBeNull();
    expect(b.grandFinalResetRef).toBeNull();
    expect(b.matches).toHaveLength(1);
    expect(b.matches[0]!.sources).toEqual([
      { kind: 'SEED', seed: 1 },
      { kind: 'SEED', seed: 2 },
    ]);
  });
});

describe('generateBracket: 8 entrants, the DESIGN.md worked example', () => {
  const b = generateBracket(8);

  it('pairs round 1 as 1-8, 4-5, 2-7, 3-6', () => {
    const round1 = b.matches
      .filter((m) => m.ref.bracket === 'WINNERS' && m.ref.round === 1)
      .sort((x, y) => x.ref.slot - y.ref.slot);
    expect(round1.map((m) => m.sources)).toEqual([
      [
        { kind: 'SEED', seed: 1 },
        { kind: 'SEED', seed: 8 },
      ],
      [
        { kind: 'SEED', seed: 4 },
        { kind: 'SEED', seed: 5 },
      ],
      [
        { kind: 'SEED', seed: 2 },
        { kind: 'SEED', seed: 7 },
      ],
      [
        { kind: 'SEED', seed: 3 },
        { kind: 'SEED', seed: 6 },
      ],
    ]);
  });

  it('pairs losers round 1 as (M0,M1) and (M2,M3), preserving winners-match order', () => {
    const m0 = { bracket: 'WINNERS', round: 1, slot: 0 } as const;
    const m1 = { bracket: 'WINNERS', round: 1, slot: 1 } as const;
    const m2 = { bracket: 'WINNERS', round: 1, slot: 2 } as const;
    const m3 = { bracket: 'WINNERS', round: 1, slot: 3 } as const;

    const lm0 = findMatch(b, { bracket: 'LOSERS', round: 1, slot: 0 });
    const lm1 = findMatch(b, { bracket: 'LOSERS', round: 1, slot: 1 });

    expect(lm0.sources).toEqual([{ kind: 'LOSER_OF', match: m0 }, { kind: 'LOSER_OF', match: m1 }]);
    expect(lm1.sources).toEqual([{ kind: 'LOSER_OF', match: m2 }, { kind: 'LOSER_OF', match: m3 }]);
  });

  it('sends M4 (WR2 slot 0, fed by M0+M1) away from LM0 and to LM1 — the reverse stagger', () => {
    // DESIGN.md: "Reverse the mapping and M4's loser meets LM1's survivor
    // instead: 4 versus 6, who have never played." This is exactly that
    // claim, checked against the generated structure rather than asserted.
    const wr2slot0 = { bracket: 'WINNERS', round: 2, slot: 0 } as const; // M4
    const lb1slot0 = { bracket: 'LOSERS', round: 1, slot: 0 } as const; // LM0
    const lb1slot1 = { bracket: 'LOSERS', round: 1, slot: 1 } as const; // LM1

    const major = b.matches
      .filter((m) => m.ref.bracket === 'LOSERS' && m.ref.round === 2)
      .sort((x, y) => x.ref.slot - y.ref.slot);

    // Slot 0 receives LM0's survivor and WR2 slot 1's (M5's) loser.
    expect(major[0]!.sources).toEqual([
      { kind: 'WINNER_OF', match: lb1slot0 },
      { kind: 'LOSER_OF', match: { bracket: 'WINNERS', round: 2, slot: 1 } },
    ]);
    // Slot 1 receives LM1's survivor and M4's loser — not LM0's.
    expect(major[1]!.sources).toEqual([
      { kind: 'WINNER_OF', match: lb1slot1 },
      { kind: 'LOSER_OF', match: wr2slot0 },
    ]);
  });

  it('has 3 winners rounds, 4 losers rounds, and a grand final with a reset', () => {
    expect(b.winnersRounds).toBe(3);
    expect(b.losersRounds).toBe(4);
    expect(b.grandFinalRef).toEqual({ bracket: 'GRAND_FINAL', round: 1, slot: 0 });
    expect(b.grandFinalResetRef).toEqual({ bracket: 'GRAND_FINAL', round: 2, slot: 0 });
  });

  it('feeds the grand final from the winners final and the losers final', () => {
    const gf = findMatch(b, b.grandFinalRef!);
    const reset = findMatch(b, b.grandFinalResetRef!);
    const winnersFinal = { bracket: 'WINNERS', round: 3, slot: 0 } as const;
    const losersFinal = { bracket: 'LOSERS', round: 4, slot: 0 } as const;
    expect(gf.sources).toEqual([
      { kind: 'WINNER_OF', match: winnersFinal },
      { kind: 'WINNER_OF', match: losersFinal },
    ]);
    // The reset is the same pairing — a fresh match, not a different one.
    expect(reset.sources).toEqual(gf.sources);
  });
});

describe('generateBracket: byes', () => {
  it('places byes on the highest seeds (5 entrants, size 8)', () => {
    const b = generateBracket(5);
    const round1 = b.matches.filter((m) => m.ref.bracket === 'WINNERS' && m.ref.round === 1);
    const byes = round1.filter((m) => m.sources.some((s) => s.kind === 'BYE'));
    const realOpponents = byes.map(
      (m) => m.sources.find((s) => s.kind === 'SEED')! as { kind: 'SEED'; seed: number },
    );
    // 3 byes (phantom seeds 6, 7, 8) — each paired with a real seed, per the
    // seeding construction. Those real seeds are the top 3: the highest
    // seeds are the ones who receive the free pass into round 2.
    expect(byes).toHaveLength(3);
    expect(realOpponents.map((s) => s.seed).sort((a, c) => a - c)).toEqual([1, 2, 3]);
  });

  it('gives no byes when entrantCount is already a power of two', () => {
    const b = generateBracket(8);
    const round1 = b.matches.filter((m) => m.ref.bracket === 'WINNERS' && m.ref.round === 1);
    expect(round1.every((m) => m.sources.every((s) => s.kind === 'SEED'))).toBe(true);
  });
});

describe('generateBracket: rejects bad input', () => {
  it('throws below two entrants', () => {
    expect(() => generateBracket(1)).toThrow(RangeError);
    expect(() => generateBracket(0)).toThrow(RangeError);
  });

  it('throws on a non-integer', () => {
    expect(() => generateBracket(4.5)).toThrow(RangeError);
  });
});
