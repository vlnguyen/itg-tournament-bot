import { z } from 'zod';
import { ChartSnapshot } from './chart.js';
import { BracketSide, TournamentState } from './enums.js';

/**
 * The wire shape `toPublicMatch`/`toBracketMatch`
 * (`packages/server/src/domain/projection.ts`) produce. The API layer maps
 * those functions' plain output into this shape; `projection.ts` itself
 * stays untouched. The client's types are `z.infer` of these same schemas —
 * no parallel DTO layer, per DESIGN.md, "API contract: REST, with zod as
 * the only schema".
 */

export const EntrantId = z.string().min(1);
export type EntrantId = z.infer<typeof EntrantId>;

export const EscalationReason = z.enum([
  'WINNER_DISAGREEMENT',
  'SETTINGS_VIOLATION',
  'SET_RESULT_DISAGREEMENT',
]);
export type EscalationReason = z.infer<typeof EscalationReason>;

export const SongResultBy = z.enum(['AGREEMENT', 'RULING']);
export type SongResultBy = z.infer<typeof SongResultBy>;

export const SongSource = z.enum([
  'FIRST_PROTECT',
  'LOSER_PROTECT',
  'PROTECT_ORDER',
  'DECIDER',
  'FORCED',
  'TIEBREAK',
]);
export type SongSource = z.infer<typeof SongSource>;

const Participant = z.object({ entrantId: EntrantId, seed: z.number().int().positive() });

export const PublicSong = z.object({
  index: z.number().int().nonnegative(),
  chart: ChartSnapshot,
  source: SongSource,
  drawIndex: z.number().int().nonnegative().optional(),
  tiebreakRound: z.number().int().positive().optional(),
  ex: z.record(EntrantId, z.number()),
  photoSeen: z.record(EntrantId, z.boolean()),
  selections: z.record(EntrantId, z.union([EntrantId, z.literal('TIE')])),
  result: z
    .object({ winner: z.union([EntrantId, z.literal('TIE'), z.literal('VOID')]), by: SongResultBy })
    .optional(),
});
export type PublicSong = z.infer<typeof PublicSong>;

/**
 * `choices`/`resolvedIndex` exist only once both players have picked — that
 * is the entire hiding rule for a tiebreak round in progress.
 */
export const PublicTiebreakRound = z.union([
  // The revealed (superset) shape must be tried first: `z.union` returns the
  // first branch that matches, and a plain `z.object` strips unrecognized
  // keys rather than rejecting them — so a revealed round would otherwise
  // match the hidden branch below and silently lose `choices`/`resolvedIndex`.
  z.object({
    round: z.number().int().positive(),
    charts: z.array(ChartSnapshot),
    chosenBy: z.array(EntrantId),
    choices: z.record(EntrantId, z.number().int().nonnegative()),
    resolvedIndex: z.number().int().nonnegative(),
  }),
  z.object({ round: z.number().int().positive(), charts: z.array(ChartSnapshot), chosenBy: z.array(EntrantId) }),
]);
export type PublicTiebreakRound = z.infer<typeof PublicTiebreakRound>;

const BotDirective = z.union([
  z.object({ do: z.literal('DRAW'), count: z.number().int().positive() }),
  z.object({
    do: z.literal('DRAW_TIEBREAK'),
    round: z.number().int().positive(),
    count: z.number().int().positive(),
  }),
  z.object({
    do: z.literal('START_SONG'),
    source: SongSource,
    drawIndex: z.number().int().nonnegative().optional(),
    tiebreakRound: z.number().int().positive().optional(),
    chartIndex: z.number().int().nonnegative().optional(),
  }),
]);

