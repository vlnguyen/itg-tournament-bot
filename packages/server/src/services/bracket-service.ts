import type { PrismaClient } from '@prisma/client';
import { generateBracket } from '../domain/bracket.js';
import type { RandomPort } from './ports.js';
import { maybeStartMatch, startWithSeats, type Tx } from './engine.js';

/**
 * "The whole bracket is materialized up front, byes included." Reads the
 * active, seeded entrants, generates the graph (`generateBracket` is a pure
 * function of the count alone), and writes every `Match` row before
 * resolving round 1: a real pairing seats both `MatchParticipant` rows and
 * starts the match; a bye — one slot with no real entrant — is a
 * `WALKOVER` at generation time, "not a match," which is exactly
 * `startWithSeats` with a single seat. Because that walkover runs through
 * the same advancement path as everything else, a chain of byes in a small
 * field cascades on its own — no special case for consecutive byes.
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
    const entrants = await tx.entrant.findMany({
      where: { tournamentId, status: 'ACTIVE', seed: { not: null } },
      orderBy: { seed: 'asc' },
    });
    const bySeed = new Map(entrants.map((e) => [e.seed!, e]));
    const bracket = generateBracket(entrants.length);

    for (const m of bracket.matches) {
      await tx.match.create({
        data: {
          tournamentId,
          bracket: m.ref.bracket,
          round: m.ref.round,
          slot: m.ref.slot,
          formatKey: tournament.defaultFormatKey,
        },
      });
    }

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
  });
}
