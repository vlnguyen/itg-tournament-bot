import type { PublicMatch, RealtimeFrame } from '@itg/shared';
import { describe, expect, it } from 'vitest';
import { describeFrame } from './announcements.js';

function frame(overrides: Partial<PublicMatch> = {}, seq = 5): RealtimeFrame {
  return {
    matchId: 'm1',
    seq,
    projection: {
      seq,
      formatKey: 'bo5-protect-veto',
      bracket: 'WINNERS',
      round: 1,
      slot: 0,
      participants: [
        { entrantId: 'a', seed: 1, displayName: 'Alice' },
        { entrantId: 'b', seed: 2, displayName: 'Bob' },
      ],
      draw: [],
      protects: [],
      vetoes: [],
      picks: [],
      songs: [],
      points: { a: 1, b: 0 },
      tiebreaks: [],
      setWinnerSelections: {},
      pending: { kind: 'DONE' },
      outcome: null,
      ...overrides,
    },
  };
}

describe('describeFrame', () => {
  it('describes an ordinary scoreline update for the log only — no polite announcement', () => {
    const a = describeFrame(frame(), 'Winners Round 1', undefined);
    expect(a.logLine).toBe('Winners Round 1: Alice 1, Bob 0.');
    expect(a.politeLine).toBeNull();
  });

  it('announces politely the moment a match completes — a real transition', () => {
    const a = describeFrame(
      frame({ points: { a: 3, b: 1 }, outcome: { placements: [{ entrantId: 'a', place: 1, points: 3 }], by: 'AGREEMENT' } }),
      'Winners Round 1',
      { status: 'IN_PROGRESS', awaitingTo: false },
    );
    expect(a.politeLine).toBe('Winners Round 1: Alice wins, Alice 3, Bob 1.');
    expect(a.logLine).toBe(a.politeLine);
  });

  it('does not re-announce a match that was already known complete', () => {
    const a = describeFrame(
      frame({ points: { a: 3, b: 1 }, outcome: { placements: [{ entrantId: 'a', place: 1, points: 3 }], by: 'AGREEMENT' } }),
      'Winners Round 1',
      { status: 'COMPLETE', awaitingTo: false },
    );
    expect(a.politeLine).toBeNull();
  });

  it('labels a walkover distinctly from an ordinary win', () => {
    const a = describeFrame(
      frame({ points: { a: 0, b: 0 }, outcome: { placements: [{ entrantId: 'a', place: 1, points: 0 }], by: 'WALKOVER' } }),
      'Losers Round 2',
      { status: 'PENDING', awaitingTo: false },
    );
    expect(a.politeLine).toBe('Losers Round 2: Alice advances by walkover, Alice 0, Bob 0.');
  });

  it('announces politely the moment a match starts awaiting an organizer', () => {
    const a = describeFrame(frame({ pending: { kind: 'AWAITING_TO', reason: 'WINNER_DISAGREEMENT', songIndex: 0 } }), 'Winners Round 1', {
      status: 'IN_PROGRESS',
      awaitingTo: false,
    });
    expect(a.politeLine).toBe('Winners Round 1: awaiting an organizer.');
  });

  it('does not re-announce an escalation still open from a prior frame', () => {
    const a = describeFrame(frame({ pending: { kind: 'AWAITING_TO', reason: 'WINNER_DISAGREEMENT', songIndex: 0 } }), 'Winners Round 1', {
      status: 'IN_PROGRESS',
      awaitingTo: true,
    });
    expect(a.politeLine).toBeNull();
  });
});
