import { describe, expect, it } from 'vitest';
import { buildScoreTicksLines } from './score-ticks.js';

const nameOf = (id: string) => (id === 'alice' ? 'Alice' : 'Bob');

describe('buildScoreTicksLines', () => {
  it('shows empty boxes when nothing has landed', () => {
    const lines = buildScoreTicksLines({ ex: {}, photoSeen: {} }, ['alice', 'bob'], nameOf);
    expect(lines).toBe('**Alice** — EX% ⬜  Photo ⬜\n**Bob** — EX% ⬜  Photo ⬜');
  });

  it('ticks EX% independently of photo, per player', () => {
    const lines = buildScoreTicksLines(
      { ex: { alice: 97.5 }, photoSeen: { bob: true } },
      ['alice', 'bob'],
      nameOf,
    );
    expect(lines).toBe('**Alice** — EX% ✅  Photo ⬜\n**Bob** — EX% ⬜  Photo ✅');
  });

  it('never renders the EX% value itself, only the tick', () => {
    const lines = buildScoreTicksLines({ ex: { alice: 99.99 }, photoSeen: {} }, ['alice', 'bob'], nameOf);
    expect(lines).not.toContain('99.99');
  });

  it('is fully ticked once both have landed for both players', () => {
    const lines = buildScoreTicksLines(
      { ex: { alice: 90, bob: 91 }, photoSeen: { alice: true, bob: true } },
      ['alice', 'bob'],
      nameOf,
    );
    expect(lines).toBe('**Alice** — EX% ✅  Photo ✅\n**Bob** — EX% ✅  Photo ✅');
  });
});
