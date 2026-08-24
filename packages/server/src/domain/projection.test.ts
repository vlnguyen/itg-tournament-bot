import { describe, expect, it } from 'vitest';
import { Bo5ProtectVetoFormat as F } from './bo5.js';
import { deriveMatchStatus, toBracketMatch, toPublicMatch } from './projection.js';
import { MatchDriver } from './testkit.js';
import { emptyState } from './types.js';

const A = 'alice';
const B = 'bob';

const opened = (higherSeedTakes: 'FIRST' | 'SECOND' = 'FIRST') =>
  new MatchDriver().create(A, B).chooseSeed(higherSeedTakes).runProtectVeto();

describe('toPublicMatch', () => {
  it('carries the draw, protects, vetoes and points straight through', () => {
    const d = opened();
    const pub = toPublicMatch(F, d.state);
    expect(pub.draw).toEqual(d.state.draw);
    expect(pub.protects).toEqual(d.state.protects);
    expect(pub.vetoes).toEqual(d.state.vetoes);
    expect(pub.points).toEqual(d.state.points);
    expect(pub.deciderIndex).toBe(d.state.deciderIndex);
  });

  it('includes pending and outcome, computed from the format', () => {
    const d = new MatchDriver().create(A, B);
    expect(toPublicMatch(F, d.state).pending).toEqual(F.pendingAction(d.state));
    expect(toPublicMatch(F, d.state).outcome).toBeNull();
  });

  it('hides a lone tiebreak pick behind chosenBy, reveals once both land', () => {
    const d = opened();
    // Force every Draw song to tie so a tiebreak round is drawn.
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

    const midway = toPublicMatch(F, d.state).tiebreaks.at(-1)!;
    expect(midway.chosenBy).toEqual([p.actors[0]]);
    expect('choices' in midway).toBe(false);
    expect('resolvedIndex' in midway).toBe(false);

    d.apply({
      actorId: p.actors[1]!,
      type: 'TIEBREAK_CHOICE',
      payload: { round: p.round, by: p.actors[1]!, index: p.choices[0]! },
    });

    const revealed = toPublicMatch(F, d.state).tiebreaks.at(-1)!;
    expect(revealed.chosenBy.sort()).toEqual([...p.actors].sort());
    expect('choices' in revealed).toBe(true);
    expect('resolvedIndex' in revealed).toBe(true);
  });

  it('never names a referee — MatchState does not record one to leak', () => {
    const d = opened(); // song 0 already started; not yet committed
    d.apply({ actorId: 'referee-42', type: 'SONG_RULED', payload: { songIndex: 0, result: A } });
    const pub = toPublicMatch(F, d.state);
    expect(JSON.stringify(pub)).not.toContain('referee-42');
    expect(pub.songs[0]!.result).toEqual({ winner: A, by: 'RULING' });
  });
});

describe('toBracketMatch', () => {
  it('reports PENDING, then IN_PROGRESS, then COMPLETE across a match', () => {
    const d = new MatchDriver();
    expect(deriveMatchStatus(F, emptyState())).toBe('PENDING');

    d.create(A, B);
    expect(toBracketMatch(F, d.state).status).toBe('IN_PROGRESS');
    expect(toBracketMatch(F, d.state).winnerId).toBeNull();

    d.chooseSeed('FIRST').runProtectVeto();
    expect(toBracketMatch(F, d.state).currentChartId).toBe(d.state.songs[0]!.chart.chartId);

    while (F.outcome(d.state) === null) {
      const p = d.pending;
      if (p.kind === 'SUBMIT_SCORE') d.playSong(A);
      else if (p.kind === 'CONFIRM_RESULT') d.confirmResult();
      else throw new Error(`unexpected ${p.kind}`);
    }
    const finished = toBracketMatch(F, d.state);
    expect(finished.status).toBe('COMPLETE');
    expect(finished.winnerId).toBe(A);
    expect(finished.currentChartId).toBeNull();
  });
});
