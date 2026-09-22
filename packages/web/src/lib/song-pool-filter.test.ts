import type { SongPoolTabWire } from '@itg/shared';
import { describe, expect, it } from 'vitest';
import { computeUsedChartIds, sortByLabelOrder } from './song-pool-filter.js';

function tab(assignments: SongPoolTabWire['assignments']): SongPoolTabWire {
  return { formatKey: 'hb11-static-pool', assignments };
}

describe('computeUsedChartIds', () => {
  it('returns only chart ids with a label assignment in this tab', () => {
    expect(computeUsedChartIds(tab({ c1: 'RD1', c2: 'FT1' }))).toEqual(new Set(['c1', 'c2']));
  });

  it('is empty when nothing has been assigned yet', () => {
    expect(computeUsedChartIds(tab({}))).toEqual(new Set());
  });
});

describe('sortByLabelOrder', () => {
  const requiredLabels = ['RD1', 'RD2', 'FT1', 'FT2', 'FN1', 'TB'];

  it('orders chart ids by their label position, not input order', () => {
    const assignments = { c1: 'FT1', c2: 'RD1', c3: 'TB', c4: 'RD2' };
    expect(sortByLabelOrder(['c1', 'c2', 'c3', 'c4'], assignments, requiredLabels)).toEqual(['c2', 'c4', 'c1', 'c3']);
  });

  it('sorts a chart with no assignment to the end, defensively', () => {
    const assignments = { c1: 'RD1' };
    expect(sortByLabelOrder(['c2', 'c1'], assignments, requiredLabels)).toEqual(['c1', 'c2']);
  });
});
