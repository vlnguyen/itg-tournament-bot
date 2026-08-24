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

export const EntrantStatus = z.enum(['ACTIVE', 'NOT_CHECKED_IN', 'WITHDRAWN']);
export type EntrantStatus = z.infer<typeof EntrantStatus>;

export const BracketSide = z.enum(['WINNERS', 'LOSERS', 'GRAND_FINAL']);
export type BracketSide = z.infer<typeof BracketSide>;

export const MatchStatus = z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETE']);
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
