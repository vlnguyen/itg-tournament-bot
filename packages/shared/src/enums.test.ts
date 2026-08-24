import { describe, expect, it } from 'vitest';
import { playstylePrefix } from './enums.js';

describe('playstylePrefix', () => {
  it('produces the two-letter codes the requirements name', () => {
    expect(playstylePrefix('SINGLE', 'EXPERT')).toBe('SX');
    expect(playstylePrefix('DOUBLE', 'EXPERT')).toBe('DX');
    expect(playstylePrefix('SINGLE', 'HARD')).toBe('SH');
    expect(playstylePrefix('DOUBLE', 'HARD')).toBe('DH');
    expect(playstylePrefix('SINGLE', 'NOVICE')).toBe('SN');
    expect(playstylePrefix('DOUBLE', 'MEDIUM')).toBe('DM');
    expect(playstylePrefix('SINGLE', 'EASY')).toBe('SE');
  });
});
