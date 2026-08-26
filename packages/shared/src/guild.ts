import { z } from 'zod';
import { TournamentState } from './enums.js';

/** One row in a guild's tournament history — never `DRAFT`, which this whole shape exists to keep unannounced. */
export const TournamentSummary = z.object({
  id: z.string().min(1),
  name: z.string(),
  state: TournamentState,
  createdAt: z.string(),
});
export type TournamentSummary = z.infer<typeof TournamentSummary>;

/**
 * `GET /api/guilds/:guildId/overview` — the `/g/:guildId` page itself, not
 * a redirect into one tournament. `activeTournament` is the same "public
 * current tournament" notion `/pack` uses (`findPublicCurrentTournament`):
 * `null` whenever nothing not-yet-announced-or-finished is running.
 * `history` is every `COMPLETE`/`CANCELLED` tournament this guild has run,
 * newest first — `DRAFT` never appears in either field, same reasoning as
 * `FirstRunStatus`.
 */
export const GuildOverview = z.object({
  activeTournament: TournamentSummary.nullable(),
  history: z.array(TournamentSummary),
});
export type GuildOverview = z.infer<typeof GuildOverview>;

/**
 * `GET /api/guilds/:guildId/first-run` — the first-run wizard, DESIGN.md's
 * "a view over Guild/DRAFT Tournament rows, no separate wizard state."
 * Backs the guild page's branch for a guild with no active tournament and
 * no history at all, for whoever can actually act on it.
 *
 * `canManage` is false for anyone signed out, or signed in but holding
 * neither Manage Guild nor Tournament Organizer tier here — the same
 * "reveal nothing to someone who can't act" shape `GuildOverview` already
 * uses for an unknown guild. `missingConfig` and `draftTournamentId` are
 * only ever populated alongside `canManage: true`; a `DRAFT` tournament is
 * exactly the thing `GuildOverview` must never surface, so gating it here
 * is what keeps that leak from happening a second way.
 */
export const FirstRunStatus = z.object({
  canManage: z.boolean(),
  missingConfig: z.array(z.string()),
  draftTournamentId: z.string().min(1).nullable(),
});
export type FirstRunStatus = z.infer<typeof FirstRunStatus>;

/** `POST /api/guilds/:guildId/tournaments` body — the web equivalent of `/tournament create`. */
export const CreateTournamentRequest = z.object({ name: z.string().min(1) });
export type CreateTournamentRequest = z.infer<typeof CreateTournamentRequest>;

export const CreateTournamentResult = z.object({ tournamentId: z.string().min(1) });
export type CreateTournamentResult = z.infer<typeof CreateTournamentResult>;
