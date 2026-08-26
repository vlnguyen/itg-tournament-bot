import { z } from 'zod';

/**
 * `GET /api/guilds/:guildId/landing-tournament` — what a server's landing
 * page redirects to. `null` only when the guild has never had a
 * non-`DRAFT` tournament. See DESIGN.md, "Permanent URLs".
 */
export const LandingTournament = z.object({
  tournamentId: z.string().min(1).nullable(),
});
export type LandingTournament = z.infer<typeof LandingTournament>;
