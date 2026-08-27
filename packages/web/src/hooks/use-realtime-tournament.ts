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
 *
 * Same reasoning covers the tournament snapshot's own `state` and
 * standings: a frame only patches the one match cell it names (see
 * `applyFrameToSnapshot`), so a match that also completes the tournament
 * — an ordinary final, or a tournament-scope DQ's walkover chain closing
 * it out — would otherwise leave the header badge and the standings table
 * stuck on stale data until something else refetched them. Invalidating
 * both alongside the patch keeps the patch's snappy paint and lets the
 * background refetch correct anything the patch alone couldn't.
 *
 * A `lifecycle` event (no payload — `RealtimeBroadcastPort.
 * publishLifecycleChanged`) covers everything a frame can't: a lifecycle
 * transition — open/close registration, open/close check-in, start,
 * cancel, rename — from *any* surface, a Discord command included, has no
 * associated match event to ride along with. Without this, a transition
 * made in Discord left the config page's legal-actions checklist (and
 * every other page's header badge) stuck on stale data until a manual
 * reload — the same staleness a match frame already covers for
 * match-driven completions.
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
      void queryClient.invalidateQueries({ queryKey: ['tournament', tournamentId] });
      void queryClient.invalidateQueries({ queryKey: ['standings', tournamentId] });
    };
    socket.on('frame', onFrame);

    const onLifecycle = (): void => {
      void queryClient.invalidateQueries({ queryKey: ['tournament', tournamentId] });
      void queryClient.invalidateQueries({ queryKey: ['lifecycle', tournamentId] });
    };
    socket.on('lifecycle', onLifecycle);

    return () => {
      socket.emit('unsubscribe', { tournamentId });
      socket.off('connect', subscribe);
      socket.off('frame', onFrame);
      socket.off('lifecycle', onLifecycle);
    };
  }, [tournamentId, queryClient]);
}
