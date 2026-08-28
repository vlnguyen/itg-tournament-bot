import { afterEach, describe, expect, it } from 'vitest';
import { matchUrl, tournamentUrl, webUrl } from './web-url.js';

describe('webUrl / tournamentUrl / matchUrl', () => {
  const original = process.env['PUBLIC_BASE_URL'];
  afterEach(() => {
    if (original === undefined) delete process.env['PUBLIC_BASE_URL'];
    else process.env['PUBLIC_BASE_URL'] = original;
  });

  it('prefixes with PUBLIC_BASE_URL when set', () => {
    process.env['PUBLIC_BASE_URL'] = 'https://itg.example.com';
    expect(webUrl('/t/abc')).toBe('https://itg.example.com/t/abc');
    expect(tournamentUrl('abc')).toBe('https://itg.example.com/t/abc');
    expect(matchUrl('abc', 'm1')).toBe('https://itg.example.com/t/abc/matches/m1');
  });

  it('falls back to a bare relative path when unset', () => {
    delete process.env['PUBLIC_BASE_URL'];
    expect(webUrl('/t/abc')).toBe('/t/abc');
    expect(tournamentUrl('abc')).toBe('/t/abc');
    expect(matchUrl('abc', 'm1')).toBe('/t/abc/matches/m1');
  });
});
