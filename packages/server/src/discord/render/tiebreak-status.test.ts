import { describe, expect, it } from 'vitest';
import { buildTiebreakStatusLines } from './tiebreak-status.js';

const nameOf = (id: string) => (id === 'alice' ? 'Alice' : 'Bob');

describe('buildTiebreakStatusLines', () => {
  it('shows not-yet for a player with no recorded choice', () => {
    const lines = buildTiebreakStatusLines({}, ['alice', 'bob'], nameOf);
    expect(lines).toBe('**Alice**: ⬜ not yet\n**Bob**: ⬜ not yet');
  });

  it('ticks a player who has chosen, independent of the other', () => {
    const lines = buildTiebreakStatusLines({ alice: 1 }, ['alice', 'bob'], nameOf);
    expect(lines).toBe('**Alice**: ✅ picked\n**Bob**: ⬜ not yet');
  });

  it('never renders the chosen index anywhere', () => {
    const lines = buildTiebreakStatusLines({ alice: 2, bob: 0 }, ['alice', 'bob'], nameOf);
    expect(lines).not.toMatch(/[012]/);
  });
});
