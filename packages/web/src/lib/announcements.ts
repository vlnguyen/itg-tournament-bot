import type { RealtimeFrame } from '@itg/shared';
import { deriveBracketMatch } from '@itg/shared';

export interface Announcement {
  /** Goes into the `role="log"` region — every change, browsed at the reader's own pace. Never interrupts. */
  logLine: string;
  /**
   * Set only for a genuine bracket-level transition — a match completing,
   * a walkover, a new escalation — per DESIGN.md, "What gets spoken": "The
   * bracket's polite live region speaks only bracket-level events." `null`
   * for an ordinary scoreline update (a song committed, points changed),
   * which the log alone carries.
   */
  politeLine: string | null;
}

/** What the caller last knew about this match — how a transition (not a repeat) is told apart from a re-announcement of an already-decided match. */
export interface KnownMatchState {
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETE';
  awaitingTo: boolean;
}

/**
 * One frame in, one announcement out. `matchLabel` is the caller's
 * responsibility (e.g. "Winners Round 1") — this only knows about the one
 * match the frame concerns, not the bracket's structure.
 */
export function describeFrame(frame: RealtimeFrame, matchLabel: string, previous: KnownMatchState | undefined): Announcement {
  const m = deriveBracketMatch(frame.projection);
  const [p0, p1] = m.participants;
  const score = p0 && p1 ? `${p0.displayName} ${m.points[p0.entrantId] ?? 0}, ${p1.displayName} ${m.points[p1.entrantId] ?? 0}` : '';

  if (m.status === 'COMPLETE' && previous?.status !== 'COMPLETE') {
    const winner = m.participants.find((p) => p.entrantId === m.winnerId);
    const walkover = m.outcomeBy === 'WALKOVER';
    const line = winner
      ? `${matchLabel}: ${winner.displayName}${walkover ? ' advances by walkover' : ' wins'}, ${score}.`
      : `${matchLabel} is decided.`;
    return { logLine: line, politeLine: line };
  }

  if (m.awaitingTo && !previous?.awaitingTo) {
    const line = `${matchLabel}: awaiting an organizer.`;
    return { logLine: line, politeLine: line };
  }

  return { logLine: `${matchLabel}: ${score}.`, politeLine: null };
}
