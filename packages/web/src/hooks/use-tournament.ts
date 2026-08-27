import { useQuery } from '@tanstack/react-query';
import { fetchTournament } from '../lib/api.js';

export function useTournament(tournamentId: string) {
  return useQuery({
    queryKey: ['tournament', tournamentId],
    queryFn: () => fetchTournament(tournamentId),
  });
}
