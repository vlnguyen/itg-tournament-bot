import type { PrismaClient } from '@prisma/client';

export interface PlayerMatchRow {
  tournamentId: string;
  tournamentName: string;
  matchId: string;
  bracket: string;
  round: number;
  displayNameThen: string;
  opponentDisplayName: string | null;
  points: number;
  opponentPoints: number;
  won: boolean;
}

export interface PlayerPageData {
  discordUserId: string;
  currentDisplayName: string;
  wins: number;
  losses: number;
  matches: PlayerMatchRow[];
}

/**
 * DESIGN.md, "Player pages": "keyed on the user ID, scoped to the server...
 * the page's own heading shows the player's current name from the `User`
 * cache, while every row shows the name they competed under in that
 * tournament, from `Entrant.displayName`." Only `COMPLETE` matches are
 * history — an in-progress one has no final score to show here.
 */
export async function getPlayerPage(prisma: PrismaClient, guildId: string, discordUserId: string): Promise<PlayerPageData | null> {
  const entrants = await prisma.entrant.findMany({
    where: { discordUserId, tournament: { guildId } },
    include: { tournament: true },
    orderBy: { tournament: { createdAt: 'desc' } },
  });
  if (entrants.length === 0) return null;

  const user = await prisma.user.findUnique({ where: { discordUserId } });
  const currentDisplayName = user?.displayName ?? entrants[0]!.displayName ?? discordUserId;

  const matches: PlayerMatchRow[] = [];
  let wins = 0;
  let losses = 0;

  for (const entrant of entrants) {
    const participations = await prisma.matchParticipant.findMany({
      where: { entrantId: entrant.id, match: { status: 'COMPLETE' } },
      include: { match: { include: { participants: { include: { entrant: true } } } } },
      orderBy: { match: { round: 'asc' } },
    });

    for (const p of participations) {
      const opponentParticipant = p.match.participants.find((pp) => pp.entrantId !== entrant.id);
      const won = p.place === 1;
      won ? wins++ : losses++;

      matches.push({
        tournamentId: entrant.tournamentId,
        tournamentName: entrant.tournament.name,
        matchId: p.matchId,
        bracket: p.match.bracket,
        round: p.match.round,
        displayNameThen: entrant.displayName ?? entrant.discordUserId,
        opponentDisplayName: opponentParticipant ? (opponentParticipant.entrant.displayName ?? opponentParticipant.entrant.discordUserId) : null,
        points: p.points,
        opponentPoints: opponentParticipant?.points ?? 0,
        won,
      });
    }
  }

  return { discordUserId, currentDisplayName, wins, losses, matches };
}
