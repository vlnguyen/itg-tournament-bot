import type { PublicMatch, RealtimeFrame, TournamentSnapshot } from '@itg/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { applyFrameToMatchDetail, applyFrameToSnapshot } from '../lib/realtime-frames.js';
import { getSocket } from '../lib/socket.js';

/**
 * Subscribes to `tournament:{id}` and patches both the tournament-snapshot
 * query and any open match-detail query as frames arrive. See DESIGN.md,
 * "Realtime": "Resync is by refetch, not replay" — `refetchOnReconnect`
 * (TanStack Query's own default) handles fetching a fresh snapshot on
 * reconnect; this hook only needs to re-join the socket room when the
 * underlying connection comes back, which `subscribe` on every `connect`
 * event covers, including the first one.
 *
 * Also invalidates the run view — "both panes are fed by the same
 * websocket subscription as the public bracket," DESIGN.md, "The run
 * view." A frame doesn't carry enough to patch `RunView` in place (elapsed
 * time, alert ordering, `since` strings are all server-computed), so this
 * just triggers a refetch; harmless when no run-view query is mounted.
 */
export function useRealtimeTournament(tournamentId: string): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const socket = getSocket();

    const subscribe = (): void => {
      socket.emit('subscribe', { tournamentId });
    };
    socket.on('connect', subscribe);
    if (socket.connected) subscribe();

    const onFrame = (frame: RealtimeFrame): void => {
      queryClient.setQueryData<TournamentSnapshot>(['tournament', tournamentId], (snapshot) =>
        snapshot ? applyFrameToSnapshot(snapshot, frame) : snapshot,
      );
      queryClient.setQueryData<PublicMatch>(['match', frame.matchId], (current) =>
        applyFrameToMatchDetail(current, frame),
      );
      void queryClient.invalidateQueries({ queryKey: ['run-view', tournamentId] });
    };
    socket.on('frame', onFrame);

    return () => {
      socket.emit('unsubscribe', { tournamentId });
      socket.off('connect', subscribe);
      socket.off('frame', onFrame);
    };
  }, [tournamentId, queryClient]);
}
