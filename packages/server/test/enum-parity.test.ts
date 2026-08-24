import { describe, expect, it } from 'vitest';
import {
  BracketSide,
  DifficultySlot,
  EntrantStatus,
  MatchStatus,
  PlayStyle,
  TournamentState,
} from '@itg/shared';
import {
  BracketSide as PrismaBracketSide,
  DifficultySlot as PrismaDifficultySlot,
  EntrantStatus as PrismaEntrantStatus,
  MatchStatus as PrismaMatchStatus,
  PlayStyle as PrismaPlayStyle,
  TournamentState as PrismaTournamentState,
} from '@prisma/client';

/**
 * The shared package cannot import @prisma/client — the browser must not pull
 * it in — so every enum is declared twice. This is the guard that keeps the
 * two copies honest.
 */
describe('shared enums match the Prisma enums', () => {
  const cases: ReadonlyArray<[string, readonly string[], Record<string, string>]> = [
    ['PlayStyle', PlayStyle.options, PrismaPlayStyle],
    ['DifficultySlot', DifficultySlot.options, PrismaDifficultySlot],
    ['TournamentState', TournamentState.options, PrismaTournamentState],
    ['EntrantStatus', EntrantStatus.options, PrismaEntrantStatus],
    ['BracketSide', BracketSide.options, PrismaBracketSide],
    ['MatchStatus', MatchStatus.options, PrismaMatchStatus],
  ];

  for (const [name, shared, prisma] of cases) {
    it(`${name} agrees in both directions`, () => {
      expect([...shared].sort()).toEqual(Object.values(prisma).sort());
    });
  }
});
