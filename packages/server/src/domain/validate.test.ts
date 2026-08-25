import { describe, expect, it } from 'vitest';
import { isLegal } from './validate.js';
import { MatchDriver } from './testkit.js';
import type { MatchEvent, PendingAction } from './types.js';

const A = 'alice';
const B = 'bob';

const opened = (higherSeedTakes: 'FIRST' | 'SECOND' = 'FIRST') =>
  new MatchDriver().create(A, B).chooseSeed(higherSeedTakes).runProtectVeto();

describe('SEED_CHOICE', () => {
  it('accepts the named actor, rejects anyone else or a different pending kind', () => {
    const d = new MatchDriver().create(A, B);
    const event = (by: string): MatchEvent =>
      ({ seq: 0, actorId: by, type: 'SEED_CHOICE_MADE', payload: { by, order: 'FIRST' } }) as MatchEvent;
    expect(isLegal(d.pending, event(A))).toBe(true);
    expect(isLegal(d.pending, event(B))).toBe(false);
    expect(isLegal(opened().pending, event(A))).toBe(false);
  });
});

describe('PROTECT and VETO', () => {
  it('accepts the actor on the clock choosing an offered index, rejects the wrong actor, index, or action', () => {
    const d = new MatchDriver().create(A, B).chooseSeed('FIRST');
    const p = d.pending;
    if (p.kind !== 'PROTECT') throw new Error('expected PROTECT');
    const protect = (by: string, drawIndex: number): MatchEvent =>
      ({ seq: 0, actorId: by, type: 'CHART_PROTECTED', payload: { by, drawIndex } }) as MatchEvent;
    const veto = (by: string, drawIndex: number): MatchEvent =>
      ({ seq: 0, actorId: by, type: 'CHART_VETOED', payload: { by, drawIndex } }) as MatchEvent;

    expect(isLegal(p, protect(p.actor, p.choices[0]!))).toBe(true);
    expect(isLegal(p, protect(B, p.choices[0]!))).toBe(false); // wrong actor
    expect(isLegal(p, protect(p.actor, 99))).toBe(false); // not offered
    expect(isLegal(p, veto(p.actor, p.choices[0]!))).toBe(false); // wrong action for this step
  });
});

describe('scoring a song', () => {
  it('gates SCORE_SUBMITTED and PHOTO_OBSERVED on the same SUBMIT_SCORE window', () => {
    const d = opened();
    const p = d.pending;
    if (p.kind !== 'SUBMIT_SCORE') throw new Error('expected SUBMIT_SCORE');
    const actor = p.actors[0]!;
    const other = p.actors[1] ?? (actor === A ? B : A);

    const score: MatchEvent = {
      seq: 0,
      actorId: actor,
      type: 'SCORE_SUBMITTED',
      payload: { songIndex: p.songIndex, by: actor, ex: 95 },
    } as MatchEvent;
    const photo: MatchEvent = {
      seq: 0,
      actorId: null,
      type: 'PHOTO_OBSERVED',
      payload: { songIndex: p.songIndex, by: actor, messageId: 'm1' },
    } as MatchEvent;

    expect(isLegal(p, score)).toBe(true);
    expect(isLegal(p, photo)).toBe(true);
    expect(isLegal(p, { ...score, payload: { ...score.payload, songIndex: p.songIndex + 1 } } as MatchEvent)).toBe(
      false,
    );
    // Not currently on the clock for this song's score.
    if (!p.actors.includes(other)) {
      expect(
        isLegal(p, { ...score, actorId: other, payload: { ...score.payload, by: other } } as MatchEvent),
      ).toBe(false);
    }
  });

  it('accepts SONG_ESCALATED only while the active song has not committed', () => {
    const d = opened();
    const p = d.pending;
    if (p.kind !== 'SUBMIT_SCORE') throw new Error('expected SUBMIT_SCORE');
    const escalate = (songIndex: number): MatchEvent =>
      ({
        seq: 0,
        actorId: p.actors[0]!,
        type: 'SONG_ESCALATED',
        payload: { songIndex, reason: 'SETTINGS_VIOLATION' },
      }) as MatchEvent;
    expect(isLegal(p, escalate(p.songIndex))).toBe(true);
    expect(isLegal(p, escalate(p.songIndex + 1))).toBe(false);
  });

  it('accepts SELECT_WINNER for the actor still owed a pick', () => {
    const d = opened();
    let p = d.pending;
    if (p.kind !== 'SUBMIT_SCORE') throw new Error('expected SUBMIT_SCORE');
    const songIndex = p.songIndex;
    for (const id of [...p.actors]) {
      d.apply({ actorId: id, type: 'SCORE_SUBMITTED', payload: { songIndex, by: id, ex: 90 } });
      d.apply({ actorId: null, type: 'PHOTO_OBSERVED', payload: { songIndex, by: id, messageId: `m-${id}` } });
    }
    p = d.pending;
    if (p.kind !== 'SELECT_WINNER') throw new Error('expected SELECT_WINNER');
    const select = (by: string, choice: string): MatchEvent =>
      ({ seq: 0, actorId: by, type: 'SONG_WINNER_SELECTED', payload: { songIndex, by, choice } }) as MatchEvent;
    expect(isLegal(p, select(p.actors[0]!, A))).toBe(true);
    expect(isLegal(p, select('nobody', A))).toBe(false);
  });
});

