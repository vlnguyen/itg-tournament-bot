import type { Entrant, Match, MatchParticipant, PrismaClient } from '@prisma/client';
import type { PlayerDirectory } from './state-message.js';

export type MatchWithParticipants = Match & {
  participants: (MatchParticipant & { entrant: Entrant })[];
  tournament: { guildId: string; name: string };
};

const include = {
  participants: { include: { entrant: true } },
  tournament: { select: { guildId: true, name: true } },
} as const;

export async function loadMatch(prisma: PrismaClient, matchId: string): Promise<MatchWithParticipants | null> {
  return prisma.match.findUnique({ where: { id: matchId }, include });
}

export async function loadMatchByThreadId(
  prisma: PrismaClient,
  threadId: string,
): Promise<MatchWithParticipants | null> {
  return prisma.match.findFirst({ where: { threadId }, include });
}

export function buildPlayerDirectory(match: MatchWithParticipants): PlayerDirectory {
  return new Map(
    match.participants.map((p) => [
      p.entrantId,
      { discordUserId: p.entrant.discordUserId, displayName: p.entrant.displayName ?? p.entrant.discordUserId },
    ]),
  );
}
