import type { ChartSnapshot } from '@itg/shared';
import type {
  EntrantId,
  MatchFormat,
  MatchOutcome,
  MatchState,
  PendingAction,
  SongRecord,
  TiebreakRound,
} from './types.js';

/**
 * The only way match state reaches a browser, a public API response, a
 * websocket frame, or the thread's own result summary — one function, so a
 * leak is a bug in one place rather than a rule every caller has to
 * remember. See DESIGN.md, "Public Projections and Hidden State".
 *
 * A tiebreak round in progress is the one place hiding is load-bearing:
 * "the thread shows *that* a player has chosen without revealing what."
 * Nothing else in `MatchState` is sensitive — Protect/Veto picks and song
 * winner selections are visible to both players the moment they land, by
 * requirement; only a secret pick among still-unplayed charts is a genuine
 * prisoner's-dilemma leak.
 *
 * A referee's identity never appears here either, but that costs nothing to
 * enforce: `MatchState` never records who ruled — `SongRecord.result.by` is
 * `'RULING'`, not an actor id — so "the public match view says only
 * 'resolved by an organizer'" already holds by construction, not by a strip
 * step in this file.
 */

export interface PublicSong {
  index: number;
  chart: ChartSnapshot;
  source: SongRecord['source'];
  drawIndex?: number | undefined;
  tiebreakRound?: number | undefined;
  ex: Partial<Record<EntrantId, number>>;
  photoSeen: Partial<Record<EntrantId, boolean>>;
  selections: Partial<Record<EntrantId, EntrantId | 'TIE'>>;
  result?: SongRecord['result'];
}

/**
 * `choices`/`resolvedIndex` exist only once both players have picked — until
 * then `chosenBy` is the whole of what this says. That is the entire hiding
 * rule; everything else about a round (which three charts) is public from
 * the draw.
 */
export type PublicTiebreakRound =
  | { round: number; charts: ChartSnapshot[]; chosenBy: EntrantId[] }
  | {
      round: number;
      charts: ChartSnapshot[];
      chosenBy: EntrantId[];
      choices: Record<EntrantId, number>;
      resolvedIndex: number;
    };

export interface PublicMatch {
  /**
   * `state.seq` — the resync ordering the realtime layer needs. See
   * DESIGN.md, "Realtime": every frame carries `{ matchId, seq, projection
   * }` so a client can "drop any [frame] whose seq is not greater than
   * what it holds." Carrying it in the projection itself (not only
   * alongside it in the frame) is what lets a REST-fetched snapshot seed
   * that comparison too — otherwise a client that just refetched has
   * nothing to compare a late, reordered frame against.
   */
  seq: number;
  /** The ruleset this match ran under. Known to the projection directly — unlike `bracket`/`round`, this needs no outside join. */
  formatKey: string;
  participants: { entrantId: EntrantId; seed: number }[];
  a?: EntrantId | undefined;
  b?: EntrantId | undefined;
  draw: ChartSnapshot[];
  protects: { drawIndex: number; by: EntrantId }[];
  vetoes: { drawIndex: number; by: EntrantId }[];
  deciderIndex?: number | undefined;
  songs: PublicSong[];
  points: Record<EntrantId, number>;
  tiebreaks: PublicTiebreakRound[];
  escalation?: MatchState['escalation'];
  setWinnerSelections: MatchState['setWinnerSelections'];
  pending: PendingAction;
  outcome: MatchOutcome | null;
}

function toPublicTiebreak(t: TiebreakRound): PublicTiebreakRound {
  const chosenBy = Object.keys(t.choices);
  if (t.resolvedIndex === undefined) {
    return { round: t.round, charts: t.charts, chosenBy };
  }
  return {
    round: t.round,
    charts: t.charts,
    chosenBy,
    choices: t.choices as Record<EntrantId, number>,
    resolvedIndex: t.resolvedIndex,
  };
}

export function toPublicMatch(format: MatchFormat, state: MatchState): PublicMatch {
  return {
    seq: state.seq,
    formatKey: format.key,
    participants: state.participants,
    a: state.a,
    b: state.b,
    draw: state.draw,
    protects: state.protects,
    vetoes: state.vetoes,
    deciderIndex: state.deciderIndex,
    songs: state.songs.map((s, index) => ({
      index,
      chart: s.chart,
      source: s.source,
      drawIndex: s.drawIndex,
      tiebreakRound: s.tiebreakRound,
      ex: s.ex,
      photoSeen: s.photoSeen,
      selections: s.selections,
      result: s.result,
    })),
    points: state.points,
    tiebreaks: state.tiebreaks.map(toPublicTiebreak),
    escalation: state.escalation,
    setWinnerSelections: state.setWinnerSelections,
    pending: format.pendingAction(state),
    outcome: format.outcome(state),
  };
}

export type BracketMatchStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETE';

export interface BracketMatch {
  /** Same resync role as `PublicMatch.seq` — see that field's comment. */
  seq: number;
  /** The ruleset this match runs under — `format.key`, already in hand from the caller's own `requireFormat(match.formatKey)` lookup. */
  formatKey: string;
  participants: { entrantId: EntrantId; seed: number }[];
  status: BracketMatchStatus;
  /**
   * `pendingAction(state).kind === 'AWAITING_TO'` — the fifth bracket-cell
   * state DESIGN.md's "What a bracket cell shows" calls for ("pending, in
   * progress, awaiting organizer, complete, walkover") that `status` alone
   * can't carry: an escalation is still `IN_PROGRESS` by that enum, just
   * blocked. Mirrors the same cached `Match.awaitingTo` column the
   * organizer alert queue already reads.
   */
  awaitingTo: boolean;
  /** The sixth state, "walkover" — `outcome.by`, so a cell can tell a walkover apart from an ordinary agreed finish once `status` is `COMPLETE`. */
  outcomeBy: MatchOutcome['by'] | null;
  points: Record<EntrantId, number>;
  currentChartId: string | null;
  winnerId: EntrantId | null;
}

/**
 * No event has landed yet, an outcome exists, or neither — the same
 * three-way read `services/engine.ts` persists onto `Match.status`. Shared
 * here so the two can't drift into disagreeing about what "in progress"
 * means.
 */
export function deriveMatchStatus(format: MatchFormat, state: MatchState): BracketMatchStatus {
  if (state.seq === 0) return 'PENDING';
  return format.outcome(state) ? 'COMPLETE' : 'IN_PROGRESS';
}

/**
 * A narrowing of `toPublicMatch`, not a second hand-maintained shape — what
 * a bracket cell renders: participants, status, running points, the chart
 * currently in play, and the winner once there is one. See DESIGN.md, "A
 * second, smaller projection serves the bracket."
 */
export function toBracketMatch(format: MatchFormat, state: MatchState): BracketMatch {
  const outcome = format.outcome(state);
  const active = state.songs.find((s) => !s.result);
  return {
    seq: state.seq,
    formatKey: format.key,
    participants: state.participants,
    status: deriveMatchStatus(format, state),
    awaitingTo: format.pendingAction(state).kind === 'AWAITING_TO',
    outcomeBy: outcome?.by ?? null,
    points: state.points,
    currentChartId: active?.chart.chartId ?? null,
    winnerId: outcome?.placements.find((p) => p.place === 1)?.entrantId ?? null,
  };
}
