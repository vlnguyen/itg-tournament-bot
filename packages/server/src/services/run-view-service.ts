import type { PrismaClient } from '@prisma/client';
import type { BracketSide, RunView, RunViewAlert, RunViewLiveMatch } from '@itg/shared';
import { displayTitle, sectionLabel } from '@itg/shared';
import { toPublicMatch } from '../domain/projection.js';
import { emptyState } from '../domain/types.js';
import type { MatchState } from '../domain/types.js';
import { requireFormat } from './engine.js';

/**
 * `GET /api/tournaments/:id/run-view` — DESIGN.md, "The run view": "The
 * alert queue is the union described in Organizer Alerts and Escalation:
 * matches whose cached `awaitingTo` is set, plus unresolved `Alert` rows.
 * Ordered oldest-first" and "The live match list is one row per
 * in-progress match... sort by elapsed time and the slow one is at the
 * top." Both derived straight from the same `Match.state`/projection
 * columns every other read path uses — nothing new is stored for this.
 */

interface ParticipantRow {
  slot: number;
  entrant: { displayName: string | null; discordUserId: string };
}

function nameOf(entrant: { displayName: string | null; discordUserId: string }): string {
  return entrant.displayName ?? entrant.discordUserId;
}

function buildMatchLabel(bracket: BracketSide, round: number, participants: ParticipantRow[]): string {
  const [a, b] = [...participants].sort((p, q) => p.slot - q.slot).map((p) => nameOf(p.entrant));
  return `${sectionLabel(bracket, round)} · ${a ?? '?'} vs ${b ?? '?'}`;
}

function loadState(match: { formatKey: string; state: unknown }): ReturnType<typeof toPublicMatch> {
  const format = requireFormat(match.formatKey);
  const state = (match.state as unknown as MatchState | null) ?? emptyState();
  return toPublicMatch(format, state);
}

export async function getRunView(prisma: PrismaClient, tournamentId: string): Promise<RunView> {
  const [escalatedMatches, alertRows, liveMatchRows] = await Promise.all([
    prisma.match.findMany({
      where: { tournamentId, awaitingTo: true },
      include: { participants: { include: { entrant: true } } },
    }),
    prisma.alert.findMany({
      where: { tournamentId, resolvedAt: null },
      include: { match: { include: { participants: { include: { entrant: true } } } } },
    }),
    prisma.match.findMany({
      where: { tournamentId, status: 'IN_PROGRESS' },
      include: { participants: { include: { entrant: true } } },
    }),
  ]);

  const escalationSinceRows = escalatedMatches.length
    ? await prisma.matchEvent.findMany({
        where: { OR: escalatedMatches.map((m) => ({ matchId: m.id, seq: m.stateSeq })) },
        select: { matchId: true, createdAt: true },
      })
    : [];
  const escalationSince = new Map(escalationSinceRows.map((r) => [r.matchId, r.createdAt]));

  const liveIds = liveMatchRows.map((m) => m.id);
  const startedRows = liveIds.length
    ? await prisma.matchEvent.groupBy({ by: ['matchId'], where: { matchId: { in: liveIds } }, _min: { createdAt: true } })
    : [];
  const startedSince = new Map(startedRows.map((r) => [r.matchId, r._min.createdAt!]));

  const escalations: RunViewAlert[] = [];
  for (const m of escalatedMatches) {
    const pub = loadState(m);
    // Guarded, not asserted: `awaitingTo` and `pending.kind` are written
    // together in the same transaction (engine.ts), so they cannot disagree.
    if (pub.pending.kind !== 'AWAITING_TO') continue;
    escalations.push({
      kind: 'ESCALATION',
      matchId: m.id,
      matchLabel: buildMatchLabel(m.bracket, m.round, m.participants),
      reason: pub.pending.reason,
      songIndex: pub.pending.songIndex,
      since: (escalationSince.get(m.id) ?? new Date()).toISOString(),
    });
  }

  const thresholdAlerts: RunViewAlert[] = alertRows.map((a) => ({
    kind: 'THRESHOLD',
    id: a.id,
    alertKind: a.kind,
    matchId: a.matchId,
    matchLabel: a.match ? buildMatchLabel(a.match.bracket, a.match.round, a.match.participants) : null,
    payload: a.payload,
    since: a.createdAt.toISOString(),
  }));

  const alerts = [...escalations, ...thresholdAlerts].sort((x, y) => x.since.localeCompare(y.since));

  const liveMatches: RunViewLiveMatch[] = liveMatchRows
    .map((m) => {
      const pub = loadState(m);
      const active = pub.songs.find((s) => !s.result);
      const sorted = [...m.participants].sort((p, q) => p.slot - q.slot);
      return {
        matchId: m.id,
        matchLabel: buildMatchLabel(m.bracket, m.round, m.participants),
        participants: sorted.map((p) => ({ entrantId: p.entrantId, displayName: nameOf(p.entrant) })),
        currentChartTitle: active ? displayTitle(active.chart) : null,
        points: pub.points,
        since: (startedSince.get(m.id) ?? new Date()).toISOString(),
      };
    })
    .sort((x, y) => x.since.localeCompare(y.since));

  return { alerts, liveMatches };
}
