import { z } from 'zod';
import { FormatKey } from './formats.js';

/**
 * A static-pool format tab's label assignments, keyed by chart id. A record
 * rather than an array of `{ chartId, label }` pairs: the JSON object shape
 * itself makes "one chart, one label" structural, not just a UI convention —
 * there is no way to express two labels for the same chart id in this wire
 * format, matching the pack view's single-select-per-row design.
 */
export const PoolLabelAssignments = z.record(z.string().min(1), z.string().min(1));
export type PoolLabelAssignments = z.infer<typeof PoolLabelAssignments>;

export const CreateSongPoolTabRequest = z.object({ formatKey: FormatKey });
export type CreateSongPoolTabRequest = z.infer<typeof CreateSongPoolTabRequest>;

export const SaveSongPoolLabelsRequest = z.object({ assignments: PoolLabelAssignments });
export type SaveSongPoolLabelsRequest = z.infer<typeof SaveSongPoolLabelsRequest>;

/**
 * What's wrong with a pool's labels, reported by both the Save endpoint (a
 * warning — the labels still get persisted, see NEW_FORMAT.md's "Song
 * Pool" section) and Start Tournament's hard guard (a block). `null` means
 * well-formed: every required label used exactly once.
 */
export const SongPoolIssues = z.object({
  /** Required labels this format's pool doesn't have yet. */
  missingLabels: z.array(z.string()),
  /** A required label assigned to more than one chart, and which ones. */
  duplicateLabels: z.record(z.string(), z.array(z.string().min(1))),
});
export type SongPoolIssues = z.infer<typeof SongPoolIssues>;

export const SaveSongPoolLabelsResponse = z.object({
  assignments: PoolLabelAssignments,
  issues: SongPoolIssues.nullable(),
});
export type SaveSongPoolLabelsResponse = z.infer<typeof SaveSongPoolLabelsResponse>;

export const SongPoolTabWire = z.object({
  formatKey: FormatKey,
  assignments: PoolLabelAssignments,
});
export type SongPoolTabWire = z.infer<typeof SongPoolTabWire>;

export const SongPoolTabsResponse = z.object({ tabs: z.array(SongPoolTabWire) });
export type SongPoolTabsResponse = z.infer<typeof SongPoolTabsResponse>;

/** `true` only when `issues` is `null` — every required label used exactly once. */
export function isWellFormedPool(issues: SongPoolIssues | null): issues is null {
  return issues === null;
}
