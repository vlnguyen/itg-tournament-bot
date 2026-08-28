import type { ChartSnapshot } from '@itg/shared';
import { Bo5ProtectVetoFormat, TIEBREAK_SIZE } from './bo5.js';
import { draw } from './draw.js';
import type { EntrantId, MatchEvent, MatchFormat, MatchState, PendingAction } from './types.js';
import { emptyState } from './types.js';

export const chart = (n: number): ChartSnapshot => ({
  chartId: `chart-${n}`,
  title: `Song ${n}`,
  titleTranslit: null,
  subtitle: null,
  subtitleTranslit: null,
  artist: null,
  artistTranslit: null,
  playStyle: 'SINGLE',
  difficulty: 'EXPERT',
  meter: 10 + (n % 5),
  stepartist: null,
  description: null,
  sourcePack: null,
  flags: [],
});

export const makePack = (n: number): ChartSnapshot[] =>
  Array.from({ length: n }, (_, i) => chart(i));

/**
 * A miniature of the service loop: append an event, fold it, then execute any
 * bot directives the format asks for until it is waiting on a person again.
 * The pack and the seed are exactly what the format cannot see for itself.
 */
export class MatchDriver {
  state: MatchState = emptyState();
  /** Every event folded so far, in order — the log this driver's state is a reduction of. */
  readonly events: MatchEvent[] = [];
  private seq = 0;
  private botSteps = 0;

  constructor(
    private readonly pack: ChartSnapshot[] = makePack(20),
    private readonly format: MatchFormat = Bo5ProtectVetoFormat,
  ) {}

  get pending(): PendingAction {
    return this.format.pendingAction(this.state);
  }

  apply(event: Omit<MatchEvent, 'seq'>): this {
    const full = { ...event, seq: ++this.seq } as MatchEvent;
    this.state = this.format.reduce(this.state, full);
    this.events.push(full);
    this.settle();
    return this;
  }

  /** Run the bot's side until a person is on the clock. */
  settle(): this {
    for (;;) {
      const p = this.format.pendingAction(this.state);
      if (p.kind !== 'AWAITING_BOT') return this;
      if (++this.botSteps > 200) throw new Error('bot directive loop did not settle');
      const event = this.eventFor(p) as MatchEvent;
      this.state = this.format.reduce(this.state, event);
      this.events.push(event);
    }
  }

  private eventFor(p: Extract<PendingAction, { kind: 'AWAITING_BOT' }>): Omit<MatchEvent, never> {
    const d = p.directive;
    const seq = ++this.seq;
    if (d.do === 'DRAW') {
      const alreadyDrawn = new Set(this.state.draw.map((c) => c.chartId));
      return {
        seq,
        actorId: null,
        type: 'DRAW_MADE',
        payload: {
          seed: `draw-${seq}`,
          charts: draw(this.pack, d.count, () => !alreadyDrawn.size, `draw-${seq}`),
        },
      } as MatchEvent;
    }
    if (d.do === 'DRAW_TIEBREAK') {
      // Excludes every chart already drawn in this match, in any status.
      const seen = new Set([
        ...this.state.draw.map((c) => c.chartId),
        ...this.state.tiebreaks.flatMap((t) => t.charts.map((c) => c.chartId)),
      ]);
      return {
        seq,
        actorId: null,
        type: 'TIEBREAK_DRAWN',
        payload: {
          round: d.round,
          seed: `tb-${seq}`,
          charts: draw(this.pack, d.count, (c) => !seen.has(c.chartId), `tb-${seq}`),
        },
      } as MatchEvent;
    }
    const songIndex = this.state.songs.length;
    const chartSnapshot =
      d.drawIndex !== undefined
        ? this.state.draw[d.drawIndex]!
        : this.state.tiebreaks.find((t) => t.round === d.tiebreakRound)!.charts[d.chartIndex!]!;
    return {
      seq,
      actorId: null,
      type: 'SONG_STARTED',
      payload: {
        songIndex,
        chart: chartSnapshot,
        source: d.source,
        ...(d.drawIndex !== undefined ? { drawIndex: d.drawIndex } : {}),
        ...(d.tiebreakRound !== undefined ? { tiebreakRound: d.tiebreakRound } : {}),
      },
    } as MatchEvent;
  }

