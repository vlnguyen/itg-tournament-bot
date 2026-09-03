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

  describe('a static-pool format (Hubert\'s formats — every chart carries a poolLabel)', () => {
    const labeled = (n: number, poolLabel: string): ChartSnapshot => ({ ...chart(n), poolLabel });

    it('is titled "Song Pool," not "The Draw"', () => {
      const embed = buildDrawEmbed([labeled(1, 'RD1')]);
      expect(embed.data.title).toBe('Song Pool');
    });

    it('groups fields by category in RD, FT, FN, TB order, then numerically within a category — not draw position', () => {
      // Deliberately out of order and interleaved, as a real static pool's Draw position order would never guarantee.
      const charts = [labeled(1, 'FT2'), labeled(2, 'TB'), labeled(3, 'RD2'), labeled(4, 'RD1'), labeled(5, 'FT1'), labeled(6, 'FN1')];
      const embed = buildDrawEmbed(charts);
      expect(embed.data.fields!.map((f) => f.name)).toEqual(['RD1', 'RD2', 'FT1', 'FT2', 'FN1', 'TB']);
    });

    it('uses the label as the field name and never repeats it inside the field value', () => {
      const embed = buildDrawEmbed([labeled(1, 'RD1')]);
      expect(embed.data.fields![0]!.name).toBe('RD1');
      expect(embed.data.fields![0]!.value).not.toContain('RD1');
      expect(embed.data.fields![0]!.value).toContain('Song 1');
    });
  });
});
