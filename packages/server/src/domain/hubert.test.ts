import { describe, expect, it } from 'vitest';
import { FORMAT_SONG_LABELS, poolCategoryOf } from '@itg/shared';
import type { EntrantId } from './types.js';
import { Hb11StaticPoolFormat as HB11, Hb13StaticPoolFormat as HB13 } from './hubert.js';
import { MatchDriver, makeStaticPool } from './testkit.js';

const A = 'alice';
const B = 'bob';

const hb11Pool = () => makeStaticPool(FORMAT_SONG_LABELS['hb11-static-pool']!);
const hb13Pool = () => makeStaticPool(FORMAT_SONG_LABELS['hb13-static-pool']!);

/** A match with sides assigned and the static pool drawn, ready for vetoes. */
const opened11 = () => new MatchDriver(hb11Pool(), HB11).create(A, B);
const opened13 = () => new MatchDriver(hb13Pool(), HB13).create(A, B);

/** Submits distinct EX values per player for the live song, then agrees the given winner (or a tie). */
function playCustom(d: MatchDriver, x: EntrantId, y: EntrantId, exX: number, exY: number, winner: EntrantId | 'TIE') {
  let p = d.pending;
  if (p.kind !== 'SUBMIT_SCORE') throw new Error(`expected SUBMIT_SCORE, got ${p.kind}`);
  const songIndex = p.songIndex;
  for (const [id, ex] of [[x, exX], [y, exY]] as const) {
    d.apply({ actorId: id, type: 'SCORE_SUBMITTED', payload: { songIndex, by: id, ex } });
    d.apply({ actorId: null, type: 'PHOTO_OBSERVED', payload: { songIndex, by: id, messageId: `m-${songIndex}-${id}` } });
  }
  p = d.pending;
  if (p.kind !== 'SELECT_WINNER') throw new Error(`expected SELECT_WINNER, got ${p.kind}`);
  for (const id of [x, y]) {
    d.apply({ actorId: id, type: 'SONG_WINNER_SELECTED', payload: { songIndex, by: id, choice: winner } });
  }
}

describe('opening a match', () => {
  it('assigns sides by coin flip before drawing, then draws the labeled pool as-is', () => {
    const d = opened11();
    expect(d.state.a).toBeDefined();
    expect(d.state.b).toBeDefined();
    expect(d.state.draw).toHaveLength(11);
    expect(d.state.draw.map((c) => c.poolLabel).sort()).toEqual([...FORMAT_SONG_LABELS['hb11-static-pool']!].sort());
  });

  it('runs A-then-B vetoes for HB-11, then offers B the first pick', () => {
    const d = opened11();
    const seen: { actor: string; offered: number }[] = [];
    while (d.pending.kind === 'VETO') {
      const p = d.pending;
      seen.push({ actor: p.actor, offered: p.choices.length });
      d.apply({ actorId: p.actor, type: 'CHART_VETOED', payload: { by: p.actor, drawIndex: p.choices[0]! } });
    }
    expect(seen.map((s) => s.actor)).toEqual([d.state.a, d.state.b]);
    // 11 songs, 1 reserved (TB), 2 vetoed -> 8 left for the first pick.
    expect(seen[0]!.offered + seen[1]!.offered).toBe(10 + 9); // 10 non-TB choices, then 9 after the first veto
    expect(d.pending).toEqual({ kind: 'SELECT_SONG', actor: d.state.b, choices: expect.any(Array) });
  });

  it('never offers the reserved TB song as a veto or pick choice', () => {
    const d = opened11();
    const tbIndex = d.state.draw.findIndex((c) => c.poolLabel === 'TB');
    while (d.pending.kind === 'VETO' || d.pending.kind === 'SELECT_SONG') {
      const p = d.pending;
      expect(p.choices).not.toContain(tbIndex);
      if (p.kind === 'VETO') {
        d.apply({ actorId: p.actor, type: 'CHART_VETOED', payload: { by: p.actor, drawIndex: p.choices[0]! } });
      } else {
        d.pickSong();
        d.playSong(A);
      }
    }
  });
});

describe('a normal race to 3', () => {
  it('ends the moment either player reaches 3, without touching the reserved TB song', () => {
    const d = opened11();
    d.runProtectVeto(); // both vetoes
    // B, A, B, A, B — A wins every pick B loses and vice versa isn't needed;
    // just drive A to 3 straight wins.
    d.pickSong();
    d.playSong(A);
    d.pickSong();
    d.playSong(A);
    d.pickSong();
    d.playSong(A);
    expect(d.state.points[A]).toBe(3);
    expect(HB11.outcome(d.state)).toBeNull(); // still needs CONFIRM_RESULT
    expect(d.pending.kind).toBe('CONFIRM_RESULT');
    d.confirmResult();
    const outcome = HB11.outcome(d.state);
    expect(outcome?.placements.find((p) => p.entrantId === A)?.place).toBe(1);
    expect(d.state.songs.some((s) => s.chart.poolLabel === 'TB')).toBe(false);
  });
});

