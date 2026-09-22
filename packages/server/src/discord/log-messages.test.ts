import { describe, expect, it } from 'vitest';
import type { ChartSnapshot } from '@itg/shared';
import { renderSongResultLog } from './log-messages.js';
import type { PlayerDirectory } from './state-message.js';

const chart: ChartSnapshot = {
  chartId: 'c1',
  title: 'Vertex',
  titleTranslit: null,
  subtitle: null,
  subtitleTranslit: null,
  artist: null,
  artistTranslit: null,
  playStyle: 'SINGLE',
  difficulty: 'EXPERT',
  meter: 15,
  stepartist: null,
  description: null,
  sourcePack: null,
  flags: [],
  poolLabel: null,
};

const players: PlayerDirectory = new Map([
  ['alice', { discordUserId: 'u-alice', displayName: 'Alice' }],
  ['bob', { discordUserId: 'u-bob', displayName: 'Bob' }],
]);

function description(msg: ReturnType<typeof renderSongResultLog>): string {
  return msg.embeds![0]!.data.description!;
}

describe('renderSongResultLog', () => {
  it('reports a tied set after this win evens the score', () => {
    const msg = renderSongResultLog(0, chart, 'alice', players, { alice: 1, bob: 1 }, ['alice', 'bob']);
    expect(description(msg)).toContain('Set is tied 1-1.');
  });

  it('reports the leader and margin after a win that puts one player ahead', () => {
    const msg = renderSongResultLog(1, chart, 'alice', players, { alice: 2, bob: 1 }, ['alice', 'bob']);
    expect(description(msg)).toContain('**Alice** leads the set 2-1.');
  });

  it('names whichever player is ahead, not just the one who just won', () => {
    const msg = renderSongResultLog(2, chart, 'bob', players, { alice: 2, bob: 1 }, ['alice', 'bob']);
    expect(description(msg)).toContain('**Alice** leads the set 2-1.');
  });

  it('adds no record line for a tied song', () => {
    const msg = renderSongResultLog(0, chart, 'TIE', players, { alice: 0, bob: 0 }, ['alice', 'bob']);
    expect(description(msg)).not.toContain('leads');
    expect(description(msg)).not.toContain('tied the set');
  });

  it('adds no record line for a voided song', () => {
    const msg = renderSongResultLog(0, chart, 'VOID', players, { alice: 0, bob: 0 }, ['alice', 'bob']);
    expect(description(msg)).not.toContain('leads');
    expect(description(msg)).not.toContain('Set is tied');
  });
});
