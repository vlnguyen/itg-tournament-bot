import { searchableText } from '@itg/shared';
import type { ChartSnapshot, DifficultySlot, PlayStyle } from '@itg/shared';

/**
 * "Matching normalises case, diacritics and punctuation, then requires
 * every typed token to appear somewhere in the chart's combined text, in
 * any order." See DESIGN.md, "The pack tab". `searchableText()` is the
 * shared haystack-assembler — "the search surface cannot drift from the
 * fields a chart actually carries."
 */
const COMBINING_MARKS = /[\u0300-\u036f]/g;

function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/['’]/g, '') // apostrophes elide (contractions/possessives) rather than split a word in two
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // every other punctuation mark separates words
    .trim();
}

export function matchesSearch(chart: ChartSnapshot, query: string): boolean {
  const tokens = normalize(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = normalize(searchableText(chart));
  return tokens.every((t) => haystack.includes(t));
}

export interface PackFilters {
  search: string;
  difficulty: DifficultySlot | null;
  minMeter: number | null;
  maxMeter: number | null;
  playStyle: PlayStyle | null;
  noCmodOnly: boolean;
}

export const EMPTY_FILTERS: PackFilters = {
  search: '',
  difficulty: null,
  minMeter: null,
  maxMeter: null,
  playStyle: null,
  noCmodOnly: false,
};

export function filterCharts(charts: ChartSnapshot[], filters: PackFilters): ChartSnapshot[] {
  return charts.filter((c) => {
    if (filters.difficulty && c.difficulty !== filters.difficulty) return false;
    if (filters.playStyle && c.playStyle !== filters.playStyle) return false;
    if (filters.minMeter !== null && c.meter < filters.minMeter) return false;
    if (filters.maxMeter !== null && c.meter > filters.maxMeter) return false;
    if (filters.noCmodOnly && !c.flags.includes('noCmod')) return false;
    if (!matchesSearch(c, filters.search)) return false;
    return true;
  });
}

/** "Playstyle is hidden when the pack holds only one." */
export function packHasMixedPlayStyles(charts: ChartSnapshot[]): boolean {
  return new Set(charts.map((c) => c.playStyle)).size > 1;
}
