import type { BracketMatch } from '@itg/shared';
import { describe, expect, it } from 'vitest';
import { describeMatch, matchStateLabel } from './describe-match.js';

function base(overrides: Partial<BracketMatch> = {}): BracketMatch {
  return {
    seq: 1,
    formatKey: 'bo5-protect-veto',
    participants: [
      { entrantId: 'a', seed: 1, displayName: 'Alice' },
      { entrantId: 'b', seed: 2, displayName: 'Bob' },
    ],
    status: 'IN_PROGRESS',
    awaitingTo: false,
    outcomeBy: null,
    outcomeWinCondition: null,
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

  it('reports DQ instead of a played score for the DQd loser', () => {
    const m = base({ status: 'COMPLETE', outcomeBy: 'DQ', points: { a: 2, b: 0 }, winnerId: 'a' });
    expect(describeMatch(m)).toBe('seed 1 Alice, 2, winner, versus seed 2 Bob, DQ. Complete.');
  });

  it('reports DQ instead of a played score for a walkover between two real, already-seated entrants', () => {
    // Both finalists were seeded in ahead of time, but one had already
    // withdrawn by the time this match went to start — `engine.ts`'s
    // `startSeatedMatch` — so it's a `WALKOVER`, not a `DQ`, even though
    // both seats are real.
    const m = base({ status: 'COMPLETE', outcomeBy: 'WALKOVER', points: { a: 0, b: 0 }, winnerId: 'a' });
    expect(describeMatch(m)).toBe('seed 1 Alice, 0, winner, versus seed 2 Bob, DQ. Walkover.');
  });

  it('describes a bye distinctly from a still-pending slot', () => {
    const m = base({
      status: 'COMPLETE',
      outcomeBy: 'WALKOVER',
      participants: [{ entrantId: 'a', seed: 1, displayName: 'Alice' }],
      winnerId: 'a',
    });
    expect(describeMatch(m)).toBe('seed 1 Alice receives a bye. Walkover.');
  });

  it('reads out a round-1 seed-order projection for an organizer, mirroring the dimmed/italic visual cue', () => {
    const m = base({ status: 'PENDING', participants: [] });
    expect(describeMatch(m, [{ kind: 'entrant', seed: 1, displayName: 'Alice' }, { kind: 'entrant', seed: 2, displayName: 'Bob' }])).toBe(
      'seed 1 Alice projected, versus seed 2 Bob projected. Pending.',
    );
  });

  it('reads a projected bye slot as "a bye" rather than a name', () => {
    const m = base({ status: 'PENDING', participants: [] });
    expect(describeMatch(m, [{ kind: 'entrant', seed: 1, displayName: 'Alice' }, { kind: 'bye' }])).toBe('seed 1 Alice projected, versus a bye. Pending.');
  });

  it('ignores a projection once the match has actually seated, or for a non-pending status', () => {
    expect(describeMatch(base({ points: { a: 2, b: 1 } }), [{ kind: 'entrant', seed: 1, displayName: 'Someone Else' }, undefined])).toBe(
      'seed 1 Alice, 2, versus seed 2 Bob, 1. In progress.',
    );
  });

  it('falls back to "not yet determined" when a projection carries no entries at all', () => {
    expect(describeMatch(base({ status: 'PENDING', participants: [] }), [undefined, undefined])).toBe('Pending, not yet determined.');
  });
});
