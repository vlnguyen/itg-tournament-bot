import { describe, expect, it } from 'vitest';
import { formatThreadName } from './thread-name.js';

describe('formatThreadName', () => {
  it('formats winners and losers rounds as WR/LR + round number', () => {
    expect(formatThreadName('WINNERS', 2, 'Alice', 'Bob', 'Storm 2026')).toBe('WR2 · Alice vs Bob · Storm 2026');
    expect(formatThreadName('LOSERS', 1, 'Alice', 'Bob', 'Storm 2026')).toBe('LR1 · Alice vs Bob · Storm 2026');
  });

  it('formats the grand final and its reset as GF1/GF2, not GFR', () => {
    expect(formatThreadName('GRAND_FINAL', 1, 'Alice', 'Bob', 'Storm 2026')).toBe('GF1 · Alice vs Bob · Storm 2026');
    expect(formatThreadName('GRAND_FINAL', 2, 'Alice', 'Bob', 'Storm 2026')).toBe('GF2 · Alice vs Bob · Storm 2026');
  });

  it('leaves short names untouched and appends the tournament name last', () => {
    const name = formatThreadName('WINNERS', 3, 'Alice', 'Bob', 'Storm 2026');
    expect(name.length).toBeLessThanOrEqual(100);
    expect(name).toBe('WR3 · Alice vs Bob · Storm 2026');
  });

  it('truncates to fit the 100-character limit, shaving the longer name first', () => {
    const long = 'x'.repeat(80);
    const short = 'Bob';
    const name = formatThreadName('WINNERS', 1, long, short, 'Storm 2026');
    expect(name.length).toBeLessThanOrEqual(100);
    expect(name).toContain(short); // the short name survives untouched
    expect(name).toContain('WR1 · ');
    expect(name).toContain('Storm 2026'); // the tournament name isn't trimmed by this pass
  });

  it('shaves roughly equally when both names are long, never touching the tournament-name suffix', () => {
    const a = 'a'.repeat(60);
    const b = 'b'.repeat(60);
    const name = formatThreadName('LOSERS', 4, a, b, 'Storm 2026');
    expect(name.length).toBeLessThanOrEqual(100);
    expect(name.endsWith(' · Storm 2026')).toBe(true);
    const withoutSuffix = name.slice(0, -' · Storm 2026'.length);
    const [aPart, bPart] = withoutSuffix.split(' vs ');
    // Neither side should have been reduced to nothing while the other stayed long.
    const aLen = aPart!.replace('LR4 · ', '').length;
    const bLen = bPart!.length;
    expect(Math.abs(aLen - bLen)).toBeLessThanOrEqual(1);
  });

  it('degrades to empty names rather than exceeding the limit on pathological input', () => {
    const huge = 'z'.repeat(200);
    const name = formatThreadName('GRAND_FINAL', 2, huge, huge, 'Storm 2026');
    expect(name.length).toBeLessThanOrEqual(100);
  });

  it('hard-cuts as a last resort when even empty names plus the tournament name do not fit', () => {
    const hugeName = 'z'.repeat(200);
    const name = formatThreadName('WINNERS', 1, '', '', hugeName);
    expect(name.length).toBeLessThanOrEqual(100);
  });
});
