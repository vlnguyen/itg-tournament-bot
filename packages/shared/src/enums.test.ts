import { describe, expect, it } from 'vitest';
import { canImportPack, playstylePrefix, type TournamentState } from './enums.js';

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

describe('canImportPack', () => {
  it('allows import in every state before the tournament starts', () => {
    const before: TournamentState[] = ['DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'CHECKIN_OPEN', 'CHECKIN_CLOSED'];
    for (const state of before) expect(canImportPack(state)).toBe(true);
  });

  it('blocks import once the tournament has started or ended', () => {
    const after: TournamentState[] = ['RUNNING', 'COMPLETE', 'CANCELLED'];
    for (const state of after) expect(canImportPack(state)).toBe(false);
  });
});
