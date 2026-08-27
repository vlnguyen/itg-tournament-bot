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

export interface PlayerLiveMatch {
  tournamentId: string;
  tournamentName: string;
  matchId: string;
}

export interface PlayerPageData {
  discordUserId: string;
  currentDisplayName: string;
  wins: number;
  losses: number;
  matches: PlayerMatchRow[];
  liveMatch: PlayerLiveMatch | null;
}

/**
 * DESIGN.md, "Player pages": "keyed on the user ID, scoped to the server...
 * the page's own heading shows the player's current name from the `User`
 * cache, while every row shows the name they competed under in that
 * tournament, from `Entrant.displayName`." Only `COMPLETE` matches are
 * history — an in-progress one has no final score to show here.
 *
 * `liveMatch` is the exception: DESIGN.md's "The dashboard" wants "a link
 * straight into your live match thread," which is exactly this player's
 * `IN_PROGRESS` match, if any — the same `matchParticipant.findFirst`
 * shape `advancement-service.ts`'s `disqualifyFromTournament` already uses
 * to find one entrant's live match, generalized across every entrant row
 * this player has in the guild rather than just one.
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

  const entrantsById = new Map(entrants.map((e) => [e.id, e]));
  const live = await prisma.matchParticipant.findFirst({
    where: { entrantId: { in: entrants.map((e) => e.id) }, match: { status: 'IN_PROGRESS' } },
    select: { entrantId: true, matchId: true },
  });
  const liveEntrant = live ? entrantsById.get(live.entrantId) : undefined;
  const liveMatch: PlayerLiveMatch | null = live && liveEntrant
    ? { tournamentId: liveEntrant.tournamentId, tournamentName: liveEntrant.tournament.name, matchId: live.matchId }
    : null;

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

  return { discordUserId, currentDisplayName, wins, losses, matches, liveMatch };
}
