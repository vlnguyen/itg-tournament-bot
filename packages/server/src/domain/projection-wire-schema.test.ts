import { FORMAT_SONG_LABELS, PublicMatch as PublicMatchSchema, BracketMatch as BracketMatchSchema, deriveBracketMatch } from '@itg/shared';
import { describe, expect, it } from 'vitest';
import { Bo5ProtectVetoFormat as F, Bo5ProtectVetoFormatV2 as F2 } from './bo5.js';
import { Hb11StaticPoolFormat as HB11 } from './hubert.js';
import { toBracketMatch, toPublicMatch } from './projection.js';
import { MatchDriver, makePack, makeStaticPool } from './testkit.js';
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

  it('a v2 match auto-completes with no CONFIRM_RESULT step, and winCondition survives the wire round trip', () => {
    const d = new MatchDriver(makePack(20), F2).create(A, B).chooseSeed('FIRST').runProtectVeto();
    while (F2.outcome(d.state) === null) {
      const p = d.pending;
      if (p.kind === 'SUBMIT_SCORE') d.playSong(A);
      else throw new Error(`unexpected ${p.kind}`);
    }
    const pub = PublicMatchSchema.parse(wireRoundTrip(withNames(withRef(toPublicMatch(F2, d.state)))));
    expect(pub.pending.kind).toBe('DONE');
    expect(pub.outcome?.winCondition).toBe('POINTS');
    const bracket = BracketMatchSchema.parse(wireRoundTrip(withNames(toBracketMatch(F2, d.state))));
    expect(bracket.outcomeWinCondition).toBe('POINTS');
  });
});

/**
 * Hubert's formats (HB-11/HB-13) exercise `PendingAction` branches Bo3/Bo5
 * never reaches — `SELECT_SONG` above all. This is exactly the class of bug
 * `SELECT_SONG` shipped with: the domain type had it from the start, but
 * the shared wire schema's `PendingAction` union didn't grow a matching
 * branch until a live veto→pick transition crashed `RealtimeGateway.publish`
 * on every single one, silently — the state message never re-rendered
 * because the exception fired before `postMatchState` ever ran. This
 * describe block is the regression test: every Hubert-only `PendingAction`
 * kind, driven for real and round-tripped through the same schema.
 */
describe('PublicMatch / BracketMatch wire schemas — Hubert format', () => {
  const hb11Pool = () => makeStaticPool(FORMAT_SONG_LABELS['hb11-static-pool']!);
  const openedHB = () => new MatchDriver(hb11Pool(), HB11).create(A, B);

  it('accepts a match awaiting the song 1 pick (SELECT_SONG) — the branch that was missing entirely', () => {
    const d = openedHB();
    d.runProtectVeto();
    expect(d.pending.kind).toBe('SELECT_SONG');
    const pub = PublicMatchSchema.parse(wireRoundTrip(withNames(withRef(toPublicMatch(HB11, d.state)))));
    expect(pub.pending.kind).toBe('SELECT_SONG');
    expect(() => BracketMatchSchema.parse(wireRoundTrip(withNames(toBracketMatch(HB11, d.state))))).not.toThrow();
  });

  it('accepts a completed HB-11 match, outcome and winnerId populated, auto-completed with no CONFIRM_RESULT step', () => {
    const d = openedHB();
    d.runProtectVeto();
    while (HB11.outcome(d.state) === null) {
      const p = d.pending;
      if (p.kind === 'SELECT_SONG') d.pickSong();
      else if (p.kind === 'SUBMIT_SCORE') d.playSong(A);
      else throw new Error(`unexpected ${p.kind}`);
    }
    const pub = PublicMatchSchema.parse(wireRoundTrip(withNames(withRef(toPublicMatch(HB11, d.state)))));
    expect(pub.pending.kind).toBe('DONE');
    expect(pub.outcome?.by).toBe('AGREEMENT');
    expect(pub.outcome?.winCondition).toBe('POINTS');
    const bracket = BracketMatchSchema.parse(wireRoundTrip(withNames(toBracketMatch(HB11, d.state))));
    expect(bracket.status).toBe('COMPLETE');
    expect(bracket.winnerId).toBe(A);
    expect(bracket.outcomeWinCondition).toBe('POINTS');
  });

  it('accepts an HB-11 match decided on the forced Tiebreaker song by points, winCondition survives the wire round trip', () => {
    const d = openedHB();
    d.runProtectVeto();
    d.pickSong().playSong(A); // 1-0
    while (d.pending.kind === 'SELECT_SONG') d.pickSong().playSong('TIE'); // tie out the rest of the non-TB pool
    if (d.pending.kind !== 'SUBMIT_SCORE') throw new Error(`expected the forced TB song, got ${d.pending.kind}`);
    d.playSong('TIE'); // TB ties too; the 1-0 record from before it settles the set
    const pub = PublicMatchSchema.parse(wireRoundTrip(withNames(withRef(toPublicMatch(HB11, d.state)))));
    expect(pub.pending.kind).toBe('DONE');
    expect(pub.outcome?.winCondition).toBe('TIEBREAKER');
    const bracket = BracketMatchSchema.parse(wireRoundTrip(withNames(toBracketMatch(HB11, d.state))));
    expect(bracket.outcomeWinCondition).toBe('TIEBREAKER');
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