export const PendingAction = z.union([
  z.object({ kind: z.literal('SEED_CHOICE'), actor: EntrantId }),
  z.object({ kind: z.literal('PROTECT'), actor: EntrantId, choices: z.array(z.number().int()) }),
  z.object({ kind: z.literal('VETO'), actor: EntrantId, choices: z.array(z.number().int()) }),
  z.object({
    kind: z.literal('SUBMIT_SCORE'),
    actors: z.array(EntrantId),
    songIndex: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('SELECT_WINNER'),
    actors: z.array(EntrantId),
    songIndex: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('TIEBREAK_PICK'),
    actors: z.array(EntrantId),
    round: z.number().int().positive(),
    choices: z.array(z.number().int()),
  }),
  z.object({ kind: z.literal('CONFIRM_RESULT'), actors: z.array(EntrantId) }),
  z.object({ kind: z.literal('AWAITING_BOT'), directive: BotDirective }),
  z.object({
    kind: z.literal('AWAITING_TO'),
    reason: EscalationReason,
    songIndex: z.number().int().nonnegative().optional(),
  }),
  z.object({ kind: z.literal('DONE') }),
]);
export type PendingAction = z.infer<typeof PendingAction>;

export const MatchOutcome = z.object({
  placements: z.array(
    z.object({ entrantId: EntrantId, place: z.number().int().positive(), points: z.number().int().nonnegative() }),
  ),
  by: z.enum(['AGREEMENT', 'RULING', 'FORFEIT', 'DQ', 'WALKOVER']),
});
export type MatchOutcome = z.infer<typeof MatchOutcome>;

export const PublicMatch = z.object({
  participants: z.array(Participant),
  a: EntrantId.optional(),
  b: EntrantId.optional(),
  draw: z.array(ChartSnapshot),
  protects: z.array(z.object({ drawIndex: z.number().int().nonnegative(), by: EntrantId })),
  vetoes: z.array(z.object({ drawIndex: z.number().int().nonnegative(), by: EntrantId })),
  deciderIndex: z.number().int().nonnegative().optional(),
  songs: z.array(PublicSong),
  points: z.record(EntrantId, z.number().int()),
  tiebreaks: z.array(PublicTiebreakRound),
  escalation: z.object({ songIndex: z.number().int().nonnegative(), reason: EscalationReason }).optional(),
  setWinnerSelections: z.record(EntrantId, EntrantId),
  pending: PendingAction,
  outcome: MatchOutcome.nullable(),
});
export type PublicMatch = z.infer<typeof PublicMatch>;

export const BracketMatchStatus = z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETE']);
export type BracketMatchStatus = z.infer<typeof BracketMatchStatus>;

export const BracketMatch = z.object({
  participants: z.array(Participant),
  status: BracketMatchStatus,
  points: z.record(EntrantId, z.number().int()),
  currentChartId: z.string().nullable(),
  winnerId: EntrantId.nullable(),
});
export type BracketMatch = z.infer<typeof BracketMatch>;

/**
 * `GET /api/tournaments/:id` — the bracket snapshot, the resync fetch per
 * DESIGN.md, "Realtime". Structural placement (`bracket`/`round`/`slot`,
 * needed to lay the tree out) plus the live `BracketMatch` projection —
 * deliberately not the fuller `PublicMatch` per match, per DESIGN.md's
 * "Rendering the bracket": shipping full match detail for every cell in a
 * snapshot covering the whole bracket is the waste that section calls out.
 * A single realtime frame is scoped to one match, so it carries the fuller
 * `PublicMatch` instead — see `RealtimeFrame` below.
 */
export const TournamentSnapshotMatch = z.object({
  id: z.string().min(1),
  bracket: BracketSide,
  round: z.number().int().positive(),
  slot: z.number().int().nonnegative(),
  match: BracketMatch,
});
export type TournamentSnapshotMatch = z.infer<typeof TournamentSnapshotMatch>;

export const TournamentSnapshot = z.object({
  id: z.string().min(1),
  name: z.string(),
  state: TournamentState,
  matches: z.array(TournamentSnapshotMatch),
});
export type TournamentSnapshot = z.infer<typeof TournamentSnapshot>;

/** The shape of every websocket frame — `{ matchId, seq, projection }`, per DESIGN.md, "Realtime". */
export const RealtimeFrame = z.object({
  matchId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  projection: PublicMatch,
});
export type RealtimeFrame = z.infer<typeof RealtimeFrame>;
