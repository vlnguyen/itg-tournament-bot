import { useQuery } from '@tanstack/react-query';
import { fetchMatch } from '../lib/api.js';

export function useMatch(matchId: string) {
  return useQuery({
    queryKey: ['match', matchId],
    queryFn: () => fetchMatch(matchId),
  });
}
