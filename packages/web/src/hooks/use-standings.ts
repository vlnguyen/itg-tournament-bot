import { useQuery } from '@tanstack/react-query';
import { fetchStandings } from '../lib/api.js';

export function useStandings(tournamentId: string) {
  return useQuery({
    queryKey: ['standings', tournamentId],
    queryFn: () => fetchStandings(tournamentId),
  });
}
