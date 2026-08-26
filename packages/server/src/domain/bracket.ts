import type { BracketSide } from '@itg/shared';

/**
 * Bracket generation — winners bracket, losers bracket with the stagger, and
 * the grand final with its reset. Pure: depends only on `entrantCount`,
 * never on a match result, which is the property that makes seeding
 * neutral to outcomes. See DESIGN.md, "Bracket Generation".
 *
 * A generated bracket is a graph, not a filled-in tournament. Round-1
 * sources are concrete (`SEED` or `BYE`); every later match's sources are
 * *references* to the winner or loser of an earlier match. Resolving those
 * references — including cascading a bye's walkover forward, or a
 * bye-fed losers-bracket slot — is `simulateBracket`'s job, used here to
 * property-test the structure and reusable later by advancement.
 */

export interface MatchRef {
  bracket: BracketSide;
  round: number;
  slot: number;
}

export type ParticipantSource =
  | { kind: 'SEED'; seed: number }
  | { kind: 'BYE' }
  | { kind: 'WINNER_OF'; match: MatchRef }
  | { kind: 'LOSER_OF'; match: MatchRef };

export interface GeneratedMatch {
  ref: MatchRef;
  /** Every match that ships is 1v1. See DESIGN.md, "Seating more than two players". */
  sources: [ParticipantSource, ParticipantSource];
}

export interface GeneratedBracket {
  entrantCount: number;
  /** The field, padded to the next power of two. */
  size: number;
  winnersRounds: number;
  /** 2(k-1) for k winners rounds; 0 in the two-entrant case, which has no losers bracket. */
  losersRounds: number;
  matches: GeneratedMatch[];
  /** null only when there are exactly two entrants — the winners final decides the tournament outright. */
  grandFinalRef: MatchRef | null;
  grandFinalResetRef: MatchRef | null;
}

export function matchKey(ref: MatchRef): string {
  return `${ref.bracket}:${ref.round}:${ref.slot}`;
}

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * The standard recursive seeding construction: `order(1) = [1]`,
 * `order(2n) = order(n).flatMap(s => [s, 2n+1-s])`. Round 1 pairs
 * consecutive entries. Top seeds are kept apart for as long as the
 * structure allows, and byes land on the highest seeds — both fall out of
 * the construction rather than being arranged as special cases.
 */
export function seedOrder(size: number): number[] {
  if (!isPowerOfTwo(size)) {
    throw new RangeError(`seedOrder size must be a power of two, got ${size}`);
  }
  if (size === 1) return [1];
  const half = seedOrder(size / 2);
  return half.flatMap((s) => [s, size + 1 - s]);
}

function ref(bracket: BracketSide, round: number, slot: number): MatchRef {
  return { bracket, round, slot };
}

function winnerOf(m: MatchRef): ParticipantSource {
  return { kind: 'WINNER_OF', match: m };
}

function loserOf(m: MatchRef): ParticipantSource {
  return { kind: 'LOSER_OF', match: m };
}

/** Sends dropper `i` to the far end of the losers bracket: `m − 1 − i`. An involution. */
function reverseTransform(m: number): (i: number) => number {
  return (i) => m - 1 - i;
}

/** Sends dropper `i` to `(i + m/2) mod m`. An involution whenever `m` is even, which it always is here — `m` is a power of two. */
function rotateHalfTransform(m: number): (i: number) => number {
  const half = Math.floor(m / 2);
  return (i) => (i + half) % m;
}

