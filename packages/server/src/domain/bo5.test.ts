import { describe, expect, it } from 'vitest';
import { Bo5ProtectVetoFormat as F, POINTS_TO_WIN } from './bo5.js';
import { MatchDriver, makePack } from './testkit.js';

const A = 'alice';
const B = 'bob';

/** A match with the Draw made and ABBAAB complete, ready for song 1. */
const opened = (higherSeedTakes: 'FIRST' | 'SECOND' = 'FIRST') =>
  new MatchDriver().create(A, B).chooseSeed(higherSeedTakes).runProtectVeto();

describe('opening a match', () => {
  it('draws seven charts before asking the higher seed to choose', () => {
    const d = new MatchDriver().create(A, B);
    expect(d.state.draw).toHaveLength(7);
    expect(d.pending).toEqual({ kind: 'SEED_CHOICE', actor: A });
  });

  it('makes the chooser player A when they take the first Protect', () => {
    const d = new MatchDriver().create(A, B).chooseSeed('FIRST');
    expect(d.state.a).toBe(A);
    expect(d.state.b).toBe(B);
  });

  it('makes the chooser player B when they defer', () => {
    const d = new MatchDriver().create(A, B).chooseSeed('SECOND');
    expect(d.state.a).toBe(B);
    expect(d.state.b).toBe(A);
  });

  it('runs ABBAAB, and only ever offers charts still in play', () => {
    const d = new MatchDriver().create(A, B).chooseSeed('FIRST');
    const seen: { kind: string; actor: string; offered: number }[] = [];
    for (;;) {
      const p = d.pending;
      if (p.kind !== 'PROTECT' && p.kind !== 'VETO') break;
      seen.push({ kind: p.kind, actor: p.actor, offered: p.choices.length });
      d.apply({
        actorId: p.actor,
        type: p.kind === 'PROTECT' ? 'CHART_PROTECTED' : 'CHART_VETOED',
        payload: { by: p.actor, drawIndex: p.choices[0]! },
      });
    }
    expect(seen.map((s) => `${s.actor}:${s.kind}`)).toEqual([
      `${A}:PROTECT`,
      `${B}:PROTECT`,
      `${B}:VETO`,
      `${A}:VETO`,
      `${A}:PROTECT`,
      `${B}:PROTECT`,
    ]);
    // Seven charts, one consumed per step.
    expect(seen.map((s) => s.offered)).toEqual([7, 6, 5, 4, 3, 2]);
  });

  it('leaves four protects, two vetoes and one Decider', () => {
    const d = opened();
    expect(d.state.protects).toHaveLength(4);
    expect(d.state.vetoes).toHaveLength(2);
    expect(d.state.deciderIndex).toBeDefined();
    const used = new Set([
      ...d.state.protects.map((p) => p.drawIndex),
      ...d.state.vetoes.map((v) => v.drawIndex),
      d.state.deciderIndex!,
    ]);
    expect(used.size).toBe(7);
  });
});

describe('play order is fully determined', () => {
  it('never asks a player to choose the next song', () => {
    const d = opened();
    for (let i = 0; i < 5; i++) {
      const p = d.pending;
      if (p.kind === 'DONE' || p.kind === 'CONFIRM_RESULT') break;
      expect(p.kind).toBe('SUBMIT_SCORE');
      d.playSong(i % 2 === 0 ? A : B);
    }
  });

  it('opens with A’s first protect', () => {
    const d = opened();
    expect(d.state.songs[0]!.source).toBe('FIRST_PROTECT');
    expect(d.state.songs[0]!.drawIndex).toBe(d.state.protects[0]!.drawIndex);
  });

  it('gives the loser their own earliest unplayed protect', () => {
    const d = opened().playSong(A); // B lost song 1
    const bProtects = d.state.protects.filter((p) => p.by === B).map((p) => p.drawIndex);
    expect(d.state.songs[1]!.source).toBe('LOSER_PROTECT');
    expect(d.state.songs[1]!.drawIndex).toBe(bProtects[0]);
  });

  it('consumes a player’s two protects in the order they were protected', () => {
    const d = opened().playSong(A).playSong(A); // B loses twice
    const bProtects = d.state.protects.filter((p) => p.by === B).map((p) => p.drawIndex);
    expect(d.state.songs[1]!.drawIndex).toBe(bProtects[0]);
    expect(d.state.songs[2]!.drawIndex).toBe(bProtects[1]);
  });

  it('falls through to protect order after a tie, which differs from the loser rule', () => {
    const d = opened().playSong('TIE');
    // A tie leaves no loser. Protect order gives B1 (the second protect made);
    // the loser rule, had it applied to A, would have given A2.
    const protectOrder = d.state.protects.map((p) => p.drawIndex);
    expect(d.state.songs[1]!.source).toBe('PROTECT_ORDER');
    expect(d.state.songs[1]!.drawIndex).toBe(protectOrder[1]);
  });

  it('plays the Decider when the loser holds no protect of their own', () => {
    // A wins song 1 (A1 played), B loses and plays B1, A loses and plays A2,
    // B loses and plays B2 — then a loser with nothing left reaches the Decider.
    const d = opened().playSong(A).playSong(B).playSong(A).playSong(B);
    const sources = d.state.songs.map((s) => s.source);
    expect(sources).toContain('DECIDER');
  });
});

