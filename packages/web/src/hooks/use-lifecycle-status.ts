import { useQuery } from '@tanstack/react-query';
import { ApiError, fetchLifecycleStatus } from '../lib/api.js';

/** No retry on 403/404 — "you're not a Tournament Organizer here" / "no such tournament," not transient. */
export function useLifecycleStatus(tournamentId: string) {
  return useQuery({
    queryKey: ['lifecycle', tournamentId],
    queryFn: () => fetchLifecycleStatus(tournamentId),
    retry: (failureCount, err) => !(err instanceof ApiError && (err.status === 403 || err.status === 404)) && failureCount < 3,
  });
}
