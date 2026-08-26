import type { RealtimeFrame, TournamentSnapshot } from '@itg/shared';
import { useEffect, useRef, useState } from 'react';
import { describeFrame, type KnownMatchState } from '../lib/announcements.js';
import { sectionLabel } from '../lib/section-label.js';
import { getSocket } from '../lib/socket.js';
import type { Verbosity } from './use-verbosity.js';

const LOG_LIMIT = 50;

/**
 * Turns the raw frame stream into the two announcement channels DESIGN.md's
 * "What gets spoken" describes: a passive `role="log"` history (every
 * change, browsed at the reader's own pace, capped so it doesn't grow
 * without bound over a long event) and a `politeLine` fired only for a
 * genuine bracket-level transition — gated by `verbosity` so "off" stays
 * silent and "all" also speaks ordinary scoreline updates, not just
 * completions.
 */
export function useBracketAnnouncements(
  tournamentId: string,
  snapshot: TournamentSnapshot | undefined,
  verbosity: Verbosity,
): { log: string[]; politeLine: string } {
  const [log, setLog] = useState<string[]>([]);
  const [politeLine, setPoliteLine] = useState('');
  const known = useRef(new Map<string, KnownMatchState>());
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  useEffect(() => {
    // Every match's current state, so the first frame for each one is
    // judged against what the initial snapshot already showed rather than
    // "nothing" — otherwise a page opened mid-tournament would announce
    // every already-decided match as newly completing on its first frame.
    known.current = new Map(
      (snapshot?.matches ?? []).map((m) => [m.id, { status: m.match.status, awaitingTo: m.match.awaitingTo }]),
    );
  }, [snapshot]);

  useEffect(() => {
    const socket = getSocket();

    const onFrame = (frame: RealtimeFrame): void => {
      const entry = snapshotRef.current?.matches.find((m) => m.id === frame.matchId);
      if (!entry) return; // not this tournament's frame, or arrived before the snapshot loaded

      const label = sectionLabel(entry.bracket, entry.round);
      const announcement = describeFrame(frame, label, known.current.get(entry.id));
      known.current.set(entry.id, {
        status: frame.projection.outcome ? 'COMPLETE' : 'IN_PROGRESS',
        awaitingTo: frame.projection.pending.kind === 'AWAITING_TO',
      });

      if (verbosity === 'off') return;
      setLog((prev) => [...prev.slice(-(LOG_LIMIT - 1)), announcement.logLine]);

      if (announcement.politeLine) setPoliteLine(announcement.politeLine);
      else if (verbosity === 'all') setPoliteLine(announcement.logLine);
    };

    socket.on('frame', onFrame);
    return () => {
      socket.off('frame', onFrame);
    };
  }, [tournamentId, verbosity]);

  return { log, politeLine };
}
