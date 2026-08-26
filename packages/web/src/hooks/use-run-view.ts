import { useQuery } from '@tanstack/react-query';
import { ApiError, fetchRunView } from '../lib/api.js';

/** No retry on 403/404 — those are "you don't have Referee tier" / "no such tournament," not a transient failure. */
export function useRunView(tournamentId: string) {
  return useQuery({
    queryKey: ['run-view', tournamentId],
    queryFn: () => fetchRunView(tournamentId),
    retry: (failureCount, err) => !(err instanceof ApiError && (err.status === 403 || err.status === 404)) && failureCount < 3,
  });
}
