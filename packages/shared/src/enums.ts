import { z } from 'zod';

/**
 * These mirror the Prisma enums. Prisma cannot be imported here — the browser
 * must not pull in @prisma/client — so the duplication is unavoidable.
 * `packages/server/test/enum-parity.test.ts` asserts the two agree.
 */

export const PlayStyle = z.enum(['SINGLE', 'DOUBLE']);
export type PlayStyle = z.infer<typeof PlayStyle>;

export const DifficultySlot = z.enum(['NOVICE', 'EASY', 'MEDIUM', 'HARD', 'EXPERT']);
export type DifficultySlot = z.infer<typeof DifficultySlot>;

export const TournamentState = z.enum([
  'DRAFT',
  'REGISTRATION_OPEN',
  'REGISTRATION_CLOSED',
  'CHECKIN_OPEN',
  'CHECKIN_CLOSED',
  'RUNNING',
  'COMPLETE',
  'CANCELLED',
]);
export type TournamentState = z.infer<typeof TournamentState>;

/**
 * "Song packs can only support import before the tournament has started."
 * Importing rewrites the field's draw pool — once `RUNNING`, matches may
 * already be drawing from it. Shared so the client can hide the import
 * control exactly where the server would reject it, rather than the two
 * drifting out of sync.
 */
export function canImportPack(state: TournamentState): boolean {
  return state !== 'RUNNING' && state !== 'COMPLETE' && state !== 'CANCELLED';
}

/**
 * A static-pool tab's labels can be edited, and the tab itself deleted,
 * only before the tournament starts — matches `song-pool-service.ts`'s
 * `SONG_POOL_EDITABLE_STATES`. Once `RUNNING`, every match's `formatKey`
 * (and the Draw it draws from) is already generated and live, so a label
 * change or a deleted tab afterward couldn't do anything but silently
 * disagree with matches already underway. Shared so the client can hide
 * Save and the tab's "×" exactly where the server would reject them, same
 * reasoning as `canImportPack`. Tab *creation* isn't gated the same way —
 * an empty new tab, unpopulated, can't affect a running bracket at all.
 */
export function canEditSongPool(state: TournamentState): boolean {
  return state !== 'RUNNING' && state !== 'COMPLETE' && state !== 'CANCELLED';
}

/**
 * A match's format override can be set (or changed) only before the
 * tournament starts — matches `tournament-service.ts`'s
 * `MATCH_FORMAT_EDITABLE_STATES`. Once `RUNNING`, a match already has real
 * players and a Draw drawing from whatever pool its format implies;
 * once `COMPLETE`/`CANCELLED`, there's nothing left to reformat. This
 * holds regardless of whether the individual match itself is still
 * `PENDING` — a still-untouched future match's format is still locked the
 * moment the tournament as a whole has started. Shared so the client can
 * hide the format `Select` exactly where the server would reject it, same
 * reasoning as `canImportPack`.
 */
export function canEditMatchFormat(state: TournamentState): boolean {
  return state !== 'RUNNING' && state !== 'COMPLETE' && state !== 'CANCELLED';
}

/**
 * Whether an entrant has been removed from the tournament, and nothing else.
 * Attendance lives on `checkedIn`; "dropped for not checking in" is derived,
 * never stored. See DESIGN.md, "Who is on the roster".
 */
export const EntrantStatus = z.enum(['ACTIVE', 'WITHDRAWN']);
export type EntrantStatus = z.infer<typeof EntrantStatus>;

export const BracketSide = z.enum(['WINNERS', 'LOSERS', 'GRAND_FINAL']);
export type BracketSide = z.infer<typeof BracketSide>;

export const MatchStatus = z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETE', 'CANCELLED']);
export type MatchStatus = z.infer<typeof MatchStatus>;

/** The playstyle prefix that leads every chart display: SX, DX, SH, and so on. */
const SLOT_LETTER: Record<DifficultySlot, string> = {
  NOVICE: 'N',
  EASY: 'E',
  MEDIUM: 'M',
  HARD: 'H',
  EXPERT: 'X',
};

export function playstylePrefix(style: PlayStyle, slot: DifficultySlot): string {
  return `${style === 'SINGLE' ? 'S' : 'D'}${SLOT_LETTER[slot]}`;
}
