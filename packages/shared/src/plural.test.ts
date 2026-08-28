import { describe, expect, it } from 'vitest';
import { plural } from './plural.js';

describe('plural', () => {
  it('uses the singular form for exactly one', () => {
    expect(plural(1, 'match', 'matches')).toBe('1 match');
    expect(plural(1, 'guild', 'guilds')).toBe('1 guild');
  });

  it('uses the given plural form for anything else, including zero', () => {
    expect(plural(0, 'guild', 'guilds')).toBe('0 guilds');
    expect(plural(2, 'match', 'matches')).toBe('2 matches');
    expect(plural(5, 'entry', 'entries')).toBe('5 entries');
  });
});
