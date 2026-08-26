import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { getSocket } from '../lib/socket.js';

/**
 * Subscribes to the same `tournament:{id}` room the public bracket does,
 * but for the seeding page's own concern: a join, check-in, un-check-in,
 * withdrawal, removal, or reorder from *any* surface — a Discord command
 * included — has to reach a browser with the roster open. The `roster`
 * event carries no payload (see `RealtimeBroadcastPort.publishRosterChanged`
 * server-side): a roster row is cheap to refetch whole, and there's no
 * `seq`-ordered projection here to patch in place the way a match frame
 * has, so this just invalidates and lets `useRoster` refetch.
 *
 * Re-subscribes on every `connect` (including the first), same as
 * `useRealtimeTournament` — a reconnect after a drop needs to rejoin the
 * room, and a stale roster on reconnect is covered by the invalidation
 * firing again once the next change lands, or by the query's own refetch.
 */
export function useRealtimeRoster(tournamentId: string): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const socket = getSocket();

    const subscribe = (): void => {
      socket.emit('subscribe', { tournamentId });
    };
    socket.on('connect', subscribe);
    if (socket.connected) subscribe();

    const onRosterChanged = (): void => {
      void queryClient.invalidateQueries({ queryKey: ['roster', tournamentId] });
    };
    socket.on('roster', onRosterChanged);

    return () => {
      socket.emit('unsubscribe', { tournamentId });
      socket.off('connect', subscribe);
      socket.off('roster', onRosterChanged);
    };
  }, [tournamentId, queryClient]);
}
