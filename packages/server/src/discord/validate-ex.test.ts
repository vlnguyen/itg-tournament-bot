import { describe, expect, it } from 'vitest';
import { parseExPercent } from './validate-ex.js';

describe('parseExPercent', () => {
  it.each([
    ['0', 0],
    ['0.00', 0],
    ['100', 100],
    ['100.00', 100],
    ['97.32', 97.32],
    ['5', 5],
    ['5.5', 5.5],
    [' 97.32 ', 97.32], // whitespace tolerated
  ])('accepts %s -> %s', (raw, expected) => {
    expect(parseExPercent(raw)).toBe(expected);
  });

  it.each([
    ['100.01', 'over 100'],
    ['-1', 'negative'],
    ['-0.01', 'negative with decimal'],
    ['97.321', 'three decimal places'],
    ['abc', 'not a number'],
    ['', 'empty'],
    ['97.', 'trailing dot with no digits'],
    ['1e5', 'exponential notation'],
    ['1000', 'four digits'],
    ['NaN', 'the literal string NaN'],
    ['Infinity', 'the literal string Infinity'],
  ])('rejects %s (%s)', (raw) => {
    expect(parseExPercent(raw)).toBeNull();
  });
});
