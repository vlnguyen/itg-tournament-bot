import {
  AdminGuildList,
  ChartImport,
  ChartSnapshot,
  ChartUpdate,
  CreateTournamentResult,
  FirstRunStatus,
  GuildOverview,
  GuildSummary,
  LifecycleRequest,
  LifecycleStatus,
  PlayerPage,
  PublicMatch,
  Roster,
  RulingRequest,
  RunView,
  SetupChannelsRequest,
  SetupRolesRequest,
  SetupStatus,
  Standings,
  TournamentSnapshot,
  type FormatKey,
  type MatchRef,
} from '@itg/shared';
import { z } from 'zod';

/**
 * Thin fetch wrappers, always validated against the same zod schemas the
 * server response is built from — "the client's types are z.infer of these
 * same schemas" per DESIGN.md. A shape mismatch fails loudly here rather
 * than silently rendering `undefined` somewhere deep in a component.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Populated only for `MixedFormatConflictError`'s 409 — `{ formatKey: matchCount }` — so the format picker can render the three-way choice without a second fetch. */
    readonly breakdown?: Record<string, number>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function fetchTournament(tournamentId: string): Promise<TournamentSnapshot> {
  const res = await fetch(`/api/tournaments/${tournamentId}`);
  if (!res.ok) throw new ApiError(res.status, `GET /api/tournaments/${tournamentId} -> ${res.status}`);
  return TournamentSnapshot.parse(await res.json());
}

export async function fetchMatch(matchId: string): Promise<PublicMatch> {
  const res = await fetch(`/api/matches/${matchId}`);
  if (!res.ok) throw new ApiError(res.status, `GET /api/matches/${matchId} -> ${res.status}`);
  return PublicMatch.parse(await res.json());
}

/** The homepage's server list — the guilds the signed-in user shares with the bot. `[]` for a signed-out request, never an error. */
export async function fetchMyGuilds(): Promise<GuildSummary[]> {
  const res = await fetch('/api/guilds');
  if (!res.ok) throw new ApiError(res.status, `GET /api/guilds -> ${res.status}`);
  return GuildSummary.array().parse(await res.json());
}

/** The `/g/:guildId` page itself — an active tournament, some history, or both empty. Never 404s; see the controller's comment. */
export async function fetchGuildOverview(guildId: string): Promise<GuildOverview> {
  const res = await fetch(`/api/guilds/${guildId}/overview`);
  if (!res.ok) throw new ApiError(res.status, `GET /api/guilds/${guildId}/overview -> ${res.status}`);
  return GuildOverview.parse(await res.json());
}

/** Always `canManage: false` for a signed-out request — never an error. See `FirstRunStatus`'s comment in `@itg/shared`. */
export async function fetchFirstRunStatus(guildId: string): Promise<FirstRunStatus> {
  const res = await fetch(`/api/guilds/${guildId}/first-run`);
  if (!res.ok) throw new ApiError(res.status, `GET /api/guilds/${guildId}/first-run -> ${res.status}`);
  return FirstRunStatus.parse(await res.json());
}

/** The web equivalent of `/tournament create` — Tournament Organizer tier and the one-tournament-per-guild slot are both enforced server-side; a rejection's message names why. */
export async function createTournamentForGuild(guildId: string, name: string): Promise<string> {
  const res = await fetch(`/api/guilds/${guildId}/tournaments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new ApiError(res.status, await describeError(res, `POST /api/guilds/${guildId}/tournaments -> ${res.status}`));
  return CreateTournamentResult.parse(await res.json()).tournamentId;
}

/** The web console's server-reconfiguration panel — the web equivalent of `/setup status`. 403s for anyone without Manage Server here. */
export async function fetchSetupStatus(guildId: string): Promise<SetupStatus> {
  const res = await fetch(`/api/guilds/${guildId}/setup`);
  if (!res.ok) throw new ApiError(res.status, await describeError(res, `GET /api/guilds/${guildId}/setup -> ${res.status}`));
  return SetupStatus.parse(await res.json());
}

export async function submitSetupChannels(guildId: string, request: SetupChannelsRequest): Promise<SetupStatus> {
  const res = await fetch(`/api/guilds/${guildId}/setup/channels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!res.ok) throw new ApiError(res.status, await describeError(res, `POST /api/guilds/${guildId}/setup/channels -> ${res.status}`));
  return SetupStatus.parse(await res.json());
}

