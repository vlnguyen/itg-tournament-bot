import type { PrismaClient } from '@prisma/client';
import { FORMAT_SONG_LABELS, type FormatKey, type PoolLabelAssignments, type SongPoolIssues, type SongPoolTabWire } from '@itg/shared';
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
 * it — Save is never blocked by an incomplete or conflicting pool, only
 * Start Tournament is. Returns whatever `validateSongPool` finds
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
