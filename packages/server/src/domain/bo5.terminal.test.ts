import { describe, expect, it } from 'vitest';
import { Bo5ProtectVetoFormat as F } from './bo5.js';
import { MatchDriver, makePack } from './testkit.js';

const A = 'alice';
const B = 'bob';
const REF = 'referee-casey';

const opened = () => new MatchDriver(makePack(20)).create(A, B).chooseSeed('FIRST').runProtectVeto();

/** Drive a song to the point where both have selected different winners. */
function toDisagreement(d: MatchDriver, songIndex = 0): MatchDriver {
  for (const id of [A, B]) {
    d.apply({ actorId: id, type: 'SCORE_SUBMITTED', payload: { songIndex, by: id, ex: 90 } });
    d.apply({
      actorId: null,
      type: 'PHOTO_OBSERVED',
      payload: { songIndex, by: id, messageId: `m-${id}` },
    });
  }
  for (const id of [A, B]) {
    d.apply({
      actorId: id,
      type: 'SONG_WINNER_SELECTED',
      payload: { songIndex, by: id, choice: id },
    });
  }
  return d;
}

describe('the freeze boundary', () => {
  it('refuses a ruling on a song both players already agreed', () => {
    const d = opened().playSong(A);
    expect(d.state.songs[0]!.result).toEqual({ winner: A, by: 'AGREEMENT' });

    d.apply({ actorId: REF, type: 'SONG_RULED', payload: { songIndex: 0, result: B } });

    // Unchanged. Nothing rewinds, including a referee.
    expect(d.state.songs[0]!.result).toEqual({ winner: A, by: 'AGREEMENT' });
    expect(d.state.points[A]).toBe(1);
    expect(d.state.points[B]).toBe(0);
  });

  it('refuses a second ruling on a song a referee already ruled', () => {
    const d = toDisagreement(opened());
    d.apply({ actorId: REF, type: 'SONG_RULED', payload: { songIndex: 0, result: A } });
    d.apply({ actorId: REF, type: 'SONG_RULED', payload: { songIndex: 0, result: B } });
    expect(d.state.songs[0]!.result).toEqual({ winner: A, by: 'RULING' });
  });

  it('ignores an escalation raised against a committed song', () => {
    const d = opened().playSong(A);
    const pendingBefore = d.pending;

    // A stale "report a settings problem" button, clicked after the song
    // committed. Accepting it would strand the match in AWAITING_TO forever.
    d.apply({
      actorId: B,
      type: 'SONG_ESCALATED',
      payload: { songIndex: 0, reason: 'SETTINGS_VIOLATION' },
    });

    expect(d.state.escalation).toBeUndefined();
    expect(d.pending).toEqual(pendingBefore);
  });
});

describe('settings violations', () => {
  it('escalates a live song and names the reason', () => {
    const d = opened();
    d.apply({
      actorId: A,
      type: 'SONG_ESCALATED',
      payload: { songIndex: 0, reason: 'SETTINGS_VIOLATION' },
    });
    expect(d.pending).toEqual({ kind: 'AWAITING_TO', reason: 'SETTINGS_VIOLATION', songIndex: 0 });
  });

  it('resumes play once the referee awards the song', () => {
    const d = opened();
    d.apply({
      actorId: A,
      type: 'SONG_ESCALATED',
      payload: { songIndex: 0, reason: 'SETTINGS_VIOLATION' },
    });
    d.apply({
      actorId: REF,
      type: 'SONG_RULED',
      payload: { songIndex: 0, result: A, note: 'B used a C-Mod on a noCmod chart' },
    });
    expect(d.state.escalation).toBeUndefined();
    expect(d.state.points[A]).toBe(1);
    expect(d.pending.kind).toBe('SUBMIT_SCORE');
  });

  it('voids the song when both players had it wrong', () => {
    const d = opened();
    d.apply({
      actorId: A,
      type: 'SONG_ESCALATED',
      payload: { songIndex: 0, reason: 'SETTINGS_VIOLATION' },
    });
    d.apply({ actorId: REF, type: 'SONG_RULED', payload: { songIndex: 0, result: 'VOID' } });
    expect(d.state.points[A]).toBe(0);
    expect(d.state.points[B]).toBe(0);
    // Handled exactly like a tie: no loser, so protect order decides.
    expect(d.state.songs[1]!.source).toBe('PROTECT_ORDER');
  });

  it('takes precedence over everything except a terminal event', () => {
    const d = opened();
    d.apply({
      actorId: A,
      type: 'SONG_ESCALATED',
      payload: { songIndex: 0, reason: 'SETTINGS_VIOLATION' },
    });
    expect(d.pending.kind).toBe('AWAITING_TO');

    // Scores may still arrive; the match stays frozen for the referee.
    d.apply({ actorId: A, type: 'SCORE_SUBMITTED', payload: { songIndex: 0, by: A, ex: 99 } });
    expect(d.pending.kind).toBe('AWAITING_TO');

    d.apply({ actorId: REF, type: 'FORFEIT_APPLIED', payload: { winnerId: A } });
    expect(d.pending).toEqual({ kind: 'DONE' });
  });
});

