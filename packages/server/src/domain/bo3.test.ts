import { describe, expect, it } from 'vitest';
import { Bo3ProtectVetoFormat as F, Bo3ProtectVetoFormatV2 as F2, POINTS_TO_WIN } from './bo3.js';
import { MatchDriver, makePack } from './testkit.js';

const A = 'alice';
const B = 'bob';

/** A match with the Draw made and Protect/Protect/Veto/Veto complete, ready for song 1. */
const opened = (higherSeedTakes: 'FIRST' | 'SECOND' = 'FIRST') =>
  new MatchDriver(makePack(20), F).create(A, B).chooseSeed(higherSeedTakes).runProtectVeto();

describe('opening a match', () => {
  it('draws five charts before asking the higher seed to choose', () => {
    const d = new MatchDriver(makePack(20), F).create(A, B);
    expect(d.state.draw).toHaveLength(5);
    expect(d.pending).toEqual({ kind: 'SEED_CHOICE', actor: A });
  });

  it('makes the chooser player A when they take the first Protect', () => {
    const d = new MatchDriver(makePack(20), F).create(A, B).chooseSeed('FIRST');
    expect(d.state.a).toBe(A);
    expect(d.state.b).toBe(B);
  });

  it('makes the chooser player B when they defer', () => {
    const d = new MatchDriver(makePack(20), F).create(A, B).chooseSeed('SECOND');
    expect(d.state.a).toBe(B);
    expect(d.state.b).toBe(A);
  });

  it('runs Protect/Protect/Veto/Veto, protects by role and vetoes by seed', () => {
    const d = new MatchDriver(makePack(20), F).create(A, B).chooseSeed('FIRST');
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
    // A is the higher seed here (chose FIRST), so A also holds 1st Veto —
    // the counterpart to A's own choice of 1st Protect.
    expect(seen.map((s) => `${s.actor}:${s.kind}`)).toEqual([
      `${A}:PROTECT`,
      `${B}:PROTECT`,
      `${A}:VETO`,
      `${B}:VETO`,
    ]);
    // Five charts, one consumed per step.
    expect(seen.map((s) => s.offered)).toEqual([5, 4, 3, 2]);
  });

  it('gives the higher seed 1st Veto even when they deferred to 2nd Protect', () => {
    // A is the higher seed but chose SECOND, so B is role A (1st Protect) and
    // A is role B (2nd Protect) — but A still holds 1st Veto, since Veto
    // assignment is by seed, independent of the Protect role choice.
    const d = new MatchDriver(makePack(20), F).create(A, B).chooseSeed('SECOND');
    d.apply({ actorId: d.state.a!, type: 'CHART_PROTECTED', payload: { by: d.state.a!, drawIndex: 0 } });
    d.apply({ actorId: d.state.b!, type: 'CHART_PROTECTED', payload: { by: d.state.b!, drawIndex: 1 } });
    expect(d.pending).toMatchObject({ kind: 'VETO', actor: A });
  });

  it('leaves two protects, two vetoes and one Decider', () => {
    const d = opened();
    expect(d.state.protects).toHaveLength(2);
    expect(d.state.vetoes).toHaveLength(2);
    expect(d.state.deciderIndex).toBeDefined();
    const used = new Set([
      ...d.state.protects.map((p) => p.drawIndex),
      ...d.state.vetoes.map((v) => v.drawIndex),
      d.state.deciderIndex!,
    ]);
    expect(used.size).toBe(5);
  });
});