describe('tiebreak picks', () => {
  it('accepts an actor choosing an offered chart in the current round', () => {
    const d = opened();
    // Force every song to tie so a tiebreak round is drawn.
    for (;;) {
      const current: PendingAction = d.pending;
      if (current.kind !== 'SUBMIT_SCORE') break;
      const songIndex = current.songIndex;
      for (const id of [...current.actors]) {
        d.apply({ actorId: id, type: 'SCORE_SUBMITTED', payload: { songIndex, by: id, ex: 90 } });
        d.apply({
          actorId: null,
          type: 'PHOTO_OBSERVED',
          payload: { songIndex, by: id, messageId: `m-${id}-${songIndex}` },
        });
      }
      const sel: PendingAction = d.pending;
      if (sel.kind !== 'SELECT_WINNER') break;
      for (const id of [...sel.actors]) {
        d.apply({ actorId: id, type: 'SONG_WINNER_SELECTED', payload: { songIndex: sel.songIndex, by: id, choice: 'TIE' } });
      }
    }
    const p = d.pending;
    if (p.kind !== 'TIEBREAK_PICK') throw new Error(`expected TIEBREAK_PICK, got ${p.kind}`);
    const pick = (by: string, round: number, index: number): MatchEvent =>
      ({ seq: 0, actorId: by, type: 'TIEBREAK_CHOICE', payload: { round, by, index } }) as MatchEvent;
    expect(isLegal(p, pick(p.actors[0]!, p.round, p.choices[0]!))).toBe(true);
    expect(isLegal(p, pick(p.actors[0]!, p.round + 1, p.choices[0]!))).toBe(false);
    expect(isLegal(p, pick(p.actors[0]!, p.round, 99))).toBe(false);
  });
});

describe('referee events', () => {
  it('SONG_RULED is legal only while AWAITING_TO', () => {
    const d = opened();
    const ruling: MatchEvent = {
      seq: 0,
      actorId: 'ref',
      type: 'SONG_RULED',
      payload: { songIndex: 0, result: A },
    } as MatchEvent;
    expect(isLegal(d.pending, ruling)).toBe(false); // nothing escalated yet
    expect(isLegal({ kind: 'AWAITING_TO', reason: 'WINNER_DISAGREEMENT', songIndex: 0 }, ruling)).toBe(true);
    expect(isLegal({ kind: 'AWAITING_TO', reason: 'WINNER_DISAGREEMENT', songIndex: 1 }, ruling)).toBe(false);
  });

  it('PROTECT_VETO_RESET is legal before song 1 starts, not after', () => {
    const reset: MatchEvent = { seq: 0, actorId: 'ref', type: 'PROTECT_VETO_RESET', payload: { reason: 'misclick' } } as MatchEvent;
    expect(isLegal({ kind: 'SEED_CHOICE', actor: A }, reset)).toBe(true);
    expect(isLegal({ kind: 'PROTECT', actor: A, choices: [0] }, reset)).toBe(true);
    expect(isLegal({ kind: 'VETO', actor: A, choices: [0] }, reset)).toBe(true);
    expect(isLegal({ kind: 'SUBMIT_SCORE', actors: [A, B], songIndex: 0 }, reset)).toBe(false);
    expect(isLegal({ kind: 'DONE' }, reset)).toBe(false);
  });

  it('FORFEIT_APPLIED and DQ_APPLIED are legal any time the match is not DONE', () => {
    const forfeit: MatchEvent = { seq: 0, actorId: 'ref', type: 'FORFEIT_APPLIED', payload: { winnerId: A } } as MatchEvent;
    const dq: MatchEvent = { seq: 0, actorId: 'ref', type: 'DQ_APPLIED', payload: { playerId: B, scope: 'MATCH' } } as MatchEvent;
    expect(isLegal({ kind: 'SEED_CHOICE', actor: A }, forfeit)).toBe(true);
    expect(isLegal({ kind: 'SUBMIT_SCORE', actors: [A, B], songIndex: 2 }, dq)).toBe(true);
    expect(isLegal({ kind: 'DONE' }, forfeit)).toBe(false);
    expect(isLegal({ kind: 'DONE' }, dq)).toBe(false);
  });
});

describe('system-authored events', () => {
  it('are never legal through the validated path', () => {
    const pending = { kind: 'SEED_CHOICE', actor: A } as const;
    const events: MatchEvent[] = [
      { seq: 0, actorId: null, type: 'MATCH_CREATED', payload: { participants: [] } },
      { seq: 0, actorId: null, type: 'DRAW_MADE', payload: { seed: 's', charts: [] } },
      { seq: 0, actorId: null, type: 'SONG_STARTED', payload: { songIndex: 0, chart: {} as never, source: 'FIRST_PROTECT' } },
      { seq: 0, actorId: null, type: 'TIEBREAK_DRAWN', payload: { round: 1, seed: 's', charts: [] } },
      { seq: 0, actorId: null, type: 'WALKOVER', payload: { winnerId: A } },
    ] as MatchEvent[];
    for (const event of events) expect(isLegal(pending, event)).toBe(false);
  });
});
