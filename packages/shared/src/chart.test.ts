import { describe, expect, it } from 'vitest';
import {
  ChartInput,
  displayArtist,
  displaySubtitle,
  displayTitle,
  searchableText,
} from './chart.js';

const base = ChartInput.parse({
  title: '冥',
  titleTranslit: 'Mei',
  artist: 'Amuro vs Killer',
  playStyle: 'SINGLE',
  difficulty: 'EXPERT',
  meter: 12,
  stepartist: 'Sanxion7',
  description: 'Blockmania',
  sourcePack: 'Fraxtil',
});

describe('display resolution', () => {
  it('prefers the transliterated form when present', () => {
    expect(displayTitle(base)).toBe('Mei');
  });

  it('falls back to the original when there is none', () => {
    expect(displayTitle({ title: 'Vertex^', titleTranslit: null })).toBe('Vertex^');
    expect(displayArtist(base)).toBe('Amuro vs Killer');
    expect(displaySubtitle(base)).toBeNull();
  });
});

describe('searchableText', () => {
  it('includes both the original and transliterated forms', () => {
    const haystack = searchableText(base);
    expect(haystack).toContain('冥');
    expect(haystack).toContain('Mei');
  });

  it('includes stepartist and source pack, so a cross-field search matches', () => {
    const haystack = searchableText(base).toLowerCase();
    for (const token of ['mei', 'sanxion7', 'fraxtil']) expect(haystack).toContain(token);
  });

  it('excludes description, which is display-only', () => {
    expect(searchableText(base).toLowerCase()).not.toContain('blockmania');
  });

  it('omits absent fields rather than emitting blanks', () => {
    expect(searchableText(base)).not.toMatch(/\s{2,}/);
  });
});

describe('ChartInput', () => {
  it('separates the named slot from the numeric meter', () => {
    expect(base.difficulty).toBe('EXPERT');
    expect(base.meter).toBe(12);
  });

  it('rejects a meter outside the plausible range', () => {
    expect(ChartInput.safeParse({ ...base, meter: 0 }).success).toBe(false);
    expect(ChartInput.safeParse({ ...base, meter: 100 }).success).toBe(false);
  });
});
