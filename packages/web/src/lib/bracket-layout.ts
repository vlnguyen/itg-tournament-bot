import { generateBracket, matchKey } from '@itg/shared';
import type { BracketSide, GeneratedBracket, MatchRef, TournamentSnapshot, TournamentSnapshotMatch } from '@itg/shared';

/**
 * "One semantic DOM, laid out by CSS Grid... an ordered list of rounds,
 * each containing an ordered list of matches." See DESIGN.md, "Rendering
 * the bracket". This is the pure half of that: grouping the snapshot's
 * matches into round columns and working out which match's winner/loser
 * physically feeds which downstream match — the structural data an
 * `aria-hidden` connector layer draws from. Actual pixel positions are the
 * rendering component's job (real DOM geometry); this only computes the
 * graph.
 */

export interface BracketColumn {
  bracket: BracketSide;
  round: number;
  matches: TournamentSnapshotMatch[]; // in slot order
}

export interface Advancement {
  /**
   * Usually at most one entry. The one exception: the grand final and its
   * reset share identical sources — "both rows exist from generation...
   * advancement skips the reset when the winners finalist takes the first
   * set; it is not conjured into existence only when needed" (see
   * `bracket.ts`) — so the winners/losers finalists' winners each feed
   * *both* grand-final rows, and a connector layer draws both.
   */
  winnerGoesTo: MatchRef[];
  loserGoesTo: MatchRef[];
}

export interface BracketLayout {
  generated: GeneratedBracket;
  winnersColumns: BracketColumn[];
  losersColumns: BracketColumn[];
  grandFinal: TournamentSnapshotMatch | null;
  grandFinalReset: TournamentSnapshotMatch | null;
  /** Keyed by `matchKey({ bracket, round, slot })` of the *source* match. */
  advancement: Map<string, Advancement>;
}

function columnsFor(
  generated: GeneratedBracket,
  byKey: Map<string, TournamentSnapshotMatch>,
  side: BracketSide,
  rounds: number,
): BracketColumn[] {
  const columns: BracketColumn[] = [];
  for (let round = 1; round <= rounds; round++) {
    const matches = generated.matches
      .filter((m) => m.ref.bracket === side && m.ref.round === round)
      .sort((a, b) => a.ref.slot - b.ref.slot)
      .map((m) => byKey.get(matchKey(m.ref)))
      .filter((m): m is TournamentSnapshotMatch => m !== undefined);
    columns.push({ bracket: side, round, matches });
  }
  return columns;
}

/** Inverts `sources` (which point backward, to where a match's occupants came from) into a forward "where does this match's result go" map. */
function computeAdvancement(generated: GeneratedBracket): Map<string, Advancement> {
  const map = new Map<string, Advancement>();
  const entryFor = (key: string): Advancement => {
    let a = map.get(key);
    if (!a) {
      a = { winnerGoesTo: [], loserGoesTo: [] };
      map.set(key, a);
    }
    return a;
  };
  for (const gm of generated.matches) {
    for (const source of gm.sources) {
      if (source.kind === 'WINNER_OF') entryFor(matchKey(source.match)).winnerGoesTo.push(gm.ref);
      if (source.kind === 'LOSER_OF') entryFor(matchKey(source.match)).loserGoesTo.push(gm.ref);
    }
  }
  return map;
}

export function buildBracketLayout(snapshot: TournamentSnapshot): BracketLayout {
  const generated = generateBracket(snapshot.entrantCount);
  const byKey = new Map(snapshot.matches.map((m) => [matchKey({ bracket: m.bracket, round: m.round, slot: m.slot }), m]));

  return {
    generated,
    winnersColumns: columnsFor(generated, byKey, 'WINNERS', generated.winnersRounds),
    losersColumns: columnsFor(generated, byKey, 'LOSERS', generated.losersRounds),
    grandFinal: generated.grandFinalRef ? (byKey.get(matchKey(generated.grandFinalRef)) ?? null) : null,
    grandFinalReset: generated.grandFinalResetRef ? (byKey.get(matchKey(generated.grandFinalResetRef)) ?? null) : null,
    advancement: computeAdvancement(generated),
  };
}
