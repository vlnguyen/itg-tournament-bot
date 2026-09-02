import { z } from 'zod';

/**
 * The match rulesets a tournament can run under. Mirrors
 * `packages/server/src/domain/golden/registry.ts`'s `formatRegistry` keys —
 * a server-side test asserts the two stay in sync, since this file cannot
 * import server code (the domain layer is server-only) and the registry
 * cannot import shared's zod schema without an equivalent risk in reverse.
 *
 * Display labels live here, not in Discord- or web-only code, on the same
 * precedent as `escalationReasonLabel` above: both surfaces need to render
 * a chosen format identically.
 */
export const FormatKey = z.enum([
  'bo5-protect-veto',
  'bo3-protect-veto',
  'hb11-static-pool',
  'hb13-static-pool',
]);
export type FormatKey = z.infer<typeof FormatKey>;

export const FORMAT_LABEL: Record<FormatKey, string> = {
  'bo5-protect-veto': 'Best of 5, 7 songs (Storm 2026)',
  'bo3-protect-veto': 'Best of 3, 5 songs',
  'hb11-static-pool': "Hubert's format (11 songs)",
  'hb13-static-pool': "Hubert's format (13 songs)",
};

/** A bracket cell or a Discord autocomplete list has no room for `FORMAT_LABEL`'s full sentence — this is the same distinction `thread-name.ts`'s abbreviated round codes draw against `sectionLabel`'s prose. */
export const FORMAT_SHORT_LABEL: Record<FormatKey, string> = {
  'bo5-protect-veto': 'BO5',
  'bo3-protect-veto': 'BO3',
  'hb11-static-pool': 'HB-11',
  'hb13-static-pool': 'HB-13',
};

/**
 * Whether a format draws from a fixed, TO-labeled song pool (see
 * `packages/web`'s pack view tabs) rather than the ordinary random draw from
 * the whole tournament pack.
 */
export const FORMAT_STATIC_SONG_POOL: Record<FormatKey, boolean> = {
  'bo5-protect-veto': false,
  'bo3-protect-veto': false,
  'hb11-static-pool': true,
  'hb13-static-pool': true,
};

/** The four song-pool categories a static-pool format's labels are grouped into. */
export const POOL_CATEGORY = ['RD', 'FT', 'FN', 'TB'] as const;
export type PoolCategory = (typeof POOL_CATEGORY)[number];

/**
 * Full category names — used only when referring to a category as a group
 * (a section header, a count, a "what's missing" message). Never paired
 * with the short code (no "RD Charts", no "Reading (RD)"): it's one or the
 * other. Anything naming a specific song always uses its numbered
 * shorthand (RD1, FT2, ...) instead, including every player-action line.
 */
export const POOL_CATEGORY_LABEL: Record<PoolCategory, string> = {
  RD: 'Reading',
  FT: 'Focused-Tech',
  FN: 'Fundamentals',
  TB: 'Tiebreaker',
};

function numberedLabels(category: Exclude<PoolCategory, 'TB'>, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${category}${i + 1}`);
}

/**
 * The exact label set a static-pool format's song pool must fill, one of
 * each, before it's well-formed. Single source of truth for both the web
 * pack view and the server's Save/Start-Tournament validation.
 */
export const FORMAT_SONG_LABELS: Partial<Record<FormatKey, readonly string[]>> = {
  'hb11-static-pool': [...numberedLabels('RD', 5), ...numberedLabels('FT', 3), ...numberedLabels('FN', 2), 'TB'],
  'hb13-static-pool': [...numberedLabels('RD', 6), ...numberedLabels('FT', 3), ...numberedLabels('FN', 3), 'TB'],
};

/** Strips the trailing digits off a numbered pool label to get its category, e.g. "RD3" -> "RD". "TB" has no digits and returns itself. */
export function poolCategoryOf(label: string): PoolCategory {
  return label.replace(/\d+$/, '') as PoolCategory;
}
