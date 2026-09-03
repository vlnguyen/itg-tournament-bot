import { describe, expect, it } from 'vitest';
import { canEditMatchFormat, canEditSongPool, canImportPack, playstylePrefix, type TournamentState } from './enums.js';

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

describe('canEditSongPool', () => {
  it('allows editing labels/deleting a tab in every state before the tournament starts', () => {
    const before: TournamentState[] = ['DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'CHECKIN_OPEN', 'CHECKIN_CLOSED'];
    for (const state of before) expect(canEditSongPool(state)).toBe(true);
  });

  it('blocks editing labels/deleting a tab once the tournament has started or ended', () => {
    const after: TournamentState[] = ['RUNNING', 'COMPLETE', 'CANCELLED'];
    for (const state of after) expect(canEditSongPool(state)).toBe(false);
  });
});

describe('canEditMatchFormat', () => {
  it('allows setting a match format override in every state before the tournament starts', () => {
    const before: TournamentState[] = ['DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'CHECKIN_OPEN', 'CHECKIN_CLOSED'];
    for (const state of before) expect(canEditMatchFormat(state)).toBe(true);
  });

  it('blocks it once the tournament has started or ended, even for a still-PENDING future match', () => {
    const after: TournamentState[] = ['RUNNING', 'COMPLETE', 'CANCELLED'];
    for (const state of after) expect(canEditMatchFormat(state)).toBe(false);
  });
});
