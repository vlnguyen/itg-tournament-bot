import { z } from 'zod';

/**
 * Per-tournament configuration. Every field is an alert threshold or an
 * estimate — nothing inside a match format is configurable.
 */
export const TournamentConfig = z.object({
  matchStartWindowMinutes: z.number().int().positive().default(10),
  matchTimeLimitMinutes: z.number().int().positive().default(25),
  perMatchAllocationMinutes: z.number().int().positive().default(25),
});

export type TournamentConfig = z.infer<typeof TournamentConfig>;

export const DEFAULT_TOURNAMENT_CONFIG: TournamentConfig = TournamentConfig.parse({});
