import { z } from 'zod';
import { BracketSide } from './enums.js';

/** `GET /api/tournaments/:id/standings` — `computeTournamentStandings`'s output, unchanged, over the wire. Empty until the tournament has a decided outcome. */
export const StandingsRow = z.object({
  entrantId: z.string().min(1),
  seed: z.number().int().positive(),
  displayName: z.string(),
  place: z.number().int().positive(),
});
export type StandingsRow = z.infer<typeof StandingsRow>;

export const Standings = z.array(StandingsRow);
export type Standings = z.infer<typeof Standings>;

/**
 * `GET /api/guilds/:guildId/players/:discordUserId` — DESIGN.md, "Player
 * pages": "keyed on the user ID, scoped to the server... the page carries
 * their matches — opponent, round, score, link to the detail — and their
 * win-loss record for that server." Only decided matches appear; a match
 * still in progress has no `won`/final score to show here yet.
 */
export const PlayerMatchRow = z.object({
  tournamentId: z.string().min(1),
  tournamentName: z.string(),
  matchId: z.string().min(1),
  bracket: BracketSide,
  round: z.number().int().positive(),
  /** The display name they competed under *in that tournament* — `Entrant.displayName`, never the current name. */
  displayNameThen: z.string(),
  opponentDisplayName: z.string().nullable(),
  points: z.number().int().nonnegative(),
  opponentPoints: z.number().int().nonnegative(),
  won: z.boolean(),
});
export type PlayerMatchRow = z.infer<typeof PlayerMatchRow>;

export const PlayerPage = z.object({
  discordUserId: z.string().min(1),
  /** From the `User` cache — the player's *current* name, never a historical snapshot. Falls back to their most recent tournament snapshot when they've never signed in. */
  currentDisplayName: z.string(),
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  matches: z.array(PlayerMatchRow),
});
export type PlayerPage = z.infer<typeof PlayerPage>;