export function generateBracket(entrantCount: number): GeneratedBracket {
  if (!Number.isInteger(entrantCount) || entrantCount < 2) {
    throw new RangeError(`entrantCount must be an integer >= 2, got ${entrantCount}`);
  }

  const size = nextPowerOfTwo(entrantCount);
  const k = Math.log2(size);
  const order = seedOrder(size);
  const matches: GeneratedMatch[] = [];

  // --- Winners bracket -----------------------------------------------------

  const winnersRoundMatches: MatchRef[][] = [];
  {
    const round1: MatchRef[] = [];
    const sourceFor = (seed: number): ParticipantSource =>
      seed <= entrantCount ? { kind: 'SEED', seed } : { kind: 'BYE' };
    for (let i = 0; i < size / 2; i++) {
      const r = ref('WINNERS', 1, i);
      matches.push({ ref: r, sources: [sourceFor(order[2 * i]!), sourceFor(order[2 * i + 1]!)] });
      round1.push(r);
    }
    winnersRoundMatches.push(round1);
  }
  for (let round = 2; round <= k; round++) {
    const prev = winnersRoundMatches[round - 2]!;
    const current: MatchRef[] = [];
    for (let i = 0; i < prev.length / 2; i++) {
      const r = ref('WINNERS', round, i);
      matches.push({ ref: r, sources: [winnerOf(prev[2 * i]!), winnerOf(prev[2 * i + 1]!)] });
      current.push(r);
    }
    winnersRoundMatches.push(current);
  }
  const winnersFinal = winnersRoundMatches[k - 1]![0]!;

  if (k === 1) {
    // Two entrants: nobody to build a losers bracket from. The winners final
    // is the whole tournament, not a semifinal — see DESIGN.md's grand-final
    // section, which this case falls outside of.
    return {
      entrantCount,
      size,
      winnersRounds: 1,
      losersRounds: 0,
      matches,
      grandFinalRef: null,
      grandFinalResetRef: null,
    };
  }

  // --- Losers bracket --------------------------------------------------------
  //
  // Round 1 takes every winners round-1 loser, preserving winners-match
  // order. After that, even-numbered rounds are major — winners droppers
  // enter, via the alternating reverse/rotate stagger — and odd-numbered
  // rounds are minor, where losers-side survivors meet each other.

  const losersRoundsTotal = 2 * (k - 1);
  let frontier: MatchRef[] = [];
  {
    const wr1 = winnersRoundMatches[0]!;
    for (let i = 0; i < wr1.length / 2; i++) {
      const r = ref('LOSERS', 1, i);
      matches.push({ ref: r, sources: [loserOf(wr1[2 * i]!), loserOf(wr1[2 * i + 1]!)] });
      frontier.push(r);
    }
  }

  for (let j = 1; j <= k - 1; j++) {
    const majorRound = 2 * j;
    const droppers = winnersRoundMatches[j]!; // winners round j+1
    const m = droppers.length;
    // Reverse at the first major round, alternating thereafter — a
    // convention, not a derivation. See DESIGN.md, "Which applies to which
    // round is a convention" — the property tests are what actually decide it.
    const transform = j % 2 === 1 ? reverseTransform(m) : rotateHalfTransform(m);

    const majorMatches: MatchRef[] = [];
    for (let i = 0; i < m; i++) {
      const r = ref('LOSERS', majorRound, i);
      matches.push({
        ref: r,
        sources: [winnerOf(frontier[i]!), loserOf(droppers[transform(i)]!)],
      });
      majorMatches.push(r);
    }

    if (majorRound === losersRoundsTotal) {
      frontier = majorMatches; // the losers final
      break;
    }

    const minorRound = majorRound + 1;
    const minorMatches: MatchRef[] = [];
    for (let i = 0; i < m / 2; i++) {
      const r = ref('LOSERS', minorRound, i);
      matches.push({
        ref: r,
        sources: [winnerOf(majorMatches[2 * i]!), winnerOf(majorMatches[2 * i + 1]!)],
      });
      minorMatches.push(r);
    }
    frontier = minorMatches;
  }
  const losersFinal = frontier[0]!;

  // --- Grand final and reset --------------------------------------------------

  const grandFinalRef = ref('GRAND_FINAL', 1, 0);
  const grandFinalResetRef = ref('GRAND_FINAL', 2, 0);
  // Both rows exist from generation, per "the whole bracket is materialized
  // up front." Advancement skips the reset when the winners finalist takes
  // the first set; it is not conjured into existence only when needed.
  matches.push({ ref: grandFinalRef, sources: [winnerOf(winnersFinal), winnerOf(losersFinal)] });
  matches.push({
    ref: grandFinalResetRef,
    sources: [winnerOf(winnersFinal), winnerOf(losersFinal)],
  });

  return {
    entrantCount,
    size,
    winnersRounds: k,
    losersRounds: losersRoundsTotal,
    matches,
    grandFinalRef,
    grandFinalResetRef,
  };
}

// ---------------------------------------------------------------------------
// Simulation — resolving a generated bracket against a decider function.
// Not used at generation time; this exists to let property tests (and,
// later, advancement) walk a filled-in bracket without duplicating the
// bye-cascade logic.
// ---------------------------------------------------------------------------

