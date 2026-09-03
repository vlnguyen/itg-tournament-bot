import type { PublicMatch, RealtimeFrame, TournamentSnapshot } from '@itg/shared';
import { describe, expect, it } from 'vitest';
import { applyFrameToMatchDetail, applyFrameToSnapshot, shouldApplyFrame } from './realtime-frames.js';

describe('shouldApplyFrame', () => {
  it('applies the first frame for a match, regardless of its seq', () => {
    expect(shouldApplyFrame(undefined, 1)).toBe(true);
    expect(shouldApplyFrame(undefined, 99)).toBe(true);
  });

  it('applies a frame strictly newer than what is held', () => {
    expect(shouldApplyFrame(3, 4)).toBe(true);
  });

  it('drops a frame that is not newer — equal or older', () => {
    expect(shouldApplyFrame(4, 4)).toBe(false);
    expect(shouldApplyFrame(5, 4)).toBe(false);
  });
});

function emptyPublicMatch(seq: number): PublicMatch {
  return {
    seq,
    formatKey: 'bo5-protect-veto',
    bracket: 'WINNERS',
    round: 1,
    slot: 0,
    participants: [],
    draw: [],
    protects: [],
    vetoes: [],
    picks: [],
    songs: [],
    points: {},
    tiebreaks: [],
    setWinnerSelections: {},
    pending: { kind: 'DONE' as const },
    outcome: null,
  };
}

function snapshotWith(matchId: string, seq = 2): TournamentSnapshot {
  return {
    id: 't1',
    name: 'Test',
    state: 'RUNNING',
    guildId: 'g1',
    guildName: 'Test Guild',
    entrantCount: 2,
    matches: [
      {
        id: matchId,
        bracket: 'WINNERS',
        round: 1,
        slot: 0,
        match: {
          seq,
          formatKey: 'bo5-protect-veto',
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
        },
      },
    ],
  };
}

describe('applyFrameToSnapshot', () => {
  it('patches the matching cell with the derived BracketMatch', () => {
    const snapshot = snapshotWith('m1', 2);
    const frame: RealtimeFrame = {
      matchId: 'm1',
      seq: 5,
      projection: {
        ...emptyPublicMatch(5),
        participants: [
          { entrantId: 'a', seed: 1, displayName: 'Alice' },
          { entrantId: 'b', seed: 2, displayName: 'Bob' },
        ],
        points: { a: 1, b: 0 },
        outcome: { placements: [{ entrantId: 'a', place: 1, points: 3 }], by: 'AGREEMENT' },
      },
    };

    const patched = applyFrameToSnapshot(snapshot, frame);
    expect(patched.matches[0]!.match).toEqual({
      seq: 5,
      formatKey: 'bo5-protect-veto',
      participants: [
        { entrantId: 'a', seed: 1, displayName: 'Alice' },
        { entrantId: 'b', seed: 2, displayName: 'Bob' },
      ],
      status: 'COMPLETE',
      awaitingTo: false,
      outcomeBy: 'AGREEMENT',
      points: { a: 1, b: 0 },
      currentChartId: null,
      winnerId: 'a',
    });
    // The original is untouched — a new object comes back.
    expect(snapshot.matches[0]!.match.status).toBe('IN_PROGRESS');
  });

  it('returns the same snapshot unchanged when the frame names a match not in it', () => {
    const snapshot = snapshotWith('m1');
    const frame: RealtimeFrame = { matchId: 'does-not-exist', seq: 1, projection: emptyPublicMatch(1) };
    expect(applyFrameToSnapshot(snapshot, frame)).toBe(snapshot);
  });

  it('drops a stale frame — seq not newer than what the cell already holds, e.g. after a refetch raced ahead of a reordered frame', () => {
    const snapshot = snapshotWith('m1', 10);
    const frame: RealtimeFrame = { matchId: 'm1', seq: 8, projection: emptyPublicMatch(8) };
    expect(applyFrameToSnapshot(snapshot, frame)).toBe(snapshot);
  });
});

describe('applyFrameToMatchDetail', () => {
  it('adopts the frame when nothing is cached yet', () => {
    const frame: RealtimeFrame = { matchId: 'm1', seq: 3, projection: emptyPublicMatch(3) };
    expect(applyFrameToMatchDetail(undefined, frame)).toEqual(frame.projection);
  });

  it('adopts a frame newer than what is cached', () => {
    const current = emptyPublicMatch(3);
    const frame: RealtimeFrame = { matchId: 'm1', seq: 4, projection: emptyPublicMatch(4) };
    expect(applyFrameToMatchDetail(current, frame)).toEqual(frame.projection);
  });

  it('keeps the cached value when the frame is stale', () => {
    const current = emptyPublicMatch(10);
    const frame: RealtimeFrame = { matchId: 'm1', seq: 8, projection: emptyPublicMatch(8) };
    expect(applyFrameToMatchDetail(current, frame)).toBe(current);
  });
});
