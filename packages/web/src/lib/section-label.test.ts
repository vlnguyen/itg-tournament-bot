import { describe, expect, it } from 'vitest';
import { sectionLabel } from './section-label.js';

describe('sectionLabel', () => {
  it('labels winners and losers rounds by number', () => {
    expect(sectionLabel('WINNERS', 1)).toBe('Winners Round 1');
    expect(sectionLabel('LOSERS', 3)).toBe('Losers Round 3');
  });

  it('labels the grand final and its reset by name, not round number', () => {
    expect(sectionLabel('GRAND_FINAL', 1)).toBe('Grand Final');
    expect(sectionLabel('GRAND_FINAL', 2)).toBe('Grand Final Reset');
  });
});
