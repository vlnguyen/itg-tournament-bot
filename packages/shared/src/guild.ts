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
 * One server on the homepage's server list, however it got there — either
 * every Discord server this signed-in user holds Manage Guild (or
 * ownership) in, from the `guilds` OAuth2 scope's token pair (see
 * `DiscordGuildsService.manageableGuildsFor`), or every server the bot's
 * own gateway cache shows the user holding the Tournament Organizer role in
 * (see `TierService.organizerOnlyGuildsFor`). The OAuth-sourced list can
 * include servers the bot has never been added to; `botPresent` is what
 * tells the client whether a card should link into `/g/:guildId` or offer
 * `inviteUrl` instead — always `true`/`null` for the organizer-only list,
 * since TO role membership can only ever be known for a server the bot is
 * already in. `iconUrl` is `null` whenever the guild has no icon set; the
 * client supplies its own fallback.
 */
export const GuildSummary = z.object({
  id: z.string().min(1),
  name: z.string(),
  iconUrl: z.string().nullable(),
  botPresent: z.boolean(),
  inviteUrl: z.string().nullable(),
});
export type GuildSummary = z.infer<typeof GuildSummary>;

/**
 * `GET /api/guilds` — the homepage's two server lists. `managed` is every
 * server this user holds Manage Guild (or ownership) in; `organizerOnly` is
 * every server the bot can see this user holding the Tournament Organizer
 * role in, excluding anything already in `managed` — a Manage Guild holder
 * who is also a TO in the same server sees it once, in `managed`.
 */
export const MyGuilds = z.object({
  managed: GuildSummary.array(),
  organizerOnly: GuildSummary.array(),
});
export type MyGuilds = z.infer<typeof MyGuilds>;

/**
 * `GET /api/guilds/:guildId/overview` — the `/g/:guildId` page itself, not
 * a redirect into one tournament. `activeTournament` is the same "public
 * current tournament" notion `/pack` uses (`findPublicCurrentTournament`):
 * `null` whenever nothing not-yet-announced-or-finished is running.
 * `history` is every `COMPLETE`/`CANCELLED` tournament this guild has run,
 * newest first — `DRAFT` never appears in either field, same reasoning as
 * `FirstRunStatus`. `guildName` is resolved live from the bot's own
 * client, same as `TournamentSnapshot.guildName` — falls back to the raw
 * id if the bot isn't in the guild (or isn't connected).
 */
export const GuildOverview = z.object({
  activeTournament: TournamentSummary.nullable(),
  history: z.array(TournamentSummary),
  guildName: z.string(),
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
 *
 * `hasManageGuild` is the raw Manage Guild check on its own, separate from
 * `canManage`'s union with Tournament Organizer tier — the client needs it
 * to hide "Server Settings" from a TO-only viewer, since reconfiguring the
 * server stays Manage-Guild-only even though the first-run wizard itself is
 * open to either.
 */
export const FirstRunStatus = z.object({
  canManage: z.boolean(),
  hasManageGuild: z.boolean(),
  missingConfig: z.array(z.string()),
  draftTournamentId: z.string().min(1).nullable(),
  draftTournamentName: z.string().nullable(),
});
export type FirstRunStatus = z.infer<typeof FirstRunStatus>;

/** `POST /api/guilds/:guildId/tournaments` body — the web equivalent of `/tournament create`. */
export const CreateTournamentRequest = z.object({ name: z.string().min(1) });
export type CreateTournamentRequest = z.infer<typeof CreateTournamentRequest>;

export const CreateTournamentResult = z.object({ tournamentId: z.string().min(1) });
export type CreateTournamentResult = z.infer<typeof CreateTournamentResult>;
