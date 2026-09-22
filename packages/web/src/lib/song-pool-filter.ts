import type { SongPoolTabWire } from '@itg/shared';

/** Chart ids that have a label assigned within this specific tab — never "used anywhere in the tournament," since each static-pool format has its own independent pool. */
export function computeUsedChartIds(tab: SongPoolTabWire): Set<string> {
  return new Set(Object.keys(tab.assignments));
}

/**
 * Orders chart ids by their assigned label's position in `requiredLabels`
 * (e.g. RD1 → RD2 → ... → TB) — the actual draw order — rather than
 * whatever order the charts happen to arrive in. A chart with no
 * assignment (shouldn't happen for ids drawn from `computeUsedChartIds`,
 * but handled defensively) sorts last.
 */
export function sortByLabelOrder(chartIds: string[], assignments: SongPoolTabWire['assignments'], requiredLabels: readonly string[]): string[] {
  const indexOf = (chartId: string): number => {
    const label = assignments[chartId];
    const index = label ? requiredLabels.indexOf(label) : -1;
    return index === -1 ? requiredLabels.length : index;
  };
  return [...chartIds].sort((a, b) => indexOf(a) - indexOf(b));
}
