import { ChartImport, ChartSnapshot, LandingTournament, PlayerPage, PublicMatch, Standings, TournamentSnapshot } from '@itg/shared';
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

export async function fetchLandingTournament(guildId: string): Promise<LandingTournament> {
  const res = await fetch(`/api/guilds/${guildId}/landing-tournament`);
  if (!res.ok) throw new ApiError(res.status, `GET /api/guilds/${guildId}/landing-tournament -> ${res.status}`);
  return LandingTournament.parse(await res.json());
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
