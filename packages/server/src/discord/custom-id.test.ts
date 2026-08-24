import { describe, expect, it } from 'vitest';
import { decodeCustomId, encodeCustomId } from './custom-id.js';

describe('encodeCustomId / decodeCustomId', () => {
  it('round-trips a button id with an arg', () => {
    const id = { matchId: 'cuid123456789012345678901', action: 'WINNER', arg: 'entrant42' };
    expect(decodeCustomId(encodeCustomId(id))).toEqual(id);
  });

  it('round-trips a select-menu id with no arg', () => {
    const id = { matchId: 'cuid123456789012345678901', action: 'PROTECT_VETO' };
    expect(decodeCustomId(encodeCustomId(id))).toEqual(id);
  });

  it('produces the literal v1:<matchId>:<action>:<arg> shape', () => {
    expect(encodeCustomId({ matchId: 'm1', action: 'TIEBREAK', arg: '2' })).toBe('v1:m1:TIEBREAK:2');
    expect(encodeCustomId({ matchId: 'm1', action: 'CONFIRM' })).toBe('v1:m1:CONFIRM');
  });

  it('throws rather than silently truncating past the 100-character limit', () => {
    expect(() =>
      encodeCustomId({ matchId: 'm'.repeat(60), action: 'WINNER', arg: 'x'.repeat(40) }),
    ).toThrow(RangeError);
  });

  it.each([
    ['empty string', ''],
    ['wrong version', 'v2:m1:PROTECT'],
    ['too few parts', 'v1:m1'],
    ['too many parts', 'v1:m1:PROTECT:0:extra'],
    ['missing matchId', 'v1::PROTECT'],
    ['missing action', 'v1:m1:'],
    ['garbage', 'not-a-custom-id-at-all'],
  ])('rejects %s', (_label, raw) => {
    expect(decodeCustomId(raw)).toBeNull();
  });

  it('never accepts a decoded id whose re-encoding would differ', () => {
    // Guards against the codec drifting — a decode result must be a faithful
    // parse, not a best-effort guess.
    const raw = 'v1:m1:PROTECT:3';
    const decoded = decodeCustomId(raw)!;
    expect(encodeCustomId(decoded)).toBe(raw);
  });
});
