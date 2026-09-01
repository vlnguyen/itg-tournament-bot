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
export const FormatKey = z.enum(['bo5-protect-veto', 'bo3-protect-veto']);
export type FormatKey = z.infer<typeof FormatKey>;

export const FORMAT_LABEL: Record<FormatKey, string> = {
  'bo5-protect-veto': 'Best of 5, 7 songs (Storm 2026)',
  'bo3-protect-veto': 'Best of 3, 5 songs',
};

/** A bracket cell or a Discord autocomplete list has no room for `FORMAT_LABEL`'s full sentence — this is the same distinction `thread-name.ts`'s abbreviated round codes draw against `sectionLabel`'s prose. */
export const FORMAT_SHORT_LABEL: Record<FormatKey, string> = {
  'bo5-protect-veto': 'BO5',
  'bo3-protect-veto': 'BO3',
};
