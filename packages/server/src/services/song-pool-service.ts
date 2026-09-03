import type { PrismaClient, TournamentState } from '@prisma/client';
import { canImportPack, FORMAT_SONG_LABELS, type FormatKey, type PoolLabelAssignments, type SongPoolIssues, type SongPoolTabWire } from '@itg/shared';
import { logAction } from './audit-log.js';
import { requireFormat, type Tx } from './engine.js';

/**
 * Static-pool song labeling — the web pack view's per-format tabs
 * (NEW_FORMAT.md's "Song Pool" section). A tab's existence
 * (`SongPoolTab`) is tracked separately from its label assignments
 * (`ChartLabel`), so a TO can create an empty tab and fill it in over time
 * — see the plan's "Tabs persist independently of completion".
 */

/** Thrown for a request `song-pool.controller.ts` can't fulfill — an unregistered or non-static-pool format, a missing tab, or a chart from outside this tournament. Never for "the labels aren't complete yet," which is a warning (`SongPoolIssues`), not an error. */
export class SongPoolTabError extends Error {
  constructor(
    readonly tournamentId: string,
    readonly formatKey: string,
    reason: string,
  ) {
    super(`tournament ${tournamentId}, format ${formatKey}: ${reason}`);
    this.name = 'SongPoolTabError';
  }
}

/**
 * Editing a tab's labels or deleting one is open from tournament creation
 * up to the moment it starts — the same upper bound `roster-service.ts`'s
 * `SEEDING_STATES` uses, and for the same reason: `RUNNING` is when the
 * bracket (and every match's `formatKey`) is already generated and live,
 * so a label change or a deleted tab afterward couldn't do anything but
 * silently disagree with matches already underway. Tab *creation* isn't
 * gated the same way — an empty new tab, unpopulated, can't affect a
 * running bracket at all.
 */
const SONG_POOL_EDITABLE_STATES: readonly TournamentState[] = [
  'DRAFT',
  'REGISTRATION_OPEN',
  'REGISTRATION_CLOSED',
  'CHECKIN_OPEN',
  'CHECKIN_CLOSED',
];

async function requireNotStarted(tx: Tx, tournamentId: string, formatKey: string): Promise<void> {
  const tournament = await tx.tournament.findUniqueOrThrow({ where: { id: tournamentId } });
  if (!SONG_POOL_EDITABLE_STATES.includes(tournament.state)) {
    throw new SongPoolTabError(tournamentId, formatKey, 'the tournament has already started');
  }
}

/** The exact required label set for a static-pool format. Throws on an unregistered key; returns `undefined` for a registered key that isn't static-pool-shaped (Bo3/Bo5). */
function requiredLabels(formatKey: string): readonly string[] | undefined {
  requireFormat(formatKey);
  return FORMAT_SONG_LABELS[formatKey as FormatKey];
}

export async function listSongPoolTabs(prisma: PrismaClient, tournamentId: string): Promise<SongPoolTabWire[]> {
  const [tabs, labels] = await Promise.all([
    prisma.songPoolTab.findMany({ where: { tournamentId }, orderBy: { formatKey: 'asc' } }),
    prisma.chartLabel.findMany({ where: { tournamentId } }),
  ]);
  const assignmentsByFormat = new Map<string, PoolLabelAssignments>();
  for (const l of labels) {
    const m = assignmentsByFormat.get(l.formatKey) ?? {};
    m[l.chartId] = l.label;
    assignmentsByFormat.set(l.formatKey, m);
  }
  return tabs.map((t) => ({
    formatKey: t.formatKey as FormatKey,
    assignments: assignmentsByFormat.get(t.formatKey) ?? {},
  }));
}

