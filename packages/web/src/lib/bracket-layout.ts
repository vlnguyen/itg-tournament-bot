import { generateBracket, matchKey } from '@itg/shared';
import type { BracketSide, GeneratedBracket, MatchRef, Roster, TournamentSnapshot, TournamentSnapshotMatch } from '@itg/shared';

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

export type ProjectedSlot = { kind: 'entrant'; seed: number; displayName: string } | { kind: 'bye' };

/**
 * Round 1 is the one part of the bracket seed order decides outright —
 * `generateBracket`'s round-1 sources are concrete `SEED`/`BYE` values, not
 * references to another match's result (see that function's own comment).
 * Everything past round 1 depends on who actually wins, including bye
 * cascades the advancement engine resolves server-side
 * (`bracket-service.ts`'s `seatAndStartRoundOne`) — this deliberately
 * doesn't reach for that, so it only ever shows what the current seed order
 * actually determines, not a guess about how far it might cascade.
 *
 * Keyed by `matchKey` of the round-1 ref; each pair mirrors `sources`
 * order. A slot is `undefined` only when its `SEED` points past the current
 * checked-in count — a stale bracket generated for a field that has since
 * changed, which the start guard already blocks on separately.
 *
 * Bracket generation sizes and seeds off the checked-in field alone
 * (`entrantCountAtStart`/`renormalizeSeeds`, server-side), so a `SEED`
 * source numbered `n` means "the nth checked-in entrant in seed order" — a
 * dense 1..N space, distinct from the roster's own `seed` column, which
 * keeps whatever number an entrant got at `/join` and can have gaps where a
 * not-checked-in entrant sits. `roster` already arrives sorted by
 * `(seed asc, joinedAt asc)` (`getRoster`, server-side) — filtering to
 * `checkedIn` preserves that order, so a plain array index reproduces
 * `renormalizeSeeds`' eventual renumbering exactly, without duplicating it.
 */
export function projectRoundOne(generated: GeneratedBracket, roster: Roster): Map<string, [ProjectedSlot | undefined, ProjectedSlot | undefined]> {
  const checkedIn = roster.filter((e) => e.checkedIn);
  const bySeed = new Map(checkedIn.map((e, i) => [i + 1, e]));
  const map = new Map<string, [ProjectedSlot | undefined, ProjectedSlot | undefined]>();
  for (const m of generated.matches) {
    if (m.ref.bracket !== 'WINNERS' || m.ref.round !== 1) continue;
    const [a, b] = m.sources.map((source): ProjectedSlot | undefined => {
      if (source.kind === 'BYE') return { kind: 'bye' };
      if (source.kind !== 'SEED') return undefined; // round 1 sources are always SEED or BYE; unreachable in practice
      const entrant = bySeed.get(source.seed);
      return entrant ? { kind: 'entrant', seed: source.seed, displayName: entrant.displayName ?? entrant.discordUserId } : undefined;
    });
    map.set(matchKey(m.ref), [a, b]);
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
