import { describe, expect, it } from 'vitest';
import type { ChartSnapshot } from '@itg/shared';
import { buildDrawEmbed } from './draw.js';

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
  description: null,  sourcePack: null,
  flags: [],
  poolLabel: null,
});

describe('buildDrawEmbed', () => {
  it('is titled "The Draw"', () => {
    const embed = buildDrawEmbed([chart(1)]);
    expect(embed.data.title).toBe('The Draw');
  });

  it('numbers each chart as its own field', () => {
    const embed = buildDrawEmbed([chart(1), chart(2)]);
    expect(embed.data.fields!.map((f) => f.name)).toEqual(['1', '2']);
    expect(embed.data.fields![0]!.value).toContain('Song 1');
    expect(embed.data.fields![1]!.value).toContain('Song 2');
  });
});