export async function createSongPoolTab(
  prisma: PrismaClient,
  tournamentId: string,
  formatKey: string,
  actorId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    if (!requiredLabels(formatKey)) {
      throw new SongPoolTabError(tournamentId, formatKey, 'this format has no static song pool');
    }
    const existing = await tx.songPoolTab.findUnique({
      where: { tournamentId_formatKey: { tournamentId, formatKey } },
    });
    if (existing) throw new SongPoolTabError(tournamentId, formatKey, 'a tab for this format already exists');

    await tx.songPoolTab.create({ data: { tournamentId, formatKey } });
    await logAction(tx, actorId, 'SONG_POOL_TAB_CREATED', 'Tournament', tournamentId, { formatKey });
  });
}

/** Removes a tab and every label it carries. The "All Songs" tab isn't a `SongPoolTab` row at all, so it has no delete path here — the web layer simply never offers one. */
export async function deleteSongPoolTab(
  prisma: PrismaClient,
  tournamentId: string,
  formatKey: string,
  actorId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.songPoolTab.findUnique({
      where: { tournamentId_formatKey: { tournamentId, formatKey } },
    });
    if (!existing) throw new SongPoolTabError(tournamentId, formatKey, 'no tab exists for this format');
    await requireNotStarted(tx, tournamentId, formatKey);

    await tx.chartLabel.deleteMany({ where: { tournamentId, formatKey } });
    await tx.songPoolTab.delete({ where: { tournamentId_formatKey: { tournamentId, formatKey } } });
    await logAction(tx, actorId, 'SONG_POOL_TAB_DELETED', 'Tournament', tournamentId, { formatKey });
  });
}

/**
 * Every required label used exactly once, or a report of what's wrong —
 * `null` means well-formed. Shared by `saveSongPoolLabels` (a warning;
 * labels persist regardless — NEW_FORMAT.md's Save "tells you exactly
 * which labels haven't been used yet... and if a label has been used
 * multiple times... say which songs it's been assigned to") and
 * `tournament-service.ts`'s Start Tournament guard, where the same report
 * becomes a hard block instead.
 */
export async function validateSongPool(tx: Tx, tournamentId: string, formatKey: string): Promise<SongPoolIssues | null> {
  const required = FORMAT_SONG_LABELS[formatKey as FormatKey];
  if (!required) return null; // not a static-pool format — nothing to validate

  const rows = await tx.chartLabel.findMany({ where: { tournamentId, formatKey } });
  const chartsByLabel = new Map<string, string[]>();
  for (const r of rows) chartsByLabel.set(r.label, [...(chartsByLabel.get(r.label) ?? []), r.chartId]);

  const missingLabels = required.filter((label) => !chartsByLabel.has(label));
  const duplicateLabels: Record<string, string[]> = {};
  for (const [label, chartIds] of chartsByLabel) {
    if (chartIds.length > 1) duplicateLabels[label] = chartIds;
  }

  return missingLabels.length === 0 && Object.keys(duplicateLabels).length === 0
    ? null
    : { missingLabels, duplicateLabels };
}

/**
 * Replaces a tab's entire label set with `assignments` and always persists
 * it — never blocked by an incomplete or conflicting pool (only Start
 * Tournament is), but blocked once the tournament has started at all, same
 * as deleting a tab: nothing left in `DRAFT`..`CHECKIN_CLOSED` for a label
 * change to disagree with. Returns whatever `validateSongPool` finds
 * afterward, for the web layer's warning banner.
 */
