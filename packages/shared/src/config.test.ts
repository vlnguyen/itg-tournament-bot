import { describe, expect, it } from 'vitest';
import { DEFAULT_TOURNAMENT_CONFIG, TournamentConfig } from './config.js';

describe('TournamentConfig', () => {
  it('defaults to the values the requirements state', () => {
    expect(DEFAULT_TOURNAMENT_CONFIG).toEqual({
      matchStartWindowMinutes: 10,
      matchTimeLimitMinutes: 25,
      perMatchAllocationMinutes: 25,
    });
  });

  it('rejects non-positive durations', () => {
    expect(TournamentConfig.safeParse({ matchTimeLimitMinutes: 0 }).success).toBe(false);
    expect(TournamentConfig.safeParse({ matchStartWindowMinutes: -1 }).success).toBe(false);
  });
});
