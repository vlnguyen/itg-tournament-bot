import { PublicMatch as PublicMatchSchema, BracketMatch as BracketMatchSchema, deriveBracketMatch } from '@itg/shared';
import { describe, expect, it } from 'vitest';
import { Bo5ProtectVetoFormat as F } from './bo5.js';
import { toBracketMatch, toPublicMatch } from './projection.js';
import { MatchDriver } from './testkit.js';
import { emptyState } from './types.js';

/**
 * The zod schemas in `@itg/shared` (`match.ts`) are meant to describe
 * exactly what `toPublicMatch`/`toBracketMatch` produce, over JSON. This
 * file is the check that keeps the two from drifting: every branch these
 * functions can output is driven for real and round-tripped through
 * `JSON.stringify`/`JSON.parse` — the same lossy transport a real HTTP
 * response goes through — before being validated against the shared schema.
 */

const A = 'alice';
const B = 'bob';

function wireRoundTrip<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}

/**
 * `participants[].displayName` isn't part of `toPublicMatch`/
 * `toBracketMatch`'s own output — `MatchState` has no idea `Entrant` rows
 * exist — the real API layer joins it in (`api/entrant-names.ts`).
 * Stand-in here so these domain-level tests can still validate against the
 * wire schema, which does require it.
 */
function withNames<T extends { participants: { entrantId: string }[] }>(x: T): T {
  return { ...x, participants: x.participants.map((p) => ({ ...p, displayName: p.entrantId })) };
}

/**
 * `bracket`/`round`/`slot` aren't part of `toPublicMatch`'s own output
 * either — they're `Match` row columns, not derived from `MatchState` — the
 * real API/realtime layer joins them in the same way it joins in
 * `displayName` (see `match-event-effects.ts`, `matches.controller.ts`).
 * Stand-in here for the same reason `withNames` exists.
 */
function withRef<T>(x: T): T & { bracket: 'WINNERS'; round: number; slot: number } {
  return { ...x, bracket: 'WINNERS', round: 1, slot: 0 };
}

describe('PublicMatch / BracketMatch wire schemas', () => {
  it('accepts a freshly created match, awaiting the seed choice', () => {
    const d = new MatchDriver().create(A, B);
    expect(() => PublicMatchSchema.parse(wireRoundTrip(withNames(withRef(toPublicMatch(F, d.state)))))).not.toThrow();
    expect(() => BracketMatchSchema.parse(wireRoundTrip(withNames(toBracketMatch(F, d.state))))).not.toThrow();
  });

  it('accepts a match mid Protect/Veto, with a decider index set', () => {
    const d = new MatchDriver().create(A, B).chooseSeed('FIRST').runProtectVeto();
    const pub = PublicMatchSchema.parse(wireRoundTrip(withNames(withRef(toPublicMatch(F, d.state)))));
    expect(pub.deciderIndex).toBe(d.state.deciderIndex);
    expect(() => BracketMatchSchema.parse(wireRoundTrip(withNames(toBracketMatch(F, d.state))))).not.toThrow();
  });

  it('accepts a tiebreak round with one pick hidden, then both revealed', () => {
    const d = new MatchDriver().create(A, B).chooseSeed('FIRST').runProtectVeto();
    for (;;) {
      const p = d.pending;
      if (p.kind !== 'SUBMIT_SCORE') break;
      d.playSong('TIE');
    }
    const p = d.pending;
    if (p.kind !== 'TIEBREAK_PICK') throw new Error(`expected TIEBREAK_PICK, got ${p.kind}`);

    d.apply({
      actorId: p.actors[0]!,
      type: 'TIEBREAK_CHOICE',
      payload: { round: p.round, by: p.actors[0]!, index: p.choices[0]! },
    });
    const hidden = PublicMatchSchema.parse(wireRoundTrip(withNames(withRef(toPublicMatch(F, d.state))))).tiebreaks.at(-1)!;
    expect('choices' in hidden).toBe(false);

    d.apply({
      actorId: p.actors[1]!,
      type: 'TIEBREAK_CHOICE',
      payload: { round: p.round, by: p.actors[1]!, index: p.choices[0]! },
    });
    const revealed = PublicMatchSchema.parse(wireRoundTrip(withNames(withRef(toPublicMatch(F, d.state))))).tiebreaks.at(-1)!;
    expect('choices' in revealed).toBe(true);
  });

  it('accepts an open settings-violation escalation', () => {
    const d = new MatchDriver().create(A, B).chooseSeed('FIRST').runProtectVeto();
    d.apply({ actorId: A, type: 'SONG_ESCALATED', payload: { songIndex: 0, reason: 'SETTINGS_VIOLATION' } });
    const pub = PublicMatchSchema.parse(wireRoundTrip(withNames(withRef(toPublicMatch(F, d.state)))));
    expect(pub.escalation).toEqual({ songIndex: 0, reason: 'SETTINGS_VIOLATION' });
  });

  it('accepts a completed match, outcome and winnerId populated', () => {
    const d = new MatchDriver().create(A, B).chooseSeed('FIRST').runProtectVeto();
    while (F.outcome(d.state) === null) {
      const p = d.pending;
      if (p.kind === 'SUBMIT_SCORE') d.playSong(A);
      else if (p.kind === 'CONFIRM_RESULT') d.confirmResult();
      else throw new Error(`unexpected ${p.kind}`);
    }
    const pub = PublicMatchSchema.parse(wireRoundTrip(withNames(withRef(toPublicMatch(F, d.state)))));
    expect(pub.outcome?.by).toBe('AGREEMENT');
    const bracket = BracketMatchSchema.parse(wireRoundTrip(withNames(toBracketMatch(F, d.state))));
    expect(bracket.status).toBe('COMPLETE');
    expect(bracket.winnerId).toBe(A);
  });

  it('accepts the empty state a fresh match starts from', () => {
    expect(() => PublicMatchSchema.parse(wireRoundTrip(withNames(withRef(toPublicMatch(F, emptyState())))))).not.toThrow();
    expect(() => BracketMatchSchema.parse(wireRoundTrip(withNames(toBracketMatch(F, emptyState()))))).not.toThrow();
  });
});

