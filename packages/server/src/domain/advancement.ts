import type { GeneratedBracket, MatchRef } from './bracket.js';
import { matchKey } from './bracket.js';

/**
 * Advancement, the duration estimate, and standings — the rest of what
 * Build Order step 2 calls "the pure domain" once a bracket has been
 * generated. Pure: these operate on `GeneratedBracket`'s graph and on
 * placements the caller already knows, never on Discord, Postgres, or a
 * clock. See DESIGN.md, "Advancement, Walkovers, and Standings".
 *
 * Bracket seats are addressed by seed, not by entrant ID — the same reason
 * bracket generation itself is seed-based. The service maps seed to
 * `Entrant` via `Entrant.seed` at the boundary; nothing in here needs to.
 */

// ---------------------------------------------------------------------------
// Advancement
// ---------------------------------------------------------------------------

export interface AdvancementFill {
  match: MatchRef;
  slot: 0 | 1;
  seed: number;
}

/**
 * Routes a completed match's placements to whatever they fill next.
 *
 * Advancement is a bracket-side operation triggered by a committed set
 * result, and it routes by **placement**, not by winner and loser: place 1
 * is inserted wherever this match's `WINNER_OF` reference is consumed;
 * place 2 wherever its `LOSER_OF` reference is consumed. Because a losers-
 * bracket match's loser is never referenced by anything — the graph simply
 * has no `LOSER_OF` edge pointing at a `LOSERS`-side match — "place 2 is
 * eliminated" falls out of returning no fill for them, rather than being a
 * branch this function has to write.
 *
 * The grand final is deliberately outside this: nothing in the graph
 * references round 1 by `WINNER_OF`/`LOSER_OF`, because whether the reset
 * gets played is not a routing question — see `grandFinalNeedsReset`.
 */
export function routeCompletedMatch(
  bracket: GeneratedBracket,
  completed: MatchRef,
  placements: readonly { seed: number; place: 1 | 2 }[],
): AdvancementFill[] {
  const winnerSeed = placements.find((p) => p.place === 1)?.seed;
  const loserSeed = placements.find((p) => p.place === 2)?.seed;
  const completedKey = matchKey(completed);
  const fills: AdvancementFill[] = [];

  for (const m of bracket.matches) {
    m.sources.forEach((source, slot) => {
      if (source.kind === 'WINNER_OF' && matchKey(source.match) === completedKey) {
        if (winnerSeed != null) fills.push({ match: m.ref, slot: slot as 0 | 1, seed: winnerSeed });
      } else if (source.kind === 'LOSER_OF' && matchKey(source.match) === completedKey) {
        if (loserSeed != null) fills.push({ match: m.ref, slot: slot as 0 | 1, seed: loserSeed });
      }
    });
  }

  return fills;
}

/**
 * The grand final's sources are fixed at generation time: slot 0 is always
 * `WINNER_OF` the winners final, slot 1 always `WINNER_OF` the losers
 * final. That is not a coincidence to re-derive at each call site — it is
 * asserted once here, so a caller only ever needs to say which slot won
 * game 1.
 *
 * "The finalist coming from the losers bracket must win two sets to take
 * the tournament; the winners-bracket finalist needs only one." A reset is
 * needed exactly when the losers-bracket finalist — slot 1 — won it.
 */
export function grandFinalNeedsReset(gf1WinnerSlot: 0 | 1): boolean {
  return gf1WinnerSlot === 1;
}

// ---------------------------------------------------------------------------
// Duration estimate
// ---------------------------------------------------------------------------

/**
 * The length of the longest chain of matches that must happen in sequence,
 * from any round-1 match through to the tournament's final result. This is
 * "bracket depth," which is what the duration estimate is built from — not
 * match count, because every match in a round can run simultaneously.
 *
 * A plain longest-path walk over the `WINNER_OF`/`LOSER_OF` graph gets this
 * right for the winners and losers brackets, where dependency and sequence
 * coincide. The grand final reset does not fit that walk: its *sources*
 * mirror the grand final's — same two finalists — but it can only be played
 * *after* the grand final resolves, which the sources alone do not say. So
 * its depth is pinned to one more than the grand final's explicitly, rather
 * than computed from its sources like everything else. This function
 * estimates the worst case — a reset that is needed — which is the correct
 * side to be wrong on for a schedule.
 */
export function criticalPathRounds(bracket: GeneratedBracket): number {
  const byKey = new Map(bracket.matches.map((m) => [matchKey(m.ref), m]));
  const memo = new Map<string, number>();

  function depth(ref: MatchRef): number {
    const key = matchKey(ref);
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let result: number;
    if (bracket.grandFinalResetRef && key === matchKey(bracket.grandFinalResetRef)) {
      result = depth(bracket.grandFinalRef!) + 1;
    } else {
      const match = byKey.get(key);
      if (!match) throw new Error(`criticalPathRounds: no match at ${key}`);
      const sourceDepths = match.sources
        .filter((s) => s.kind === 'WINNER_OF' || s.kind === 'LOSER_OF')
        .map((s) => depth((s as { match: MatchRef }).match));
      result = 1 + (sourceDepths.length > 0 ? Math.max(...sourceDepths) : 0);
    }
    memo.set(key, result);
    return result;
  }

  return Math.max(...bracket.matches.map((m) => depth(m.ref)));
}

// ---------------------------------------------------------------------------
// Standings
// ---------------------------------------------------------------------------

export interface StandingsEntry {
  seed: number;
  /** 1-indexed. Ties share a place; the next place skips accordingly (5th, 5th, 7th). */
  place: number;
}

export interface StandingsInput {
  /** Every losers-bracket match's loser — win-cause-agnostic: agreement, ruling, forfeit, DQ, and walkover all place an entrant the same way. */
  losersEliminations: readonly { ref: MatchRef; loserSeed: number }[];
  /**
   * Whichever match actually decided 1st and 2nd — the grand final's reset
   * if one was played, its first game if not, or (in the two-entrant case,
   * which has no grand final) the winners final itself.
   */
  final: { championSeed: number; runnerUpSeed: number };
}

/**
 * Standings are derived, never stored. Placement follows elimination depth:
 * the grand final decides 1st and 2nd, the last losers round decides 3rd,
 * and players eliminated in the same losers round share a placement — 4th,
 * then 5th-6th, 7th-8th, and so on. Grouping `losersEliminations` by round
 * and walking backwards from the last one *is* that rule; nothing here
 * inspects why an elimination happened; a late referee ruling that changes
 * a match changes standings for free, because there is nothing here for it
 * to invalidate.
 */
export function computeStandings(
  bracket: GeneratedBracket,
  input: StandingsInput,
): StandingsEntry[] {
  const placements: StandingsEntry[] = [
    { seed: input.final.championSeed, place: 1 },
    { seed: input.final.runnerUpSeed, place: 2 },
  ];

  const byRound = new Map<number, number[]>();
  for (const { ref, loserSeed } of input.losersEliminations) {
    const list = byRound.get(ref.round) ?? [];
    list.push(loserSeed);
    byRound.set(ref.round, list);
  }

  for (let round = bracket.losersRounds; round >= 1; round--) {
    const seeds = byRound.get(round);
    if (!seeds || seeds.length === 0) continue;
    const place = placements.length + 1;
    for (const seed of seeds) placements.push({ seed, place });
  }

  return placements;
}