describe('scoring a song', () => {
  it('waits for both scores and both photos before offering winner selection', () => {
    const d = opened();
    const p0 = d.pending;
    expect(p0.kind).toBe('SUBMIT_SCORE');
    d.apply({ actorId: A, type: 'SCORE_SUBMITTED', payload: { songIndex: 0, by: A, ex: 95 } });
    // Score without photo is not enough.
    expect(d.pending.kind).toBe('SUBMIT_SCORE');
    d.apply({
      actorId: null,
      type: 'PHOTO_OBSERVED',
      payload: { songIndex: 0, by: A, messageId: 'm' },
    });
    // A is done; B is still outstanding.
    const p1 = d.pending;
    expect(p1).toMatchObject({ kind: 'SUBMIT_SCORE', actors: [B] });
  });

  it('commits on agreement without a commit event', () => {
    const d = opened().playSong(A);
    expect(d.state.songs[0]!.result).toEqual({ winner: A, by: 'AGREEMENT' });
    const types = new Set(['SONG_COMMITTED']);
    // Nothing in the event catalog writes a commit; it is derived.
    expect([...types].every((t) => !t.startsWith('EVENT_'))).toBe(true);
  });

  it('awards a point to the winner and nothing on a tie', () => {
    const d = opened().playSong(A);
    expect(d.state.points[A]).toBe(1);
    expect(d.state.points[B]).toBe(0);
    d.playSong('TIE');
    expect(d.state.points[A]).toBe(1);
    expect(d.state.points[B]).toBe(0);
  });

  it('escalates on disagreement, derived from the selections themselves', () => {
    const d = opened();
    const p = d.pending as { songIndex: number; actors: string[] };
    for (const id of [A, B]) {
      d.apply({ actorId: id, type: 'SCORE_SUBMITTED', payload: { songIndex: 0, by: id, ex: 90 } });
      d.apply({
        actorId: null,
        type: 'PHOTO_OBSERVED',
        payload: { songIndex: 0, by: id, messageId: 'm' },
      });
    }
    d.apply({
      actorId: A,
      type: 'SONG_WINNER_SELECTED',
      payload: { songIndex: 0, by: A, choice: A },
    });
    d.apply({
      actorId: B,
      type: 'SONG_WINNER_SELECTED',
      payload: { songIndex: 0, by: B, choice: B },
    });
    expect(d.pending).toEqual({ kind: 'AWAITING_TO', reason: 'WINNER_DISAGREEMENT' });
    expect(p.songIndex).toBe(0);
  });

  it('resumes once a referee rules', () => {
    const d = opened();
    for (const id of [A, B]) {
      d.apply({ actorId: id, type: 'SCORE_SUBMITTED', payload: { songIndex: 0, by: id, ex: 90 } });
      d.apply({
        actorId: null,
        type: 'PHOTO_OBSERVED',
        payload: { songIndex: 0, by: id, messageId: 'm' },
      });
      d.apply({
        actorId: id,
        type: 'SONG_WINNER_SELECTED',
        payload: { songIndex: 0, by: id, choice: id },
      });
    }
    expect(d.pending.kind).toBe('AWAITING_TO');
    d.apply({
      actorId: 'referee',
      type: 'SONG_RULED',
      payload: { songIndex: 0, result: A, note: 'photo shows A' },
    });
    expect(d.state.songs[0]!.result).toEqual({ winner: A, by: 'RULING' });
    expect(d.pending.kind).toBe('SUBMIT_SCORE');
  });

  it('treats a voided song like a tie — no points, next in protect order', () => {
    const d = opened();
    for (const id of [A, B]) {
      d.apply({ actorId: id, type: 'SCORE_SUBMITTED', payload: { songIndex: 0, by: id, ex: 90 } });
      d.apply({
        actorId: null,
        type: 'PHOTO_OBSERVED',
        payload: { songIndex: 0, by: id, messageId: 'm' },
      });
    }
    d.apply({ actorId: 'ref', type: 'SONG_RULED', payload: { songIndex: 0, result: 'VOID' } });
    expect(d.state.points[A]).toBe(0);
    expect(d.state.points[B]).toBe(0);
    expect(d.state.songs[1]!.source).toBe('PROTECT_ORDER');
  });
});

