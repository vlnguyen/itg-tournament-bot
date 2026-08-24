import { PrismaClient } from '@prisma/client';
import { Bo5ProtectVetoFormat as F } from '../src/domain/bo5.js';
import type { MatchState } from '../src/domain/types.js';
import { appendMatchEvent } from '../src/services/match-service.js';
import type { RandomPort } from '../src/services/ports.js';

/**
 * Shared setup for the Phase 3 service integration tests. Not a `*.test.ts`
 * file itself, so vitest never collects it as a suite.
 */
export const prisma = new PrismaClient();

export async function isReachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export interface TestTournament {
  tournamentId: string;
  guildId: string;
  entrantIds: string[]; // index i -> seed i+1
}

/** A tournament with `entrantCount` seeded, checked-in entrants and a chart pack. */
export async function makeTournament(
  guildId: string,
  entrantCount: number,
  opts: { packSize?: number; perMatchAllocationMinutes?: number } = {},
): Promise<TestTournament> {
  await prisma.guild.create({ data: { id: guildId } });
  const tournament = await prisma.tournament.create({
    data: {
      guildId,
      name: `test-${guildId}`,
      defaultFormatKey: 'bo5-protect-veto',
      config: { perMatchAllocationMinutes: opts.perMatchAllocationMinutes ?? 25 },
      state: 'RUNNING',
    },
  });

  const entrantIds: string[] = [];
  for (let seed = 1; seed <= entrantCount; seed++) {
    const e = await prisma.entrant.create({
      data: { tournamentId: tournament.id, discordUserId: `${guildId}-p${seed}`, seed, checkedIn: true },
    });
    entrantIds.push(e.id);
  }

  const packSize = opts.packSize ?? 12;
  for (let i = 0; i < packSize; i++) {
    await prisma.chart.create({
      data: {
        tournamentId: tournament.id,
        title: `Song ${i}`,
        playStyle: 'SINGLE',
        difficulty: 'EXPERT',
        meter: 12 + (i % 6),
      },
    });
  }

  return { tournamentId: tournament.id, guildId, entrantIds };
}

export async function cleanupTournament(t: TestTournament): Promise<void> {
  await prisma.guild.delete({ where: { id: t.guildId } }).catch(() => undefined);
}

/**
 * Plays a started match (`MATCH_CREATED` + the initial Draw already
 * appended, i.e. whatever `bracket-service.ts` or the advancement cascade
 * left it at) straight to a 3-0 finish for `championEntrantId` — every song
 * goes to the champion, so no tiebreak round is ever reached.
 */
export async function playMatchToChampion(
  matchId: string,
  championEntrantId: string,
  random: RandomPort,
): Promise<void> {
  const currentPending = async () => {
    const m = await prisma.match.findUniqueOrThrow({ where: { id: matchId } });
    return F.pendingAction(m.state as unknown as MatchState);
  };

  for (;;) {
    const p = await currentPending();
    if (p.kind === 'DONE') return;
    switch (p.kind) {
      case 'SEED_CHOICE':
        await appendMatchEvent(prisma, random, matchId, {
          actorId: p.actor,
          type: 'SEED_CHOICE_MADE',
          payload: { by: p.actor, order: 'FIRST' },
        });
        break;
      case 'PROTECT':
      case 'VETO':
        await appendMatchEvent(prisma, random, matchId, {
          actorId: p.actor,
          type: p.kind === 'PROTECT' ? 'CHART_PROTECTED' : 'CHART_VETOED',
          payload: { by: p.actor, drawIndex: p.choices[0]! },
        });
        break;
      case 'SUBMIT_SCORE':
        for (const actorId of p.actors) {
          await appendMatchEvent(prisma, random, matchId, {
            actorId,
            type: 'SCORE_SUBMITTED',
            payload: { songIndex: p.songIndex, by: actorId, ex: actorId === championEntrantId ? 95 : 90 },
          });
          await appendMatchEvent(prisma, random, matchId, {
            actorId: null,
            type: 'PHOTO_OBSERVED',
            payload: { songIndex: p.songIndex, by: actorId, messageId: `m-${actorId}-${p.songIndex}` },
          });
        }
        break;
      case 'SELECT_WINNER':
        for (const actorId of p.actors) {
          await appendMatchEvent(prisma, random, matchId, {
            actorId,
            type: 'SONG_WINNER_SELECTED',
            payload: { songIndex: p.songIndex, by: actorId, choice: championEntrantId },
          });
        }
        break;
      case 'CONFIRM_RESULT':
        for (const actorId of p.actors) {
          await appendMatchEvent(prisma, random, matchId, {
            actorId,
            type: 'SET_RESULT_CONFIRMED',
            payload: { by: actorId },
          });
        }
        break;
      default:
        throw new Error(`playMatchToChampion: unexpected pending kind ${p.kind}`);
    }
  }
}