describe('the forced Tiebreaker song', () => {
  it('forces TB the instant the record reaches 2-2, skipping any further pick', () => {
    const d = opened11();
    d.runProtectVeto();
    d.pickSong();
    d.playSong(A); // 1-0
    d.pickSong();
    d.playSong(B); // 1-1
    d.pickSong();
    d.playSong(A); // 2-1
    d.pickSong();
    d.playSong(B); // 2-2
    // The next thing due is starting the TB song directly — never another SELECT_SONG.
    expect(d.pending).toEqual({ kind: 'SUBMIT_SCORE', actors: expect.any(Array), songIndex: 4 });
    expect(d.state.songs[4]!.chart.poolLabel).toBe('TB');
  });

  it('forces TB early if the non-TB pool runs out from ties, even off 2-2', () => {
    const d = opened11();
    d.runProtectVeto();
    // 8 non-TB songs available; tie all of them out.
    for (let i = 0; i < 8; i++) {
      d.pickSong();
      d.playSong('TIE');
    }
    expect(d.state.points[A]).toBe(0);
    expect(d.state.points[B]).toBe(0);
    expect(d.state.songs).toHaveLength(9);
    expect(d.state.songs[8]!.chart.poolLabel).toBe('TB');
  });

  it('decides a sub-3 finish by points once the pool is exhausted', () => {
    const d = opened11();
    d.runProtectVeto();
    d.pickSong();
    d.playSong(A); // 1-0
    for (let i = 0; i < 7; i++) {
      d.pickSong();
      d.playSong('TIE');
    }
    // TB forced (pool exhausted at 1-0); tie it too, so it stays 1-0.
    d.playSong('TIE');
    expect(d.state.points[A]).toBe(1);
    expect(d.state.points[B]).toBe(0);
    d.confirmResult();
    const outcome = HB11.outcome(d.state);
    expect(outcome?.placements.find((p) => p.entrantId === A)?.place).toBe(1);
  });

  it('resolves a TB tie by higher average EX% across every song played', () => {
    const d = opened11();
    d.runProtectVeto();
    d.pickSong();
    playCustom(d, A, B, 95, 80, A); // 1-0
    d.pickSong();
    playCustom(d, A, B, 85, 95, B); // 1-1
    d.pickSong();
    playCustom(d, A, B, 96, 82, A); // 2-1
    d.pickSong();
    playCustom(d, A, B, 84, 96, B); // 2-2 -> TB forced
    expect(d.state.songs[4]!.chart.poolLabel).toBe('TB');
    playCustom(d, A, B, 90, 90, 'TIE'); // TB ties; points stay 2-2
    expect(d.state.points[A]).toBe(2);
    expect(d.state.points[B]).toBe(2);
    // avg(A) = (95+85+96+84+90)/5 = 90, avg(B) = (80+95+82+96+90)/5 = 88.6
    expect(d.pending.kind).toBe('CONFIRM_RESULT');
    d.confirmResult();
    const outcome = HB11.outcome(d.state);
    expect(outcome?.placements.find((p) => p.entrantId === A)?.place).toBe(1);
  });

  it('escalates to a referee when points and average EX are both fully tied', () => {
    const d = opened11();
    d.runProtectVeto();
    d.pickSong();
    playCustom(d, A, B, 90, 90, A); // 1-0
    d.pickSong();
    playCustom(d, A, B, 90, 90, B); // 1-1
    d.pickSong();
    playCustom(d, A, B, 90, 90, A); // 2-1
    d.pickSong();
    playCustom(d, A, B, 90, 90, B); // 2-2 -> TB forced
    playCustom(d, A, B, 90, 90, 'TIE'); // TB ties; EX identical throughout
    expect(HB11.outcome(d.state)).toBeNull();
    expect(d.pending).toEqual({ kind: 'AWAITING_TO', reason: 'TIEBREAK_UNRESOLVED' });
  });
});

describe('HB-13 category-restricted vetoes', () => {
  it('runs A/B/A/B, and excludes a player\'s already-vetoed category from their second veto', () => {
    const d = opened13();
    const firstA = d.pending;
    if (firstA.kind !== 'VETO') throw new Error('expected VETO');
    expect(firstA.actor).toBe(d.state.a);
    const firstCategory = poolCategoryOf(d.state.draw[firstA.choices[0]!]!.poolLabel!);
    d.apply({ actorId: firstA.actor, type: 'CHART_VETOED', payload: { by: firstA.actor, drawIndex: firstA.choices[0]! } });

    const firstB = d.pending;
    if (firstB.kind !== 'VETO') throw new Error('expected VETO');
    expect(firstB.actor).toBe(d.state.b);
    d.apply({ actorId: firstB.actor, type: 'CHART_VETOED', payload: { by: firstB.actor, drawIndex: firstB.choices[0]! } });

    const secondA = d.pending;
    if (secondA.kind !== 'VETO') throw new Error('expected VETO');
    expect(secondA.actor).toBe(d.state.a);
    // None of A's second-veto choices share A's first-veto category.
    for (const i of secondA.choices) {
      expect(poolCategoryOf(d.state.draw[i]!.poolLabel!)).not.toBe(firstCategory);
    }
  });

  it('has no restriction between different players vetoing the same category', () => {
    const d = opened13();
    const firstA = d.pending;
    if (firstA.kind !== 'VETO') throw new Error('expected VETO');
    const firstCategory = poolCategoryOf(d.state.draw[firstA.choices[0]!]!.poolLabel!);
    d.apply({ actorId: firstA.actor, type: 'CHART_VETOED', payload: { by: firstA.actor, drawIndex: firstA.choices[0]! } });

    const firstB = d.pending;
    if (firstB.kind !== 'VETO') throw new Error('expected VETO');
    // B is free to veto from the same category A just used.
    const sameCategoryChoice = firstB.choices.find(
      (i) => poolCategoryOf(d.state.draw[i]!.poolLabel!) === firstCategory,
    );
    expect(sameCategoryChoice).toBeDefined();
  });
});
