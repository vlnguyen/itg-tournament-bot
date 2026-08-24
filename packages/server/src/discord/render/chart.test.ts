import { describe, expect, it } from 'vitest';
import type { ChartSnapshot } from '@itg/shared';
import { compactChartLabel, fullChartDescription } from './chart.js';

const base: ChartSnapshot = {
  chartId: 'c1',
  title: 'Vertex^',
  titleTranslit: null,
  subtitle: null,
  subtitleTranslit: null,
  artist: null,
  artistTranslit: null,
  playStyle: 'SINGLE' as const,
  difficulty: 'EXPERT' as const,
  meter: 12,
  stepartist: null,
  description: null,
  sourcePack: null,
  flags: [],
};

describe('compactChartLabel', () => {
  it('leads with the playstyle prefix, then meter, then the resolved title', () => {
    expect(compactChartLabel(base)).toBe('SX 12 · Vertex^');
  });

  it('resolves the transliterated title when present', () => {
    expect(compactChartLabel({ ...base, title: '原題', titleTranslit: 'Gendai' })).toBe('SX 12 · Gendai');
  });

  it('uses DX for a Doubles Expert chart', () => {
    expect(compactChartLabel({ ...base, playStyle: 'DOUBLE' })).toBe('DX 12 · Vertex^');
  });
});

describe('fullChartDescription', () => {
  it('is just the compact form when nothing else is set', () => {
    expect(fullChartDescription(base)).toBe('SX 12 · Vertex^');
  });

  it('adds subtitle/artist, stepartist, source pack, and flags as extra lines', () => {
    const full = fullChartDescription({
      ...base,
      subtitle: '(a variant)',
      artist: 'Some Artist',
      stepartist: 'Stepper',
      sourcePack: 'Pack Vol. 1',
      flags: ['noCmod'],
    });
    expect(full).toBe(
      ['SX 12 · Vertex^', '(a variant) — Some Artist', 'Steps: Stepper', 'Pack: Pack Vol. 1', '⚠️ noCmod'].join('\n'),
    );
  });
});
