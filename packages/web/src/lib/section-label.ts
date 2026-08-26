import type { BracketSide } from '@itg/shared';

/** How a round reads in prose — "Winners Round 1", not the grand final's own rounds, which read as names instead of numbers. */
export function sectionLabel(bracket: BracketSide, round: number): string {
  if (bracket === 'GRAND_FINAL') return round === 1 ? 'Grand Final' : 'Grand Final Reset';
  return `${bracket === 'WINNERS' ? 'Winners' : 'Losers'} Round ${round}`;
}
