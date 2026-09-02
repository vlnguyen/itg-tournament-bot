import { describe, expect, it } from 'vitest';
import type { ChartSnapshot } from '@itg/shared';
import { compactChartLabel, fullChartDescription, selectOptionDescription, selectOptionLabel } from './chart.js';

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
  description: null,  sourcePack: null,
  flags: [],
  poolLabel: null,
};

describe('compactChartLabel', () => {
  it('leads with the resolved title, then the playstyle prefix and meter trailing', () => {
    expect(compactChartLabel(base)).toBe('Vertex^ SX 12');
  });

  it('resolves the transliterated title when present', () => {
    expect(compactChartLabel({ ...base, title: '原題', titleTranslit: 'Gendai' })).toBe('Gendai SX 12');
  });

  it('uses DX for a Doubles Expert chart', () => {
    expect(compactChartLabel({ ...base, playStyle: 'DOUBLE' })).toBe('Vertex^ DX 12');
  });
});

describe('fullChartDescription', () => {
  it('is just the compact form when nothing else is set', () => {
    expect(fullChartDescription(base)).toBe('Vertex^ SX 12');
  });

  it('concatenates subtitle onto the title line, and never shows artist or source pack', () => {
    const full = fullChartDescription({
      ...base,
      subtitle: '(a variant)',
      artist: 'Some Artist',
      stepartist: 'Stepper',
      sourcePack: 'Pack Vol. 1',
    });
    expect(full).toBe(['Vertex^ (a variant) SX 12', 'Stepper'].join('\n'));
  });

  it('formats stepartist and description as "stepartist [description]"', () => {
    const full = fullChartDescription({ ...base, description: 'BR+ JU+ FS XO', stepartist: 'Stepper' });
    expect(full).toBe(['Vertex^ SX 12', 'Stepper [BR+ JU+ FS XO]'].join('\n'));
  });

  it('leads with the shorthand pool label when set, never the spelled-out category', () => {
    expect(fullChartDescription({ ...base, poolLabel: 'FT2' })).toBe('**FT2** Vertex^ SX 12');
  });

  it('renders the noCmod flag as "No CMOD"', () => {
    const full = fullChartDescription({ ...base, flags: ['noCmod'] });
    expect(full).toBe(['Vertex^ SX 12', '⚠️ No CMOD'].join('\n'));
  });

  it('puts a flag line before the stepartist line', () => {
    const full = fullChartDescription({ ...base, stepartist: 'Stepper', flags: ['noCmod'] });
    expect(full).toBe(['Vertex^ SX 12', '⚠️ No CMOD', 'Stepper'].join('\n'));
  });
});

describe('selectOptionLabel', () => {
  it('is just the compact form when unflagged', () => {
    expect(selectOptionLabel(base)).toBe('Vertex^ SX 12');
  });

  it('concatenates the subtitle onto the label with a space, not a separate line', () => {
    expect(selectOptionLabel({ ...base, subtitle: '(a variant)' })).toBe('Vertex^ (a variant) SX 12');
  });

  it('appends a warning icon for a noCmod chart — visible without opening the option', () => {
    expect(selectOptionLabel({ ...base, flags: ['noCmod'] })).toBe('Vertex^ SX 12 ⚠️');
  });

  it('leads with the shorthand pool label when set, never the spelled-out category', () => {
    expect(selectOptionLabel({ ...base, poolLabel: 'RD1' })).toBe('RD1: Vertex^ SX 12');
  });
});

describe('selectOptionDescription', () => {
  it('renders the noCmod flag as "No CMOD", never the raw flag value', () => {
    expect(selectOptionDescription({ ...base, flags: ['noCmod'] })).toBe('⚠️ No CMOD');
  });

  it('is undefined when there is nothing to show', () => {
    expect(selectOptionDescription(base)).toBeUndefined();
  });

  it('never shows the artist', () => {
    expect(selectOptionDescription({ ...base, artist: 'Some Artist' })).toBeUndefined();
  });

  it('formats stepartist and description as "stepartist [description]"', () => {
    const description = selectOptionDescription({ ...base, stepartist: 'midtown', description: 'BR+ JU+ FS XO' });
    expect(description).toBe('midtown [BR+ JU+ FS XO]');
  });

  it('shows the stepartist alone, unbracketed, when there is no description', () => {
    expect(selectOptionDescription({ ...base, stepartist: 'midtown' })).toBe('midtown');
  });

  it('shows the description alone, unbracketed, when there is no stepartist', () => {
    expect(selectOptionDescription({ ...base, description: 'Mirin' })).toBe('Mirin');
  });

  it('combines the stepartist/description line and flags, but never the subtitle — that lives on the label', () => {
    const description = selectOptionDescription({
      ...base,
      subtitle: '(a variant)',
      stepartist: 'midtown',
      description: 'BR+ JU+ FS XO',
      flags: ['noCmod'],
    });
    expect(description).toBe('midtown [BR+ JU+ FS XO] · ⚠️ No CMOD');
  });
});
