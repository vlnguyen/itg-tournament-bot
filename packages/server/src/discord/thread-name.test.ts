import { describe, expect, it } from 'vitest';
import { formatThreadName } from './thread-name.js';

describe('formatThreadName', () => {
  it('formats winners and losers rounds as WR/LR + round number', () => {
    expect(formatThreadName('WINNERS', 2, 'Alice', 'Bob')).toBe('WR2 · Alice vs Bob');
    expect(formatThreadName('LOSERS', 1, 'Alice', 'Bob')).toBe('LR1 · Alice vs Bob');
  });

  it('formats the grand final and its reset as GF1/GF2, not GFR', () => {
    expect(formatThreadName('GRAND_FINAL', 1, 'Alice', 'Bob')).toBe('GF1 · Alice vs Bob');
    expect(formatThreadName('GRAND_FINAL', 2, 'Alice', 'Bob')).toBe('GF2 · Alice vs Bob');
  });

  it('leaves short names untouched', () => {
    const name = formatThreadName('WINNERS', 3, 'Alice', 'Bob');
    expect(name.length).toBeLessThanOrEqual(100);
    expect(name).toBe('WR3 · Alice vs Bob');
  });

  it('truncates to fit the 100-character limit, shaving the longer name first', () => {
    const long = 'x'.repeat(80);
    const short = 'Bob';
    const name = formatThreadName('WINNERS', 1, long, short);
    expect(name.length).toBeLessThanOrEqual(100);
    expect(name).toContain(short); // the short name survives untouched
    expect(name).toContain('WR1 · ');
  });

  it('shaves roughly equally when both names are long', () => {
    const a = 'a'.repeat(60);
    const b = 'b'.repeat(60);
    const name = formatThreadName('LOSERS', 4, a, b);
    expect(name.length).toBeLessThanOrEqual(100);
    const [aPart, bPart] = name.split(' vs ');
    // Neither side should have been reduced to nothing while the other stayed long.
    const aLen = aPart!.replace('LR4 · ', '').length;
    const bLen = bPart!.length;
    expect(Math.abs(aLen - bLen)).toBeLessThanOrEqual(1);
  });

  it('degrades to empty names rather than exceeding the limit on pathological input', () => {
    const huge = 'z'.repeat(200);
    const name = formatThreadName('GRAND_FINAL', 2, huge, huge);
    expect(name.length).toBeLessThanOrEqual(100);
  });
});