describe('walkovers', () => {
  it('settles a bye without any play', () => {
    const d = new MatchDriver(makePack(20)).create(A, B);
    d.apply({ actorId: null, type: 'WALKOVER', payload: { winnerId: A } });

    expect(d.pending).toEqual({ kind: 'DONE' });
    const out = F.outcome(d.state)!;
    expect(out.by).toBe('WALKOVER');
    expect(out.placements).toEqual([
      { entrantId: A, place: 1, points: 0 },
      { entrantId: B, place: 2, points: 0 },
    ]);
  });

  it('ends a match already in progress when the opponent withdraws', () => {
    const d = opened().playSong(B);
    d.apply({ actorId: null, type: 'WALKOVER', payload: { winnerId: A } });
    expect(F.outcome(d.state)!.by).toBe('WALKOVER');
    // Points played so far are preserved in the record.
    expect(F.outcome(d.state)!.placements.find((p) => p.entrantId === B)!.points).toBe(1);
  });

  it('reports the set as decided', () => {
    const d = new MatchDriver(makePack(20)).create(A, B);
    const before = structuredClone(d.state);
    d.apply({ actorId: null, type: 'WALKOVER', payload: { winnerId: A } });
    expect(F.effects(before, d.state)).toContainEqual({ kind: 'SET_DECIDED' });
  });
});

describe('terminal events override everything', () => {
  it('a forfeit ends a match frozen on an escalation', () => {
    const d = toDisagreement(opened());
    expect(d.pending.kind).toBe('AWAITING_TO');
    d.apply({ actorId: REF, type: 'FORFEIT_APPLIED', payload: { winnerId: B } });
    expect(d.pending).toEqual({ kind: 'DONE' });
    expect(F.outcome(d.state)!.by).toBe('FORFEIT');
  });

  it('a match-scope DQ ends the match as an ordinary loss', () => {
    const d = opened().playSong(A);
    d.apply({ actorId: REF, type: 'DQ_APPLIED', payload: { playerId: B, scope: 'MATCH' } });
    const out = F.outcome(d.state)!;
    expect(out.by).toBe('DQ');
    expect(out.placements.find((p) => p.entrantId === A)!.place).toBe(1);
    // The point B won before the DQ is still recorded.
    expect(out.placements.find((p) => p.entrantId === A)!.points).toBe(1);
  });

  it('the first terminal event wins; a later one cannot change the result', () => {
    const d = opened();
    d.apply({ actorId: REF, type: 'FORFEIT_APPLIED', payload: { winnerId: A } });
    d.apply({ actorId: REF, type: 'WALKOVER', payload: { winnerId: B } });
    const out = F.outcome(d.state)!;
    expect(out.placements.find((p) => p.place === 1)!.entrantId).toBe(A);
    expect(out.by).toBe('FORFEIT');
  });

  it('a DQ cannot overturn a decided match either', () => {
    const d = opened();
    d.apply({ actorId: null, type: 'WALKOVER', payload: { winnerId: A } });
    d.apply({ actorId: REF, type: 'DQ_APPLIED', payload: { playerId: A, scope: 'MATCH' } });
    expect(F.outcome(d.state)!.by).toBe('WALKOVER');
  });

  it('needs no confirmation from either player', () => {
    const d = opened();
    d.apply({ actorId: REF, type: 'FORFEIT_APPLIED', payload: { winnerId: A } });
    expect(d.state.confirmations).toEqual([]);
    expect(F.outcome(d.state)).not.toBeNull();
  });
});
