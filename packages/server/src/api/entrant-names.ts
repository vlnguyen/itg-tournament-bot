import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * `MatchState.participants` only ever carries `{ entrantId, seed }` — the
 * pure domain layer has no idea `Entrant` rows exist — so this is what the
 * API layer joins in before a participant reaches the wire. Same fallback
 * as the Discord side's `PlayerDirectory` (`discord/match-lookup.ts`):
 * `entrant.displayName ?? entrant.discordUserId`.
 */
export async function entrantDisplayNames(prisma: PrismaService, entrantIds: string[]): Promise<Map<string, string>> {
  if (entrantIds.length === 0) return new Map();
  const entrants = await prisma.entrant.findMany({
    where: { id: { in: entrantIds } },
    select: { id: true, displayName: true, discordUserId: true },
  });
  return new Map(entrants.map((e) => [e.id, e.displayName ?? e.discordUserId]));
}

/** Every entrant a tournament has ever seated, in one query — the whole roster is small, so a bracket snapshot fetches it in one shot rather than per match. */
export async function entrantDisplayNamesForTournament(prisma: PrismaService, tournamentId: string): Promise<Map<string, string>> {
  const entrants = await prisma.entrant.findMany({
    where: { tournamentId },
    select: { id: true, displayName: true, discordUserId: true },
  });
  return new Map(entrants.map((e) => [e.id, e.displayName ?? e.discordUserId]));
}
