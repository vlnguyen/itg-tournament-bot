import type { ChartSnapshot } from '@itg/shared';

export type EntrantId = string;
export type ChartId = string;

/** Why a match is waiting on a referee. */
export type EscalationReason = 'WINNER_DISAGREEMENT' | 'SETTINGS_VIOLATION' | 'SET_RESULT_DISAGREEMENT';

/** How a song's result was reached. */
export type SongResultBy = 'AGREEMENT' | 'RULING';

/** Why a particular chart came up next. Recorded so the log explains itself. */
export type SongSource =
  | 'FIRST_PROTECT' // song 1 is always A's first protect
  | 'LOSER_PROTECT' // the loser's earliest unplayed own protect
  | 'PROTECT_ORDER' // a tie left no loser, so protect order decides
  | 'DECIDER'
  | 'FORCED' // one chart left, so no choice existed
  | 'TIEBREAK';

// ---------------------------------------------------------------------------
// Events. The append-only log is the source of truth; everything else is a fold.
// ---------------------------------------------------------------------------

interface Envelope {
  seq: number;
  /** Discord user id for player and referee events, null when the bot acted. */
  actorId: string | null;
}

export type MatchEvent =
  | (Envelope & {
      type: 'MATCH_CREATED';
      payload: { participants: { entrantId: EntrantId; seed: number }[] };
    })
  | (Envelope & { type: 'DRAW_MADE'; payload: { seed: string; charts: ChartSnapshot[] } })
  | (Envelope & {
      type: 'SEED_CHOICE_MADE';
      payload: { by: EntrantId; order: 'FIRST' | 'SECOND' };
    })
  | (Envelope & { type: 'CHART_PROTECTED'; payload: { by: EntrantId; drawIndex: number } })
  | (Envelope & { type: 'CHART_VETOED'; payload: { by: EntrantId; drawIndex: number } })
  | (Envelope & { type: 'PROTECT_VETO_RESET'; payload: { reason: string } })
  | (Envelope & {
      type: 'SONG_STARTED';
      payload: {
        songIndex: number;
        chart: ChartSnapshot;
        source: SongSource;
        /** Set when the chart came from the Draw, identifying which position. */
        drawIndex?: number;
        /** Set when the chart came from a tiebreak round. */
        tiebreakRound?: number;
      };
    })
  | (Envelope & {
      type: 'SCORE_SUBMITTED';
      payload: { songIndex: number; by: EntrantId; ex: number };
    })
  | (Envelope & {
      type: 'PHOTO_OBSERVED';
      payload: { songIndex: number; by: EntrantId; messageId: string };
    })
  | (Envelope & {
      type: 'SONG_WINNER_SELECTED';
      payload: { songIndex: number; by: EntrantId; choice: EntrantId | 'TIE' };
    })
  | (Envelope & {
      type: 'SONG_ESCALATED';
      payload: { songIndex: number; reason: EscalationReason };
    })
  | (Envelope & {
      type: 'SONG_RULED';
      payload: {
        songIndex: number;
        result: EntrantId | 'TIE' | 'VOID';
        note?: string;
      };
    })
  | (Envelope & {
      type: 'TIEBREAK_DRAWN';
      payload: { round: number; seed: string; charts: ChartSnapshot[] };
    })
  | (Envelope & {
      type: 'TIEBREAK_CHOICE';
      payload: { round: number; by: EntrantId; index: number };
    })
  | (Envelope & {
      type: 'SET_RESULT_CONFIRMED';
      /** Who the player believes won the set — not a bare sign-off. Two disagreeing picks escalate. */
      payload: { by: EntrantId; choice: EntrantId };
    })
  | (Envelope & {
      type: 'SET_RESULT_RULED';
      /** A referee's ruling on a set-level disagreement — names the actual winner. */
      payload: { result: EntrantId };
    })
  | (Envelope & { type: 'FORFEIT_APPLIED'; payload: { winnerId: EntrantId } })
  | (Envelope & {
      type: 'DQ_APPLIED';
      payload: { playerId: EntrantId; scope: 'MATCH' | 'TOURNAMENT' };
    })
  | (Envelope & { type: 'WALKOVER'; payload: { winnerId: EntrantId } });

export type MatchEventType = MatchEvent['type'];

// ---------------------------------------------------------------------------
// State — the fold of the log.
// ---------------------------------------------------------------------------

export interface SongRecord {
  chart: ChartSnapshot;
  source: SongSource;
  /** Which Draw position this song consumed, when it came from the Draw. */
  drawIndex?: number;
  tiebreakRound?: number;
  ex: Partial<Record<EntrantId, number>>;
  photoSeen: Partial<Record<EntrantId, boolean>>;
  selections: Partial<Record<EntrantId, EntrantId | 'TIE'>>;
  /** Present once committed. A committed song is frozen — nothing rewinds. */
  result?: { winner: EntrantId | 'TIE' | 'VOID'; by: SongResultBy };
}

export interface TiebreakRound {
  round: number;
  charts: ChartSnapshot[];
  /** Hidden until both have chosen. The projection never serialises this early. */
  choices: Partial<Record<EntrantId, number>>;
  /** The index the two choices resolved to, once both landed. */
  resolvedIndex?: number | undefined;
}