export async function submitSetupRoles(guildId: string, request: SetupRolesRequest): Promise<SetupStatus> {
  const res = await fetch(`/api/guilds/${guildId}/setup/roles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!res.ok) throw new ApiError(res.status, await describeError(res, `POST /api/guilds/${guildId}/setup/roles -> ${res.status}`));
  return SetupStatus.parse(await res.json());
}

export async function submitSetupRepair(guildId: string): Promise<SetupStatus> {
  const res = await fetch(`/api/guilds/${guildId}/setup/repair`, { method: 'POST' });
  if (!res.ok) throw new ApiError(res.status, await describeError(res, `POST /api/guilds/${guildId}/setup/repair -> ${res.status}`));
  return SetupStatus.parse(await res.json());
}

/** The Bot Administrator's read-only server list — 403s for anyone else, checked by the caller before rendering it as such. */
export async function fetchAdminGuilds(): Promise<AdminGuildList> {
  const res = await fetch('/api/admin/guilds');
  if (!res.ok) throw new ApiError(res.status, await describeError(res, `GET /api/admin/guilds -> ${res.status}`));
  return AdminGuildList.parse(await res.json());
}

const CurrentUser = z.object({ discordUserId: z.string().nullable() });

/** `discordUserId: null` is a valid, non-error response — signed out, not a fetch failure. */
export async function fetchCurrentUser(): Promise<string | null> {
  const res = await fetch('/api/auth/me');
  if (!res.ok) throw new ApiError(res.status, `GET /api/auth/me -> ${res.status}`);
  return CurrentUser.parse(await res.json()).discordUserId;
}

export async function fetchRunView(tournamentId: string): Promise<RunView> {
  const res = await fetch(`/api/tournaments/${tournamentId}/run-view`);
  if (!res.ok) throw new ApiError(res.status, `GET /api/tournaments/${tournamentId}/run-view -> ${res.status}`);
  return RunView.parse(await res.json());
}

const ErrorBody = z.object({ message: z.union([z.string(), z.array(z.unknown())]) });

/** Nest's default exception filter body — `message` is a string for a plain `BadRequestException(str)`, an array of zod issues for `BadRequestException(err.issues)`. Either way, something readable to show next to the control that failed beats a bare status code. */
async function describeError(res: Response, fallback: string): Promise<string> {
  try {
    const body = ErrorBody.parse(await res.json());
    return typeof body.message === 'string' ? body.message : fallback;
  } catch {
    return fallback;
  }
}

export async function submitRuling(matchId: string, ruling: RulingRequest): Promise<PublicMatch> {
  const res = await fetch(`/api/matches/${matchId}/rulings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ruling),
  });
  if (!res.ok) throw new ApiError(res.status, await describeError(res, `POST /api/matches/${matchId}/rulings -> ${res.status}`));
  return PublicMatch.parse(await res.json());
}

export async function fetchRoster(tournamentId: string): Promise<Roster> {
  const res = await fetch(`/api/tournaments/${tournamentId}/roster`);
  if (!res.ok) throw new ApiError(res.status, await describeError(res, `GET /api/tournaments/${tournamentId}/roster -> ${res.status}`));
  return Roster.parse(await res.json());
}

export async function submitSeeding(tournamentId: string, order: string[]): Promise<Roster> {
  const res = await fetch(`/api/tournaments/${tournamentId}/seeding`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order }),
  });
  if (!res.ok) throw new ApiError(res.status, await describeError(res, `POST /api/tournaments/${tournamentId}/seeding -> ${res.status}`));
  return Roster.parse(await res.json());
}

export async function fetchLifecycleStatus(tournamentId: string): Promise<LifecycleStatus> {
  const res = await fetch(`/api/tournaments/${tournamentId}/lifecycle`);
  if (!res.ok) throw new ApiError(res.status, await describeError(res, `GET /api/tournaments/${tournamentId}/lifecycle -> ${res.status}`));
  return LifecycleStatus.parse(await res.json());
}

