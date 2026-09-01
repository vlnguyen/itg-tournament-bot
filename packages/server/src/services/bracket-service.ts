import type { PrismaClient } from '@prisma/client';
import { generateBracket, matchKey, nextPowerOfTwo, type GeneratedBracket } from '../domain/bracket.js';
import type { RandomPort } from './ports.js';
import { maybeStartMatch, startWithSeats, TournamentTransitionError, type Tx } from './engine.js';

export interface GenerateBracketGraphResult {
  bracket: GeneratedBracket;
  /**
   * True when the bracket's shape changed since the last generation —
   * `nextPowerOfTwo(entrantCount)` crossed a boundary — which resets every
   * per-match format assignment rather than guessing where it should move.
   * False on a first-ever generation (nothing existed to reset) and on an
   * in-band regeneration (the ref set is identical, so nothing needed to
   * move — see `generateBracket`'s own comment on why `entrantCount` alone
   * decides the graph).
   */
  overridesReset: boolean;
  /** How many per-match assignments carried into the new rows — 0 when `overridesReset`. */
  assignmentsKept: number;
}

/**
 * The graph half of bracket materialization — every `Match` row, no seating,
 * no chart draw, no threads. Idempotent: calling it again regenerates,
 * applying the resize rule above to `Tournament.formatOverrides`. See
 * DESIGN.md, "Match Format as a Plugin".
 *
 * Guarded against ever discarding live play: refuses if any existing match
 * for this tournament has moved past `PENDING`. Every match a bracket
 * generated ahead of `RUNNING` could ever have is `PENDING` by construction
 * (nothing seats or starts before then), so in practice this only ever fires
 * if something has gone stateful in a way the caller didn't expect — a
 * cheap, load-bearing assertion rather than a real everyday path.
 */
export async function generateBracketGraph(
  tx: Tx,
  tournamentId: string,
  entrantCount: number,
): Promise<GenerateBracketGraphResult> {
  const tournament = await tx.tournament.findUniqueOrThrow({ where: { id: tournamentId } });

  const existing = await tx.match.findMany({ where: { tournamentId }, select: { status: true } });
  const notPending = existing.filter((m) => m.status !== 'PENDING');
  if (notPending.length > 0) {
    throw new TournamentTransitionError(
      tournamentId,
      `cannot regenerate the bracket: ${notPending.length} match(es) already underway`,
    );
  }

  const priorCount = tournament.bracketEntrantCount;
  const sameShape = priorCount !== null && nextPowerOfTwo(entrantCount) === nextPowerOfTwo(priorCount);
  const overridesReset = priorCount !== null && !sameShape;
  const overrides = overridesReset ? {} : (tournament.formatOverrides as Record<string, string>);

  if (existing.length > 0) {
    await tx.match.deleteMany({ where: { tournamentId } });
  }

  const bracket = generateBracket(entrantCount);
  for (const m of bracket.matches) {
    const formatKey = overrides[matchKey(m.ref)] ?? tournament.defaultFormatKey;
    await tx.match.create({
      data: { tournamentId, bracket: m.ref.bracket, round: m.ref.round, slot: m.ref.slot, formatKey },
    });
  }

  await tx.tournament.update({
    where: { id: tournamentId },
    data: { bracketEntrantCount: entrantCount, formatOverrides: overrides },
  });

  return { bracket, overridesReset, assignmentsKept: Object.keys(overrides).length };
}

/**
 * Seats round 1 and starts what can start immediately — a real pairing gets
 * both `MatchParticipant` rows and a start via `maybeStartMatch`; a bye (one
 * slot with no real entrant) is a `WALKOVER` at generation time, "not a
 * match," via `startWithSeats` with a single seat. Because that walkover
 * runs through the same advancement path as everything else, a chain of
 * byes in a small field cascades on its own — no special case for
 * consecutive byes. Split out of `materializeBracket` so the graph can be
 * created (`generateBracketGraph`) well before this ever runs.
 */
async function seatAndStartRoundOne(
  tx: Tx,
  tournamentId: string,
  random: RandomPort,
  bracket: GeneratedBracket,
): Promise<void> {
  const entrants = await tx.entrant.findMany({
    where: { tournamentId, status: 'ACTIVE', seed: { not: null } },
    orderBy: { seed: 'asc' },
  });
  const bySeed = new Map(entrants.map((e) => [e.seed!, e]));

  for (const m of bracket.matches) {
    if (m.ref.bracket !== 'WINNERS' || m.ref.round !== 1) continue;
    const target = await tx.match.findUniqueOrThrow({
      where: {
        tournamentId_bracket_round_slot: {
          tournamentId,
          bracket: 'WINNERS',
          round: 1,
          slot: m.ref.slot,
        },
      },
    });

    // `sourceFor` in `generateBracket` already resolved which slots are
    // real (`SEED`) versus structurally empty (`BYE`) — a `SEED` here is
    // always seed <= entrantCount, so `bySeed` always has it.
    const seated: { entrantId: string; seed: number }[] = [];
    for (const [slot, source] of m.sources.entries()) {
      if (source.kind !== 'SEED') continue;
      const entrant = bySeed.get(source.seed)!;
      seated.push({ entrantId: entrant.id, seed: entrant.seed! });
      await tx.matchParticipant.create({ data: { matchId: target.id, entrantId: entrant.id, slot } });
    }

    if (seated.length === 2) {
      await maybeStartMatch(tx, tournamentId, random, target.id, bracket);
    } else {
      // Exactly one real seed and one BYE — a walkover, not a match. Two
      // BYE slots can't happen: `entrantCount >= 2` guarantees round 1's
      // first pairing always has at least one real entrant, and byes only
      // ever land opposite a real seed (see "Byes land on the highest
      // seeds", DESIGN.md).
      await startWithSeats(tx, tournamentId, random, target.id, seated, seated[0]!.entrantId);
    }
  }
}

/**
 * "The whole bracket is materialized up front, byes included." Reuses an
 * already-generated bracket when one matches the field about to start
 * (`Tournament.bracketEntrantCount` — set only by `generateBracketGraph`,
 * always alongside the rows it stamps, so the two can't disagree); otherwise
 * generates it fresh, exactly as before per-match formats existed. Either
 * way, round 1 is seated and started the same way.
 *
 * See DESIGN.md, "Bracket Generation" and "Advancement, Walkovers, and
 * Standings".
 */
export async function materializeBracket(
  prisma: PrismaClient,
  random: RandomPort,
  tournamentId: string,
): Promise<void> {
  await prisma.$transaction(async (tx: Tx) => {
    const tournament = await tx.tournament.findUniqueOrThrow({ where: { id: tournamentId } });
    const entrantCount = await tx.entrant.count({ where: { tournamentId, status: 'ACTIVE', seed: { not: null } } });

    const bracket =
      tournament.bracketEntrantCount === entrantCount
        ? generateBracket(entrantCount) // rows already exist and match — the graph is pure, so recomputing it costs nothing and reads nothing back from storage
        : (await generateBracketGraph(tx, tournamentId, entrantCount)).bracket;

    await seatAndStartRoundOne(tx, tournamentId, random, bracket);
  });
}