export interface MatchState {
  seq: number;
  participants: { entrantId: EntrantId; seed: number }[];
  /** Whoever took the first Protect. A format role, unrelated to bracket slot. */
  a?: EntrantId | undefined;
  b?: EntrantId | undefined;
  draw: ChartSnapshot[];
  /** Draw positions, in the order they were protected: A1, B1, A2, B2. */
  protects: { drawIndex: number; by: EntrantId }[];
  vetoes: { drawIndex: number; by: EntrantId }[];
  /** The one Draw position left after Protect/Veto. */
  deciderIndex?: number | undefined;
  songs: SongRecord[];
  points: Record<EntrantId, number>;
  tiebreaks: TiebreakRound[];
  escalation?: { songIndex: number; reason: EscalationReason } | undefined;
  /** Each player's pick for who won the set — mirrors `SongRecord.selections`. Two disagreeing picks escalate. */
  setWinnerSelections: Partial<Record<EntrantId, EntrantId>>;
  /** Set when a referee ends the match outside normal play. */
  terminal?:
    | {
        winnerId: EntrantId;
        by: 'FORFEIT' | 'DQ' | 'WALKOVER' | 'RULING';
      }
    | undefined;
}

// `pending` is deliberately NOT a field here. It is computed by
// `pendingAction(state)`, so it cannot drift from the state it describes —
// the same reason there are no commit events in the log.

// ---------------------------------------------------------------------------
// What the match is waiting on.
// ---------------------------------------------------------------------------

/**
 * Work the bot owes the match. The format decides *what* is due; the service
 * supplies what the format cannot see — the song pack, and a fresh seed.
 */
export type BotDirective =
  | { do: 'DRAW'; count: number }
  | { do: 'DRAW_TIEBREAK'; round: number; count: number }
  | {
      do: 'START_SONG';
      source: SongSource;
      drawIndex?: number;
      tiebreakRound?: number;
      chartIndex?: number;
    };

export type PendingAction =
  | { kind: 'SEED_CHOICE'; actor: EntrantId }
  | { kind: 'PROTECT'; actor: EntrantId; choices: number[] }
  | { kind: 'VETO'; actor: EntrantId; choices: number[] }
  | { kind: 'SUBMIT_SCORE'; actors: EntrantId[]; songIndex: number }
  | { kind: 'SELECT_WINNER'; actors: EntrantId[]; songIndex: number }
  | { kind: 'TIEBREAK_PICK'; actors: EntrantId[]; round: number; choices: number[] }
  | { kind: 'CONFIRM_RESULT'; actors: EntrantId[] }
  | { kind: 'AWAITING_BOT'; directive: BotDirective }
  // `songIndex` is undefined for a set-level disagreement — there is no
  // single song it's about, unlike a song-level `WINNER_DISAGREEMENT` or
  // `SETTINGS_VIOLATION`, which always name one.
  | { kind: 'AWAITING_TO'; reason: EscalationReason; songIndex?: number }
  | { kind: 'DONE' };

/** Every actor a pending action is waiting on, however the variant spells it. */
export function actorsOf(pending: PendingAction): EntrantId[] {
  if ('actors' in pending) return pending.actors;
  if ('actor' in pending) return [pending.actor];
  return [];
}

// ---------------------------------------------------------------------------
// Outcome and effects.
// ---------------------------------------------------------------------------

export interface MatchOutcome {
  /** Every participant, ordered by finish. Ties share a place. */
  placements: { entrantId: EntrantId; place: number; points: number }[];
  by: 'AGREEMENT' | 'RULING' | 'FORFEIT' | 'DQ' | 'WALKOVER';
}

/**
 * What just became true, for the caller to act on. Match-scoped only —
 * bracket advancement is the service's reaction to `outcome() !== null`,
 * because a format has no business knowing brackets exist.
 */
export type DomainEffect =
  | { kind: 'SONG_COMMITTED'; songIndex: number }
  | { kind: 'TIEBREAK_RESOLVED'; round: number }
  | { kind: 'ESCALATION_OPENED'; songIndex?: number; reason: EscalationReason }
  | { kind: 'ESCALATION_CLOSED'; songIndex?: number }
  | { kind: 'SET_DECIDED' };

// ---------------------------------------------------------------------------
// The plugin boundary.
// ---------------------------------------------------------------------------

export interface MatchFormat {
  readonly key: string;
  readonly drawSize: number;
  /** Charts a pack should hold for this format to behave well. */
  readonly recommendedPackSize: number;

  /** Fold one event into state. Pure. */
  reduce(state: MatchState, event: MatchEvent): MatchState;

  /** What the match is waiting on right now. Pure. */
  pendingAction(state: MatchState): PendingAction;

  /** Set outcome, or null if undecided. Pure. */
  outcome(state: MatchState): MatchOutcome | null;

  /** What just became true, for the caller to act on. Pure. */
  effects(before: MatchState, after: MatchState): DomainEffect[];
}

/** The state a match starts from, before any event is folded in. */
export function emptyState(): MatchState {
  return {
    seq: 0,
    participants: [],
    draw: [],
    protects: [],
    vetoes: [],
    songs: [],
    points: {},
    tiebreaks: [],
    setWinnerSelections: {},
  };
}