describe('play order is fixed, not loser-preference', () => {
  it('opens with the 1st protect', () => {
    const d = opened();
    expect(d.state.songs[0]!.source).toBe('FIRST_PROTECT');
    expect(d.state.songs[0]!.drawIndex).toBe(d.state.protects[0]!.drawIndex);
  });

  it('plays the 2nd protect next regardless of who won song 1', () => {
    const winner = opened().playSong(A);
    expect(winner.state.songs[1]!.source).toBe('PROTECT_ORDER');
    expect(winner.state.songs[1]!.drawIndex).toBe(winner.state.protects[1]!.drawIndex);

    const loser = opened().playSong(B); // A (role A / 1st protect holder) loses song 1
    expect(loser.state.songs[1]!.source).toBe('PROTECT_ORDER');
    expect(loser.state.songs[1]!.drawIndex).toBe(loser.state.protects[1]!.drawIndex);

    const tie = opened().playSong('TIE');
    expect(tie.state.songs[1]!.source).toBe('PROTECT_ORDER');
    expect(tie.state.songs[1]!.drawIndex).toBe(tie.state.protects[1]!.drawIndex);
  });

  it('ends 2-0 without ever playing the Decider', () => {
    const d = opened().playSong(A).playSong(A);
    expect(d.state.points[A]).toBe(POINTS_TO_WIN);
    expect(d.state.songs).toHaveLength(2);
    expect(d.pending).toMatchObject({ kind: 'CONFIRM_RESULT' });
  });

  it('the Decider is song 3, sourced DECIDER, once song 2 commits at 1-1', () => {
    const d = opened().playSong(A).playSong(B).playSong(A);
    expect(d.state.songs).toHaveLength(3);
    expect(d.state.songs[2]!.source).toBe('DECIDER');
    expect(d.state.songs[2]!.drawIndex).toBe(d.state.deciderIndex);
  });
});

describe('deciding the set', () => {
  it('ends at two points and asks both players to confirm', () => {
    const d = opened().playSong(A).playSong(A);
    expect(d.state.points[A]).toBe(POINTS_TO_WIN);
    expect(d.pending).toMatchObject({ kind: 'CONFIRM_RESULT' });
    expect(F.outcome(d.state)).toBeNull();
  });

  it('produces an outcome only once both have confirmed', () => {
    const d = opened().playSong(A).playSong(A).confirmResult();
    const out = F.outcome(d.state)!;
    expect(out.by).toBe('AGREEMENT');
    expect(out.placements).toEqual([
      { entrantId: A, place: 1, points: 2 },
      { entrantId: B, place: 2, points: 0 },
    ]);
    expect(d.pending).toEqual({ kind: 'DONE' });
  });

  it('goes to a tiebreak when all three Draw songs leave nobody at two', () => {
    const d = opened().playSong('TIE').playSong('TIE').playSong('TIE');
    expect(d.state.songs).toHaveLength(3);
    expect(d.pending).toMatchObject({ kind: 'TIEBREAK_PICK', round: 1 });
    expect((d.pending as { choices: number[] }).choices).toHaveLength(3);
  });
});

describe('bo3-protect-veto-v2: deciding the set without a confirm step', () => {
  const openedV2 = (higherSeedTakes: 'FIRST' | 'SECOND' = 'FIRST') =>
    new MatchDriver(makePack(20), F2).create(A, B).chooseSeed(higherSeedTakes).runProtectVeto();

  it('is done the instant the second point lands — no CONFIRM_RESULT step', () => {
    const d = openedV2().playSong(A).playSong(A);
    expect(d.state.points[A]).toBe(POINTS_TO_WIN);
    expect(d.pending).toEqual({ kind: 'DONE' });
    const out = F2.outcome(d.state)!;
    expect(out.by).toBe('AGREEMENT');
    expect(out.winCondition).toBe('POINTS');
    expect(out.placements).toEqual([
      { entrantId: A, place: 1, points: 2 },
      { entrantId: B, place: 2, points: 0 },
    ]);
  });
});

describe('the tiebreak (reused verbatim from the shared engine)', () => {
  it('repeats until someone reaches two', () => {
    const d = opened().playSong('TIE').playSong('TIE').playSong('TIE').tiebreakPick(0).playSong(A);
    expect(d.state.points[A]).toBe(1);
    expect(d.pending).toMatchObject({ kind: 'TIEBREAK_PICK', round: 2 });
    d.tiebreakPick(0).playSong(A);
    expect(d.state.points[A]).toBe(2);
    expect(d.pending).toMatchObject({ kind: 'CONFIRM_RESULT' });
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
