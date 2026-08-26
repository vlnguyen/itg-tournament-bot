import { describe, expect, it } from 'vitest';
import { parseAdminDiscordIds } from './admin-service.js';

describe('parseAdminDiscordIds', () => {
  it('splits a comma-separated list', () => {
    expect(parseAdminDiscordIds('123,456,789')).toEqual(['123', '456', '789']);
  });

  it('trims whitespace around each id', () => {
    expect(parseAdminDiscordIds(' 123 , 456 ')).toEqual(['123', '456']);
  });

  it('drops blank entries from stray commas', () => {
    expect(parseAdminDiscordIds('123,,456,')).toEqual(['123', '456']);
  });

  it('returns an empty array for undefined or blank', () => {
    expect(parseAdminDiscordIds(undefined)).toEqual([]);
    expect(parseAdminDiscordIds('')).toEqual([]);
    expect(parseAdminDiscordIds('   ')).toEqual([]);
  });
});
