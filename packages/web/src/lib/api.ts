import { LandingTournament, PublicMatch, TournamentSnapshot } from '@itg/shared';

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
