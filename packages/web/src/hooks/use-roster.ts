import { useQuery } from '@tanstack/react-query';
import { ApiError, fetchRoster } from '../lib/api.js';

/**
 * No retry on 403/404 — "you're not a Tournament Organizer here" / "no such
 * tournament," not transient. `enabled` defaults to true for the roster
 * page's own use; the bracket page passes `isOrganizer` so a spectator
 * viewing a live bracket never fires a request that's a guaranteed 403.
 */
export function useRoster(tournamentId: string, enabled = true) {
  return useQuery({
    queryKey: ['roster', tournamentId],
    queryFn: () => fetchRoster(tournamentId),
    enabled,
    retry: (failureCount, err) => !(err instanceof ApiError && (err.status === 403 || err.status === 404)) && failureCount < 3,
  });
}
