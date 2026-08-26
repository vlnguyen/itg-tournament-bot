import { useQuery } from '@tanstack/react-query';
import { fetchCurrentUser } from '../lib/api.js';

/** `null` means "not signed in," never an error — see `fetchCurrentUser`. */
export function useCurrentUser() {
  return useQuery({
    queryKey: ['current-user'],
    queryFn: fetchCurrentUser,
    staleTime: 60_000,
  });
}