describe('deciding the set', () => {
  it('ends at three points and asks both players to confirm', () => {
    const d = opened().playSong(A).playSong(A).playSong(A);
    expect(d.state.points[A]).toBe(POINTS_TO_WIN);
    expect(d.pending).toMatchObject({ kind: 'CONFIRM_RESULT' });
    expect(F.outcome(d.state)).toBeNull();
  });

  it('produces an outcome only once both have confirmed', () => {
    const d = opened().playSong(A).playSong(A).playSong(A).confirmResult();
    const out = F.outcome(d.state)!;
    expect(out.by).toBe('AGREEMENT');
    expect(out.placements).toEqual([
      { entrantId: A, place: 1, points: 3 },
      { entrantId: B, place: 2, points: 0 },
    ]);
    expect(d.pending).toEqual({ kind: 'DONE' });
  });

  it('records a ruling in the outcome when one decided a song', () => {
    const d = opened();
    for (const id of [A, B]) {
      d.apply({ actorId: id, type: 'SCORE_SUBMITTED', payload: { songIndex: 0, by: id, ex: 90 } });
      d.apply({
        actorId: null,
        type: 'PHOTO_OBSERVED',
        payload: { songIndex: 0, by: id, messageId: 'm' },
      });
    }
    d.apply({ actorId: 'ref', type: 'SONG_RULED', payload: { songIndex: 0, result: A } });
    d.playSong(A).playSong(A).confirmResult();
    expect(F.outcome(d.state)!.by).toBe('RULING');
  });

  it('goes to a tiebreak when five songs leave nobody at three', () => {
    const d = opened()
      .playSong('TIE')
      .playSong('TIE')
      .playSong('TIE')
      .playSong('TIE')
      .playSong('TIE');
    expect(d.state.songs).toHaveLength(5);
    expect(d.pending).toMatchObject({ kind: 'TIEBREAK_PICK', round: 1 });
    expect((d.pending as { choices: number[] }).choices).toHaveLength(3);
  });
});

describe('the tiebreak', () => {
  const toTiebreak = () =>
    opened().playSong('TIE').playSong('TIE').playSong('TIE').playSong('TIE').playSong('TIE');

  it('plays the agreed chart when both pick the same', () => {
    const d = toTiebreak().tiebreakPick(1);
    const round = d.state.tiebreaks[0]!;
    expect(round.resolvedIndex).toBe(1);
    expect(d.state.songs[5]!.chart.chartId).toBe(round.charts[1]!.chartId);
    expect(d.state.songs[5]!.source).toBe('TIEBREAK');
  });

  it('plays the unselected chart when the picks differ', () => {
    const d = toTiebreak();
    const p = d.pending as { round: number; actors: string[] };
    d.apply({ actorId: A, type: 'TIEBREAK_CHOICE', payload: { round: p.round, by: A, index: 0 } });
    d.apply({ actorId: B, type: 'TIEBREAK_CHOICE', payload: { round: p.round, by: B, index: 1 } });
    expect(d.state.tiebreaks[0]!.resolvedIndex).toBe(2);
  });

  it('hides a choice until both have landed', () => {
    const d = toTiebreak();
    const p = d.pending as { round: number };
    d.apply({ actorId: A, type: 'TIEBREAK_CHOICE', payload: { round: p.round, by: A, index: 0 } });
    const round = d.state.tiebreaks[0]!;
    expect(round.resolvedIndex).toBeUndefined();
    expect(Object.keys(round.choices)).toEqual([A]);
    // B is still on the clock, and the round is unresolved.
    expect(d.pending).toMatchObject({ kind: 'TIEBREAK_PICK', actors: [B] });
  });

  it('repeats until someone reaches three', () => {
    const d = toTiebreak().tiebreakPick(0).playSong(A);
    expect(d.state.points[A]).toBe(1);
    expect(d.pending).toMatchObject({ kind: 'TIEBREAK_PICK', round: 2 });
    d.tiebreakPick(0).playSong(A);
    d.tiebreakPick(0).playSong(A);
    expect(d.state.points[A]).toBe(3);
    expect(d.pending).toMatchObject({ kind: 'CONFIRM_RESULT' });
  });

  it('excludes charts already drawn in this match', () => {
    const d = toTiebreak().tiebreakPick(0).playSong(A);
    const drawIds = new Set(d.state.draw.map((c) => c.chartId));
    const round2 = d.state.tiebreaks[1]!;
    for (const c of round2.charts) expect(drawIds.has(c.chartId)).toBe(false);
    const round1Ids = new Set(d.state.tiebreaks[0]!.charts.map((c) => c.chartId));
    for (const c of round2.charts) expect(round1Ids.has(c.chartId)).toBe(false);
  });
});