  // --- convenience actions -------------------------------------------------

  create(a: EntrantId, b: EntrantId): this {
    return this.apply({
      actorId: null,
      type: 'MATCH_CREATED',
      payload: {
        participants: [
          { entrantId: a, seed: 1 },
          { entrantId: b, seed: 2 },
        ],
      },
    });
  }

  chooseSeed(order: 'FIRST' | 'SECOND'): this {
    const p = this.pending;
    if (p.kind !== 'SEED_CHOICE') throw new Error(`expected SEED_CHOICE, got ${p.kind}`);
    return this.apply({
      actorId: p.actor,
      type: 'SEED_CHOICE_MADE',
      payload: { by: p.actor, order },
    });
  }

  /** Take the first legal option at each Protect/Veto step, in whatever sequence the format defines. */
  runProtectVeto(): this {
    for (;;) {
      const p = this.pending;
      if (p.kind !== 'PROTECT' && p.kind !== 'VETO') return this;
      this.apply({
        actorId: p.actor,
        type: p.kind === 'PROTECT' ? 'CHART_PROTECTED' : 'CHART_VETOED',
        payload: { by: p.actor, drawIndex: p.choices[0]! },
      });
    }
  }

  /** Score the live song and agree a winner. `null` means both players tie. */
  playSong(winner: EntrantId | 'TIE'): this {
    let p = this.pending;
    if (p.kind !== 'SUBMIT_SCORE') throw new Error(`expected SUBMIT_SCORE, got ${p.kind}`);
    const songIndex = p.songIndex;
    for (const id of [...p.actors]) {
      this.apply({
        actorId: id,
        type: 'SCORE_SUBMITTED',
        payload: { songIndex, by: id, ex: winner === id ? 95 : 90 },
      });
      this.apply({
        actorId: null,
        type: 'PHOTO_OBSERVED',
        payload: { songIndex, by: id, messageId: `m-${songIndex}-${id}` },
      });
    }
    p = this.pending;
    if (p.kind !== 'SELECT_WINNER') throw new Error(`expected SELECT_WINNER, got ${p.kind}`);
    for (const id of [...p.actors]) {
      this.apply({
        actorId: id,
        type: 'SONG_WINNER_SELECTED',
        payload: { songIndex, by: id, choice: winner },
      });
    }
    return this;
  }

  /** Whoever has more points right now — the answer both players give by default. */
  private leadingEntrant(): EntrantId {
    const [a, b] = this.state.participants.map((p) => p.entrantId);
    return (this.state.points[a!] ?? 0) >= (this.state.points[b!] ?? 0) ? a! : b!;
  }

  /**
   * Each remaining actor names who they think won the set. `picks` lets a
   * test force a specific (and possibly disagreeing) answer per entrant;
   * anyone not named there defaults to the actual leader.
   */
  confirmResult(picks: Partial<Record<EntrantId, EntrantId>> = {}): this {
    for (;;) {
      const p = this.pending;
      if (p.kind !== 'CONFIRM_RESULT') return this;
      const actor = p.actors[0]!;
      const choice = picks[actor] ?? this.leadingEntrant();
      this.apply({
        actorId: actor,
        type: 'SET_RESULT_CONFIRMED',
        payload: { by: actor, choice },
      });
    }
  }

  /** A referee's ruling on a set-level disagreement. */
  ruleSetResult(result: EntrantId): this {
    const p = this.pending;
    if (p.kind !== 'AWAITING_TO' || p.reason !== 'SET_RESULT_DISAGREEMENT') {
      throw new Error(`expected a SET_RESULT_DISAGREEMENT escalation, got ${p.kind}`);
    }
    return this.apply({ actorId: 'referee', type: 'SET_RESULT_RULED', payload: { result } });
  }

  /** Both players pick the same tiebreak chart, so that chart plays. */
  tiebreakPick(index = 0): this {
    const p = this.pending;
    if (p.kind !== 'TIEBREAK_PICK') throw new Error(`expected TIEBREAK_PICK, got ${p.kind}`);
    for (const id of [...p.actors]) {
      this.apply({
        actorId: id,
        type: 'TIEBREAK_CHOICE',
        payload: { round: p.round, by: id, index },
      });
    }
    return this;
  }
}

export const TIEBREAK_CHARTS = TIEBREAK_SIZE;
