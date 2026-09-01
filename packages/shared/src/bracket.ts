import type { BracketSide } from './enums.js';

/**
 * Bracket generation — winners bracket, losers bracket with the stagger, and
 * the grand final with its reset. Pure: depends only on `entrantCount`,
 * never on a match result, which is the property that makes seeding
 * neutral to outcomes. See DESIGN.md, "Bracket Generation".
 *
 * Lives in `@itg/shared` rather than `packages/server/src/domain/bracket.ts`
 * (which re-exports everything here unchanged) because the bracket UI needs
 * the *exact* graph the server generated to draw connectors between
 * matches — recomputing the same topology independently on the client would
 * be a second implementation of routing math that could drift from the one
 * that actually decided the bracket. `simulateBracket`/`liveSourceCount`
 * stay server-only: advancement-time concerns a rendering client never
 * needs.
 *
 * A generated bracket is a graph, not a filled-in tournament. Round-1
 * sources are concrete (`SEED` or `BYE`); every later match's sources are
 * *references* to the winner or loser of an earlier match.
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

/** Exported for `bracket-service.ts`'s regeneration resize rule: the bracket's ref set is a pure function of this value alone (see `generateBracket`'s comment), so comparing it before and after a field change is how a rebuild decides whether per-match format assignments still apply. */
export function nextPowerOfTwo(n: number): number {
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

/** The two counts `sectionLabel` needs to know which round is last on each side — exactly `GeneratedBracket`'s own fields, named separately so a caller doesn't have to carry the whole bracket just for this. */
export interface BracketShape {
  winnersRounds: number;
  losersRounds: number;
}

/** Depth 0 is a side's last round, depth 1 its semifinal, depth 2 its quarterfinal — winners depth `d` always holds `2^d` matches, losers depth `d` holds `2^floor(d/2)`, so this table names exactly the 1-, 2- and 4-match rounds on either side, never an arbitrary cutoff. */
const NAMED_ROUND_BY_DEPTH: Record<number, string> = { 0: 'Finals', 1: 'Semifinals', 2: 'Quarterfinals' };

/**
 * How a round reads in prose — "Winners Round 1," not the grand final's
 * own rounds, which read as names instead of numbers. Shared so the
 * bracket UI's round headings and the run view's match labels (server
 * side) can't drift apart.
 *
 * `shape` is optional and, when given, names the last few rounds on each
 * side by their distance from the end — "Winners Finals," "Winners
 * Semifinals," "Winners Quarterfinals," matching the equivalent depths on
 * the losers side, before falling back to `${side} Round ${round}` for
 * anything deeper. Omitting `shape` (or calling with two entrants, where
 * there is no losers bracket to distinguish "Winners" from) returns exactly
 * today's plain numbered form, so every existing call site is unaffected —
 * only a caller that has the bracket's shape in hand opts into the richer
 * labels.
 */
export function sectionLabel(bracket: BracketSide, round: number, shape?: BracketShape): string {
  if (bracket === 'GRAND_FINAL') return round === 1 ? 'Grand Final' : 'Grand Final Reset';
  const side = bracket === 'WINNERS' ? 'Winners' : 'Losers';
  if (!shape) return `${side} Round ${round}`;

  // Two entrants: no losers bracket exists at all, so the winners final is
  // the whole tournament rather than one side of a rivalry — "Final," not
  // "Winners Finals". `generateBracket` guarantees losersRounds is 0 only
  // in exactly this case.
  if (shape.winnersRounds === 1 && shape.losersRounds === 0) return 'Final';

  const roundsForSide = bracket === 'WINNERS' ? shape.winnersRounds : shape.losersRounds;
  const depth = roundsForSide - round;
  const named = NAMED_ROUND_BY_DEPTH[depth];
  return named ? `${side} ${named}` : `${side} Round ${round}`;
}
