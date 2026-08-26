import type { BracketMatch } from '@itg/shared';
import { describe, expect, it } from 'vitest';
import { describeMatch, matchStateLabel } from './describe-match.js';

function base(overrides: Partial<BracketMatch> = {}): BracketMatch {
  return {
    seq: 1,
    participants: [
      { entrantId: 'a', seed: 1, displayName: 'Alice' },
      { entrantId: 'b', seed: 2, displayName: 'Bob' },
    ],
    status: 'IN_PROGRESS',
    awaitingTo: false,
    outcomeBy: null,
    points: { a: 0, b: 0 },
    currentChartId: null,
    winnerId: null,
    ...overrides,
  };
}

describe('matchStateLabel', () => {
  it('reports pending when no one is seated yet', () => {
    expect(matchStateLabel(base({ status: 'PENDING' }))).toBe('Pending');
  });

  it('reports in progress', () => {
    expect(matchStateLabel(base({ status: 'IN_PROGRESS' }))).toBe('In progress');
  });

  it('reports awaiting organizer even though status is still IN_PROGRESS', () => {
    expect(matchStateLabel(base({ status: 'IN_PROGRESS', awaitingTo: true }))).toBe('Awaiting organizer');
  });

  it('reports complete for an ordinary agreed finish', () => {
    expect(matchStateLabel(base({ status: 'COMPLETE', outcomeBy: 'AGREEMENT' }))).toBe('Complete');
  });

  it('reports complete for a referee ruling, a forfeit, or a DQ — not walkover-labelled', () => {
    for (const by of ['RULING', 'FORFEIT', 'DQ'] as const) {
      expect(matchStateLabel(base({ status: 'COMPLETE', outcomeBy: by }))).toBe('Complete');
    }
  });

  it('reports walkover distinctly', () => {
    expect(matchStateLabel(base({ status: 'COMPLETE', outcomeBy: 'WALKOVER' }))).toBe('Walkover');
  });
});

describe('describeMatch', () => {
  it('describes an undetermined match with no participants seated', () => {
    expect(describeMatch(base({ status: 'PENDING', participants: [] }))).toBe('Pending, not yet determined.');
  });

  it('describes a live match with the running score', () => {
    const m = base({ points: { a: 2, b: 1 } });
    expect(describeMatch(m)).toBe('seed 1 Alice, 2, versus seed 2 Bob, 1. In progress.');
  });

  it('marks the winner in the description', () => {
    const m = base({ status: 'COMPLETE', outcomeBy: 'AGREEMENT', points: { a: 3, b: 1 }, winnerId: 'a' });
    expect(describeMatch(m)).toBe('seed 1 Alice, 3, winner, versus seed 2 Bob, 1. Complete.');
  });
});
