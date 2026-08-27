import type { GeneratedBracket, GeneratedMatch, MatchRef, ParticipantSource } from '@itg/shared';
import { matchKey } from '@itg/shared';

/**
 * `generateBracket`/`seedOrder`/`matchKey` and every graph type now live in
 * `@itg/shared` — the bracket UI needs the exact same generated graph to
 * draw connectors between matches, and re-implementing that routing math
 * independently on the client would be a second copy able to drift from
 * the one that actually decided the bracket. Re-exported here unchanged so
 * every existing import in this package keeps working. What stays local:
 * `simulateBracket`/`liveSourceCount`, which are advancement-time concerns
 * a rendering client never needs. See DESIGN.md, "Bracket Generation".
 */
export type { GeneratedBracket, GeneratedMatch, MatchRef, ParticipantSource };
export { generateBracket, matchKey, seedOrder } from '@itg/shared';

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

  const bySide = (side: MatchRef['bracket']) =>
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