const ConflictBody = z.object({ message: z.string(), breakdown: z.record(z.string(), z.number()) });

export async function submitLifecycleAction(tournamentId: string, request: LifecycleRequest): Promise<LifecycleStatus> {
  const res = await fetch(`/api/tournaments/${tournamentId}/lifecycle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    const fallback = `POST /api/tournaments/${tournamentId}/lifecycle -> ${res.status}`;
    const body = await res.json().catch(() => null);
    // A 409 here can only be `MixedFormatConflictError` (SET_FORMAT with no
    // `mode`, matches on more than one format) — everything else this
    // endpoint rejects is a plain `TournamentTransitionError`, a 400.
    if (res.status === 409) {
      const parsed = ConflictBody.safeParse(body);
      if (parsed.success) throw new ApiError(res.status, parsed.data.message, parsed.data.breakdown);
    }
    throw new ApiError(res.status, typeof body?.message === 'string' ? body.message : fallback);
  }
  return LifecycleStatus.parse(await res.json());
}

/** `setMatchFormats`'s wire endpoint — assigns one format to one or more matches at once (a single match, a whole round, or an arbitrary selection). */
export async function submitMatchFormats(tournamentId: string, refs: MatchRef[], formatKey: FormatKey): Promise<void> {
  const res = await fetch(`/api/tournaments/${tournamentId}/match-formats`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refs, formatKey }),
  });
  if (!res.ok) throw new ApiError(res.status, await describeError(res, `POST /api/tournaments/${tournamentId}/match-formats -> ${res.status}`));
}

export async function fetchStandings(tournamentId: string): Promise<Standings> {
  const res = await fetch(`/api/tournaments/${tournamentId}/standings`);
  if (!res.ok) throw new ApiError(res.status, `GET /api/tournaments/${tournamentId}/standings -> ${res.status}`);
  return Standings.parse(await res.json());
}

export async function fetchPlayerPage(guildId: string, discordUserId: string): Promise<PlayerPage> {
  const res = await fetch(`/api/guilds/${guildId}/players/${discordUserId}`);
  if (!res.ok) throw new ApiError(res.status, `GET /api/guilds/${guildId}/players/${discordUserId} -> ${res.status}`);
  return PlayerPage.parse(await res.json());
}

export async function fetchCharts(tournamentId: string): Promise<ChartSnapshot[]> {
  const res = await fetch(`/api/tournaments/${tournamentId}/charts`);
  if (!res.ok) throw new ApiError(res.status, `GET /api/tournaments/${tournamentId}/charts -> ${res.status}`);
  return z.array(ChartSnapshot).parse(await res.json());
}

const ImportResult = z.object({ imported: z.number().int().nonnegative() });

/** Server-side re-validates against this exact `ChartImport` shape regardless — see DESIGN.md, "the client fully controls that payload." */
export async function importCharts(tournamentId: string, charts: ChartImport['charts']): Promise<{ imported: number }> {
  const res = await fetch(`/api/tournaments/${tournamentId}/charts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ charts }),
  });
  if (!res.ok) throw new ApiError(res.status, `POST /api/tournaments/${tournamentId}/charts -> ${res.status}`);
  return ImportResult.parse(await res.json());
}

const CommitPackChangesResult = z.object({ updated: z.number().int().nonnegative(), deleted: z.number().int().nonnegative() });

/** The pack management table's Save — only the rows the caller actually touched, edited or deleted. Never gated by tournament state; see the controller's comment. */
export async function commitPackChanges(
  tournamentId: string,
  updates: ChartUpdate[],
  deletes: string[],
): Promise<{ updated: number; deleted: number }> {
  const res = await fetch(`/api/tournaments/${tournamentId}/charts`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ updates, deletes }),
  });
  if (!res.ok) throw new ApiError(res.status, await describeError(res, `PATCH /api/tournaments/${tournamentId}/charts -> ${res.status}`));
  return CommitPackChangesResult.parse(await res.json());
}