/** Given two real seeds in a match, returns the winning seed. */
export type Decider = (seedA: number, seedB: number) => number;

export interface SimMatchResult {
  /** null only when both sources were vacant — a match with nobody in it. */
  winner: number | null;
  /** null when the match was a walkover: no real loser exists to send onward. */
  loser: number | null;
}

/**
 * Resolves every match in a generated bracket against `decide`, cascading
 * byes and walkovers forward exactly as advancement will: a match with one
 * vacant source is a walkover for the other, and a match with two vacant
 * sources is itself vacant (propagating further, in the rare case of a
 * heavily byed early round).
 *
 * Round order within a side is a valid resolution order because a match's
 * sources only ever reference earlier rounds in the same side, or an
 * earlier side — winners bracket, then losers bracket, then grand final.
 */
export function simulateBracket(
  bracket: GeneratedBracket,
  decide: Decider,
): Map<string, SimMatchResult> {
  const results = new Map<string, SimMatchResult>();

  const resolveSource = (s: ParticipantSource): number | null => {
    switch (s.kind) {
      case 'SEED':
        return s.seed;
      case 'BYE':
        return null;
      case 'WINNER_OF':
        return results.get(matchKey(s.match))!.winner;
      case 'LOSER_OF':
        return results.get(matchKey(s.match))!.loser;
    }
  };

  const resolveMatch = (gm: GeneratedMatch): void => {
    const [a, b] = gm.sources.map(resolveSource);
    let result: SimMatchResult;
    if (a != null && b != null) {
      const winner = decide(a, b);
      result = { winner, loser: winner === a ? b : a };
    } else if (a != null || b != null) {
      result = { winner: (a ?? b)!, loser: null };
    } else {
      result = { winner: null, loser: null };
    }
    results.set(matchKey(gm.ref), result);
  };

  const bySide = (side: BracketSide) =>
    bracket.matches
      .filter((m) => m.ref.bracket === side)
      .sort((x, y) => x.ref.round - y.ref.round || x.ref.slot - y.ref.slot);

  for (const side of ['WINNERS', 'LOSERS', 'GRAND_FINAL'] as const) {
    for (const gm of bySide(side)) resolveMatch(gm);
  }

  return results;
}

/**
 * How many of a match's two sources can *ever* produce a real occupant,
 * without knowing any actual results yet — the static half of what
 * `simulateBracket` computes dynamically. A `SEED` is always live; a `BYE`
 * never is; `WINNER_OF` is live iff its source has at least one live
 * source of its own (a match with even one real occupant always produces a
 * real *winner*); `LOSER_OF` is live iff its source has **two** live
 * sources (only a genuine two-occupant match produces a real *loser* — a
 * walkover's "loser" never exists).
 *
 * This only ever differs from 2 in the losers bracket, and only when a
 * winners-round-1 bye is in play: winners rounds past the first always
 * resolve two real occupants (round 1's bye is settled to a real winner at
 * generation time, per `bracket-service.ts`), so every `WINNER_OF` a
 * winners match is unconditionally live, and the grand final's own sources
 * are `WINNER_OF` the two bracket finals — never `LOSER_OF` anything.
 *
 * Advancement (`engine.ts`) uses this to know, the moment a losers slot
 * receives its one *possible* occupant, that it should resolve as an
 * immediate walkover rather than wait forever for a second seat that
 * structurally can never arrive — "byes need no special case" carried one
 * hop further into the graph than round 1 alone.
 */
export function liveSourceCount(bracket: GeneratedBracket, ref: MatchRef): 0 | 1 | 2 {
  const byKey = new Map(bracket.matches.map((m) => [matchKey(m.ref), m]));
  const memo = new Map<string, 0 | 1 | 2>();

  function countFor(key: string): 0 | 1 | 2 {
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const m = byKey.get(key)!;
    const isLive = (s: ParticipantSource): 0 | 1 => {
      switch (s.kind) {
        case 'SEED':
          return 1;
        case 'BYE':
          return 0;
        case 'WINNER_OF':
          return countFor(matchKey(s.match)) >= 1 ? 1 : 0;
        case 'LOSER_OF':
          return countFor(matchKey(s.match)) === 2 ? 1 : 0;
      }
    };
    const total = (isLive(m.sources[0]) + isLive(m.sources[1])) as 0 | 1 | 2;
    memo.set(key, total);
    return total;
  }

  return countFor(matchKey(ref));
}
