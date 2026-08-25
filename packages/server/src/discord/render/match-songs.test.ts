import { describe, expect, it } from 'vitest';
import type { ChartSnapshot } from '@itg/shared';
import { buildMatchSongsEmbed } from './match-songs.js';

const chart = (n: number): ChartSnapshot => ({
  chartId: `c${n}`,
  title: `Song ${n}`,
  titleTranslit: null,
  subtitle: null,
  subtitleTranslit: null,
  artist: null,
  artistTranslit: null,
  playStyle: 'SINGLE',
  difficulty: 'EXPERT',
  meter: 12,
  stepartist: null,
  description: null,
  sourcePack: null,
  flags: [],
});

const draw = [chart(1), chart(2), chart(3), chart(4), chart(5), chart(6), chart(7)];
const names = new Map([
  ['alice', 'Alice'],
  ['bob', 'Bob'],
]);
const nameOf = (id: string) => names.get(id) ?? id;

describe('buildMatchSongsEmbed', () => {
  it('is titled "Match Songs"', () => {
    const embed = buildMatchSongsEmbed(
      { draw, protects: [{ drawIndex: 0, by: 'alice' }], deciderIndex: undefined },
      nameOf,
    );
    expect(embed.data.title).toBe('Match Songs');
  });

  it('lists protected charts in protect order, with the protector attributed', () => {
    const embed = buildMatchSongsEmbed(
      {
        draw,
        protects: [
          { drawIndex: 2, by: 'alice' },
          { drawIndex: 5, by: 'bob' },
        ],
        deciderIndex: undefined,
      },
      nameOf,
    );
    expect(embed.data.description).toBe('**Alice** — Song 3 SX 12 🛡️\n**Bob** — Song 6 SX 12 🛡️');
  });

  it('excludes vetoed charts entirely — they never appear in `protects`', () => {
    // Vetoes aren't part of the input shape at all: nothing to filter.
    const embed = buildMatchSongsEmbed(
      { draw, protects: [{ drawIndex: 0, by: 'alice' }], deciderIndex: undefined },
      nameOf,
    );
    expect(embed.data.description).not.toContain('Song 2');
  });

  it('lists the Decider last and unattributed once determined', () => {
    const embed = buildMatchSongsEmbed(
      {
        draw,
        protects: [
          { drawIndex: 0, by: 'alice' },
          { drawIndex: 1, by: 'bob' },
          { drawIndex: 2, by: 'alice' },
          { drawIndex: 3, by: 'bob' },
        ],
        deciderIndex: 4,
      },
      nameOf,
    );
    expect(embed.data.description!.split('\n').at(-1)).toBe('Decider — Song 5 SX 12 ⭐');
  });

  it('omits the Decider line when it is not yet determined', () => {
    const embed = buildMatchSongsEmbed(
      { draw, protects: [{ drawIndex: 0, by: 'alice' }], deciderIndex: undefined },
      nameOf,
    );
    expect(embed.data.description).not.toContain('Decider');
  });
});
