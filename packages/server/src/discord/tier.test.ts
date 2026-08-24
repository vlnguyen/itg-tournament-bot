import { describe, expect, it } from 'vitest';
import { hasTier, Tier, tierOf } from './tier.js';

const config = { refereeRoleId: 'ref-role', toRoleId: 'to-role', adminRoleId: 'admin-role' };

describe('tierOf', () => {
  it('is NONE for a member with none of the configured roles', () => {
    expect(tierOf(['some-other-role'], config)).toBe(Tier.NONE);
    expect(tierOf([], config)).toBe(Tier.NONE);
  });

  it('resolves each single role to its tier', () => {
    expect(tierOf(['ref-role'], config)).toBe(Tier.REFEREE);
    expect(tierOf(['to-role'], config)).toBe(Tier.TOURNAMENT_ORGANIZER);
    expect(tierOf(['admin-role'], config)).toBe(Tier.SERVER_ADMINISTRATOR);
  });

  it('returns the highest tier when a member holds more than one', () => {
    expect(tierOf(['ref-role', 'admin-role'], config)).toBe(Tier.SERVER_ADMINISTRATOR);
    expect(tierOf(['ref-role', 'to-role'], config)).toBe(Tier.TOURNAMENT_ORGANIZER);
  });

  it('collapses cleanly when a server points every slot at one role', () => {
    const collapsed = { refereeRoleId: 'staff', toRoleId: 'staff', adminRoleId: 'staff' };
    expect(tierOf(['staff'], collapsed)).toBe(Tier.SERVER_ADMINISTRATOR);
  });

  it('treats an unconfigured slot (null) as never matching', () => {
    const partial = { refereeRoleId: 'ref-role', toRoleId: null, adminRoleId: null };
    expect(tierOf(['ref-role'], partial)).toBe(Tier.REFEREE);
    expect(tierOf([], partial)).toBe(Tier.NONE);
  });
});

describe('hasTier', () => {
  it('is a >= comparison against the required tier', () => {
    expect(hasTier(['admin-role'], config, Tier.REFEREE)).toBe(true);
    expect(hasTier(['ref-role'], config, Tier.TOURNAMENT_ORGANIZER)).toBe(false);
    expect(hasTier(['to-role'], config, Tier.TOURNAMENT_ORGANIZER)).toBe(true);
  });
});