export async function saveSongPoolLabels(
  prisma: PrismaClient,
  tournamentId: string,
  formatKey: string,
  assignments: PoolLabelAssignments,
  actorId: string,
): Promise<SongPoolIssues | null> {
  return prisma.$transaction(async (tx) => {
    if (!requiredLabels(formatKey)) {
      throw new SongPoolTabError(tournamentId, formatKey, 'this format has no static song pool');
    }
    const tab = await tx.songPoolTab.findUnique({ where: { tournamentId_formatKey: { tournamentId, formatKey } } });
    if (!tab) throw new SongPoolTabError(tournamentId, formatKey, 'no tab exists for this format');
    await requireNotStarted(tx, tournamentId, formatKey);

    const chartIds = Object.keys(assignments);
    if (chartIds.length > 0) {
      const owned = await tx.chart.count({ where: { tournamentId, id: { in: chartIds } } });
      if (owned !== chartIds.length) {
        throw new SongPoolTabError(tournamentId, formatKey, 'one or more charts do not belong to this tournament');
      }
    }

    await tx.chartLabel.deleteMany({ where: { tournamentId, formatKey } });
    if (chartIds.length > 0) {
      await tx.chartLabel.createMany({
        data: chartIds.map((chartId) => ({ tournamentId, formatKey, chartId, label: assignments[chartId]! })),
      });
    }
    await logAction(tx, actorId, 'SONG_POOL_LABELS_SAVED', 'Tournament', tournamentId, {
      formatKey,
      count: chartIds.length,
    });

    return validateSongPool(tx, tournamentId, formatKey);
  });
}

/** A one-line human-readable summary of `SongPoolIssues`, for error messages and the Start-guard checklist. */
export function songPoolIssuesSummary(issues: SongPoolIssues): string {
  const parts: string[] = [];
  if (issues.missingLabels.length > 0) parts.push(`missing ${issues.missingLabels.join(', ')}`);
  if (Object.keys(issues.duplicateLabels).length > 0) {
    const duplicates = Object.entries(issues.duplicateLabels)
      .map(([label, chartIds]) => `${label} (${chartIds.length} songs)`)
      .join(', ');
    parts.push(`duplicated: ${duplicates}`);
  }
  return parts.join('; ');
}

/**
 * Every static-pool format currently in play for a tournament — its
 * `defaultFormatKey` plus every value in `formatOverrides`, deduplicated.
 * What `startTournament`'s hard guard and `getLifecycleStatus`'s checklist
 * both need to know which tabs must be well-formed before Start.
 */
export function staticPoolFormatKeysInPlay(defaultFormatKey: string, formatOverrides: Record<string, string>): string[] {
  const keys = new Set([defaultFormatKey, ...Object.values(formatOverrides)]);
  return [...keys].filter((key) => FORMAT_SONG_LABELS[key as FormatKey] !== undefined);
}

export interface ImportCandidate {
  id: string;
  name: string;
  createdAt: Date;
  chartCount: number;
}

/**
 * "Previous event" picker's step 1: every finished (`COMPLETE`/
 * `CANCELLED`) tournament in `guildId`, other than `excludeTournamentId`
 * (the one being imported into), newest first, each with its total chart
 * count so a pack-less one can be shown disabled before it's ever picked.
 */
export async function listImportCandidates(prisma: PrismaClient, guildId: string, excludeTournamentId: string): Promise<ImportCandidate[]> {
  const tournaments = await prisma.tournament.findMany({
    where: { guildId, state: { in: ['COMPLETE', 'CANCELLED'] }, id: { not: excludeTournamentId } },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { charts: true } } },
  });
  return tournaments.map((t) => ({ id: t.id, name: t.name, createdAt: t.createdAt, chartCount: t._count.charts }));
}

/** Thrown for a "Previous event" import request `charts.controller.ts` can't fulfill — never for a partial/best-effort outcome, which isn't an error (see `importedFormatKeys`). */
export class PreviousEventImportError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'PreviousEventImportError';
  }
}

export interface ImportFromPreviousTournamentResult {
  importedCharts: number;
  importedFormatKeys: string[];
}