/**
 * The client never sees `MatchState` — only the `PublicMatch` a realtime
 * frame carries. `deriveBracketMatch` (`@itg/shared`) is what patches a
 * bracket cell from that frame, and it must agree with what
 * `toBracketMatch` would have computed server-side from the same state, in
 * every case a frame can actually arrive for (i.e. `seq > 0` — a frame is
 * only ever sent after `applyAppendResult`, which only runs after at least
 * one event has landed).
 */
describe('deriveBracketMatch agrees with toBracketMatch, wherever a frame can actually land', () => {
  it('mid Protect/Veto', () => {
    const d = new MatchDriver().create(A, B).chooseSeed('FIRST').runProtectVeto();
    const pub = PublicMatchSchema.parse(wireRoundTrip(withNames(withRef(toPublicMatch(F, d.state)))));
    expect(deriveBracketMatch(pub)).toEqual(withNames(toBracketMatch(F, d.state)));
  });

  it('mid-song, a chart in progress', () => {
    const d = new MatchDriver().create(A, B).chooseSeed('FIRST').runProtectVeto();
    const pub = PublicMatchSchema.parse(wireRoundTrip(withNames(withRef(toPublicMatch(F, d.state)))));
    expect(deriveBracketMatch(pub).currentChartId).toBe(d.state.songs[0]!.chart.chartId);
    expect(deriveBracketMatch(pub)).toEqual(withNames(toBracketMatch(F, d.state)));
  });

  it('a completed match', () => {
    const d = new MatchDriver().create(A, B).chooseSeed('FIRST').runProtectVeto();
    while (F.outcome(d.state) === null) {
      const p = d.pending;
      if (p.kind === 'SUBMIT_SCORE') d.playSong(A);
      else if (p.kind === 'CONFIRM_RESULT') d.confirmResult();
      else throw new Error(`unexpected ${p.kind}`);
    }
    const pub = PublicMatchSchema.parse(wireRoundTrip(withNames(withRef(toPublicMatch(F, d.state)))));
    expect(deriveBracketMatch(pub)).toEqual(withNames(toBracketMatch(F, d.state)));
  });
});
