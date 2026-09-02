import type { ChartSnapshot } from '@itg/shared';
import { describe, expect, it } from 'vitest';
import { EMPTY_FILTERS, filterCharts, matchesSearch, packHasMixedPlayStyles } from './pack-search.js';

function chart(overrides: Partial<ChartSnapshot> = {}): ChartSnapshot {
  return {
    chartId: 'c1',
    title: 'Vertex',
    titleTranslit: null,
    subtitle: null,
    subtitleTranslit: null,
    artist: 'Sanxion7',
    artistTranslit: null,
    playStyle: 'SINGLE',
    difficulty: 'EXPERT',
    meter: 15,
    stepartist: 'Some Stepper',
    description: null,
    sourcePack: 'Test Pack',
    flags: [],
    poolLabel: null,
    ...overrides,
  };
}

describe('matchesSearch', () => {
  it('matches on any field, case-insensitively', () => {
    expect(matchesSearch(chart(), 'VERTEX')).toBe(true);
    expect(matchesSearch(chart(), 'sanxion')).toBe(true);
    expect(matchesSearch(chart(), 'some stepper')).toBe(true);
  });

  it('matches partial, out-of-order tokens across fields', () => {
    // "vertex" is the title, "sanxion" is the artist — a search combining
    // both should still hit, per DESIGN.md: "a player searching *vertex
    // sanxion* is combining a title and a stepartist and should get the
    // chart."
    expect(matchesSearch(chart(), 'sanxion vertex')).toBe(true);
  });

  it('requires every token to appear somewhere', () => {
    expect(matchesSearch(chart(), 'vertex nonexistent')).toBe(false);
  });

  it('ignores diacritics', () => {
    expect(matchesSearch(chart({ title: 'Résonance' }), 'resonance')).toBe(true);
  });

  it('ignores punctuation', () => {
    expect(matchesSearch(chart({ title: "Don't Stop" }), 'dont stop')).toBe(true);
  });

  it('matches the transliterated form too', () => {
    expect(matchesSearch(chart({ title: '曲名', titleTranslit: 'Kyokumei' }), 'kyokumei')).toBe(true);
  });

  it('matches everything on an empty query', () => {
    expect(matchesSearch(chart(), '')).toBe(true);
    expect(matchesSearch(chart(), '   ')).toBe(true);
  });

  it('does not match on description — display-only, not searchable', () => {
    expect(matchesSearch(chart({ description: 'unique-description-text' }), 'unique-description-text')).toBe(false);
  });
});

describe('filterCharts', () => {
  const charts = [
    chart({ chartId: 'a', difficulty: 'EXPERT', meter: 15, playStyle: 'SINGLE', flags: [] }),
    chart({ chartId: 'b', difficulty: 'HARD', meter: 10, playStyle: 'DOUBLE', flags: ['noCmod'] }),
  ];

  it('filters by difficulty', () => {
    expect(filterCharts(charts, { ...EMPTY_FILTERS, difficulty: 'HARD' }).map((c) => c.chartId)).toEqual(['b']);
  });

  it('filters by playstyle', () => {
    expect(filterCharts(charts, { ...EMPTY_FILTERS, playStyle: 'SINGLE' }).map((c) => c.chartId)).toEqual(['a']);
  });

  it('filters by meter range', () => {
    expect(filterCharts(charts, { ...EMPTY_FILTERS, minMeter: 12, maxMeter: 20 }).map((c) => c.chartId)).toEqual(['a']);
  });

  it('filters by the noCmod checkbox', () => {
    expect(filterCharts(charts, { ...EMPTY_FILTERS, noCmodOnly: true }).map((c) => c.chartId)).toEqual(['b']);
  });

  it('combines every filter with search', () => {
    expect(filterCharts(charts, { ...EMPTY_FILTERS, search: 'vertex', difficulty: 'HARD' })).toHaveLength(1);
  });
});

describe('packHasMixedPlayStyles', () => {
  it('is false for a single-playstyle pack', () => {
    expect(packHasMixedPlayStyles([chart({ playStyle: 'SINGLE' }), chart({ playStyle: 'SINGLE' })])).toBe(false);
  });

  it('is true once Doubles charts are mixed in', () => {
    expect(packHasMixedPlayStyles([chart({ playStyle: 'SINGLE' }), chart({ playStyle: 'DOUBLE' })])).toBe(true);
  });
});