/**
 * "Previous event" song import — the pack view's alternative to a zip
 * upload: copy an earlier, finished tournament's entire pack into this
 * one, and recreate the label assignments for whichever of its song-pool
 * tabs `formatKeys` names.
 *
 * Every chart from the source tournament's pack is copied unconditionally
 * — which pool tabs the caller chose only controls which label
 * assignments get recreated, not which raw charts come over, so a chart
 * used by an unselected tab (or by no tab at all) still lands in the
 * target pack. `formatKeys` the source has no tab for are silently
 * dropped, not an error; `importedFormatKeys` is what actually happened.
 *
 * A chart id is always freshly minted here (a new `Chart` row per source
 * chart, this tournament's own), so if the target already has a tab for a
 * format being imported, its existing labels are left standing and the
 * imported ones are added alongside them — `ChartLabel`'s uniqueness can
 * never collide on a chart id that didn't exist a moment ago. A label
 * that ends up assigned twice this way is exactly the "duplicate"
 * `validateSongPool`/Start Tournament's guard already knows how to
 * report; cleaning that up is the TO's call, same as any other
 * pool-labeling decision — never blocked here.
 */
export async function importFromPreviousTournament(
  prisma: PrismaClient,
  targetTournamentId: string,
  sourceTournamentId: string,
  formatKeys: string[],
  actorId: string,
): Promise<ImportFromPreviousTournamentResult> {
  return prisma.$transaction(async (tx) => {
    if (sourceTournamentId === targetTournamentId) {
      throw new PreviousEventImportError('cannot import a tournament from itself');
    }

    const target = await tx.tournament.findUniqueOrThrow({ where: { id: targetTournamentId } });
    if (!canImportPack(target.state)) {
      throw new PreviousEventImportError(`can't import a pack: the tournament is already ${target.state}`);
    }

    const source = await tx.tournament.findUnique({ where: { id: sourceTournamentId } });
    if (!source) throw new PreviousEventImportError('the source tournament no longer exists');
    if (source.guildId !== target.guildId) {
      throw new PreviousEventImportError('the source tournament is not from this server');
    }
    if (source.state !== 'COMPLETE' && source.state !== 'CANCELLED') {
      throw new PreviousEventImportError("the source tournament hasn't finished yet");
    }

    const sourceCharts = await tx.chart.findMany({ where: { tournamentId: sourceTournamentId } });
    if (sourceCharts.length === 0) return { importedCharts: 0, importedFormatKeys: [] };

    const [sourceTabs, sourceLabels] = await Promise.all([
      tx.songPoolTab.findMany({ where: { tournamentId: sourceTournamentId, formatKey: { in: formatKeys } } }),
      tx.chartLabel.findMany({ where: { tournamentId: sourceTournamentId, formatKey: { in: formatKeys } } }),
    ]);
    const importedFormatKeys = sourceTabs.map((t) => t.formatKey);

    // Individually, not `createMany` — each call's returned row is what
    // supplies the new chart id `ChartLabel` rows below need to remap onto.
    const chartIdMap = new Map<string, string>();
    for (const { id, tournamentId: _sourceId, ...fields } of sourceCharts) {
      const created = await tx.chart.create({ data: { tournamentId: targetTournamentId, ...fields } });
      chartIdMap.set(id, created.id);
    }

    for (const formatKey of importedFormatKeys) {
      const existingTab = await tx.songPoolTab.findUnique({
        where: { tournamentId_formatKey: { tournamentId: targetTournamentId, formatKey } },
      });
      if (!existingTab) await tx.songPoolTab.create({ data: { tournamentId: targetTournamentId, formatKey } });
    }

    const newLabels = sourceLabels.flatMap((l) => {
      const chartId = chartIdMap.get(l.chartId);
      return chartId ? [{ tournamentId: targetTournamentId, formatKey: l.formatKey, chartId, label: l.label }] : [];
    });
    if (newLabels.length > 0) await tx.chartLabel.createMany({ data: newLabels });

    await logAction(tx, actorId, 'PACK_IMPORTED_FROM_TOURNAMENT', 'Tournament', targetTournamentId, {
      sourceTournamentId,
      importedCharts: sourceCharts.length,
      importedFormatKeys,
    });

    return { importedCharts: sourceCharts.length, importedFormatKeys };
  });
}