describe('referee interventions', () => {
  it('a forfeit ends the match as an ordinary loss', () => {
    const d = opened().playSong(A);
    d.apply({ actorId: 'ref', type: 'FORFEIT_APPLIED', payload: { winnerId: A } });
    expect(d.pending).toEqual({ kind: 'DONE' });
    const out = F.outcome(d.state)!;
    expect(out.by).toBe('FORFEIT');
    expect(out.placements.find((p) => p.entrantId === A)!.place).toBe(1);
  });

  it('a disqualification awards the match to the opponent', () => {
    const d = opened();
    d.apply({
      actorId: 'ref',
      type: 'DQ_APPLIED',
      payload: { playerId: B, scope: 'TOURNAMENT' },
    });
    expect(F.outcome(d.state)!.placements.find((p) => p.entrantId === A)!.place).toBe(1);
  });

  it('a reset clears the sequence but keeps the Draw', () => {
    const d = opened();
    const drawBefore = d.state.draw.map((c) => c.chartId);
    d.apply({ actorId: 'ref', type: 'PROTECT_VETO_RESET', payload: { reason: 'misclick' } });
    expect(d.state.draw.map((c) => c.chartId)).toEqual(drawBefore);
    expect(d.state.protects).toEqual([]);
    expect(d.state.vetoes).toEqual([]);
    expect(d.state.deciderIndex).toBeUndefined();
    expect(d.pending).toEqual({ kind: 'SEED_CHOICE', actor: A });
  });
});

describe('effects', () => {
  it('reports a song commit', () => {
    const before = opened();
    const after = new MatchDriver(makePack(20));
    // Rebuild the same match, then commit one song and diff.
    const d = opened();
    const snapshot = structuredClone(d.state);
    d.playSong(A);
    expect(F.effects(snapshot, d.state)).toContainEqual({ kind: 'SONG_COMMITTED', songIndex: 0 });
    expect(before.state.songs).toHaveLength(1);
    expect(after.state.songs).toHaveLength(0);
  });

  it('reports the set being decided exactly once', () => {
    const d = opened().playSong(A).playSong(A).playSong(A);
    const snapshot = structuredClone(d.state);
    d.confirmResult();
    const fx = F.effects(snapshot, d.state);
    expect(fx.filter((e) => e.kind === 'SET_DECIDED')).toHaveLength(1);
  });

  it('reports an escalation opening and closing', () => {
    const d = opened();
    for (const id of [A, B]) {
      d.apply({ actorId: id, type: 'SCORE_SUBMITTED', payload: { songIndex: 0, by: id, ex: 90 } });
      d.apply({
        actorId: null,
        type: 'PHOTO_OBSERVED',
        payload: { songIndex: 0, by: id, messageId: 'm' },
      });
      d.apply({
        actorId: id,
        type: 'SONG_WINNER_SELECTED',
        payload: { songIndex: 0, by: id, choice: id },
      });
    }
    const escalated = structuredClone(d.state);
    d.apply({ actorId: 'ref', type: 'SONG_RULED', payload: { songIndex: 0, result: A } });
    expect(F.effects(escalated, d.state)).toContainEqual({
      kind: 'ESCALATION_CLOSED',
      songIndex: 0,
    });
  });
});
