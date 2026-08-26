import type { PrismaClient } from '@prisma/client';
import type { MatchEvent } from '../domain/types.js';
import { generateBracket, type MatchRef } from '../domain/bracket.js';
import { computeStandings, criticalPathRounds, type StandingsInput } from '../domain/advancement.js';
import type { RandomPort } from './ports.js';
import { appendMatchEventTx, type AppendResult } from './match-service.js';
import { entrantCountAtStart } from './engine.js';

/**
 * Tournament-scope disqualification. Sets the entrant `WITHDRAWN`, then, if
 * they were mid-set, forfeits that one match — an ordinary loss, via the
 * same `DQ_APPLIED` event a match-scoped ruling uses; `scope` is what tells
 * this apart from that, read only here. See DESIGN.md, "Tournament-scope
 * disqualification cascades".
 *
 * Nothing further needs walking here: any match this entrant was already
 * seeded into but hadn't started sits at one participant until its other
 * slot fills, and the moment it does, `maybeStartMatch` (engine.ts) checks
 * every seated entrant's status before starting it — the same check whether
 * the second seat arrived through ordinary advancement or after this call.
 * The only place two seats can sit unstarted independent of that check is
 * the grand-final reset, and that is re-evaluated from scratch once the
 * grand final's own outcome is known. So a withdrawal that lands on an
 * already-decided path resolves itself lazily, exactly once, right when it
 * matters — there is no separate sweep to keep in sync with that logic.
 */
export interface DisqualifyFromTournamentResult {
  /**
   * The match this DQ resolved as a live forfeit, if any — `null` when the
   * entrant wasn't mid-set (e.g. seated but not yet opposed, or not seated
   * at all). Handed back rather than acted on here, the same pattern
   * `cancelTournament` uses with `cancelledMatchIds`, so the Discord-side
   * caller can render the thread log, escalation resolution and archive
   * through the same `applyAppendResult` every other ruling goes through.
   */
  resolvedMatch: { matchId: string; event: Omit<MatchEvent, 'seq'>; result: AppendResult } | null;
}

export async function disqualifyFromTournament(
  prisma: PrismaClient,
  random: RandomPort,
  tournamentId: string,
  entrantId: string,
  actorId: string,
): Promise<DisqualifyFromTournamentResult> {
  return prisma.$transaction(async (tx) => {
    await tx.entrant.update({ where: { id: entrantId }, data: { status: 'WITHDRAWN' } });

    const live = await tx.matchParticipant.findFirst({
      where: { entrantId, match: { tournamentId, status: 'IN_PROGRESS' } },
      select: { matchId: true },
    });
    if (!live) return { resolvedMatch: null };

    const event: Omit<MatchEvent, 'seq'> = {
      actorId,
      type: 'DQ_APPLIED',
      payload: { playerId: entrantId, scope: 'TOURNAMENT' },
    };
    const result = await appendMatchEventTx(tx, random, live.matchId, event);
    return { resolvedMatch: { matchId: live.matchId, event, result } };
  });
}

export interface StandingsRow {
  entrantId: string;
  seed: number;
  displayName: string | null;
  place: number;
}

/** Standings are derived, never stored — see DESIGN.md, "Advancement, Walkovers, and Standings". */
export async function computeTournamentStandings(
  prisma: PrismaClient,
  tournamentId: string,
): Promise<StandingsRow[]> {
  const entrantCount = await entrantCountAtStart(prisma, tournamentId);
  const bracket = generateBracket(entrantCount);

  const losersRows = await prisma.matchParticipant.findMany({
    where: { place: 2, match: { tournamentId, bracket: 'LOSERS', status: 'COMPLETE' } },
    include: { match: true, entrant: true },
  });
  const losersEliminations: StandingsInput['losersEliminations'] = losersRows.map((r) => ({
    ref: { bracket: r.match.bracket, round: r.match.round, slot: r.match.slot } as MatchRef,
    loserSeed: r.entrant.seed!,
  }));

  const decider =
    (await prisma.match.findFirst({
      where: { tournamentId, bracket: 'GRAND_FINAL', round: 2, status: 'COMPLETE' },
      include: { participants: { include: { entrant: true } } },
    })) ??
    (await prisma.match.findFirst({
      where: { tournamentId, bracket: 'GRAND_FINAL', round: 1, status: 'COMPLETE' },
      include: { participants: { include: { entrant: true } } },
    })) ??
    (await prisma.match.findFirst({
      where: { tournamentId, bracket: 'WINNERS', status: 'COMPLETE' },
      orderBy: { round: 'desc' },
      include: { participants: { include: { entrant: true } } },
    }));
  if (!decider) return [];

  const champion = decider.participants.find((p) => p.place === 1)!;
  const runnerUp = decider.participants.find((p) => p.place === 2)!;
  const input: StandingsInput = {
    losersEliminations,
    final: { championSeed: champion.entrant.seed!, runnerUpSeed: runnerUp.entrant.seed! },
  };

  const bySeed = new Map(
    (await prisma.entrant.findMany({ where: { tournamentId, seed: { not: null } } })).map((e) => [e.seed!, e]),
  );
  return computeStandings(bracket, input).map((s) => {
    const e = bySeed.get(s.seed)!;
    return { entrantId: e.id, seed: s.seed, displayName: e.displayName, place: s.place };
  });
}

/** `criticalPathRounds` is already the whole estimate — this is the wiring. */
export async function estimateDurationMinutes(prisma: PrismaClient, tournamentId: string): Promise<number> {
  const [entrantCount, tournament] = await Promise.all([
    entrantCountAtStart(prisma, tournamentId),
    prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } }),
  ]);
  const config = tournament.config as { perMatchAllocationMinutes?: number };
  const perMatch = config.perMatchAllocationMinutes ?? 25;
  return criticalPathRounds(generateBracket(entrantCount)) * perMatch;
}
