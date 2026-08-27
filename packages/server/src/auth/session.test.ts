import { describe, expect, it } from 'vitest';
import { createSessionCookie, parseCookies, verifySessionCookie } from './session.js';

describe('session cookie signing', () => {
  it('round-trips the discord user id', () => {
    const cookie = createSessionCookie('123456789', 'secret-a');
    expect(verifySessionCookie(cookie, 'secret-a')).toBe('123456789');
  });

  it('rejects a value signed with a different secret', () => {
    const cookie = createSessionCookie('123456789', 'secret-a');
    expect(verifySessionCookie(cookie, 'secret-b')).toBeNull();
  });

  it('rejects a tampered user id with the original signature', () => {
    const cookie = createSessionCookie('123456789', 'secret-a');
    const [, signature] = cookie.split('.');
    expect(verifySessionCookie(`999999999.${signature}`, 'secret-a')).toBeNull();
  });

  it('rejects a value with no signature', () => {
    expect(verifySessionCookie('123456789', 'secret-a')).toBeNull();
  });

  it('rejects an empty user id or empty signature', () => {
    expect(verifySessionCookie('.abc', 'secret-a')).toBeNull();
    expect(verifySessionCookie('123456789.', 'secret-a')).toBeNull();
  });

  it('rejects garbage', () => {
    expect(verifySessionCookie('', 'secret-a')).toBeNull();
    expect(verifySessionCookie('not-a-real-cookie', 'secret-a')).toBeNull();
  });
});

describe('parseCookies', () => {
  it('parses a typical Cookie header', () => {
    expect(parseCookies('a=1; b=2; c=3')).toEqual({ a: '1', b: '2', c: '3' });
  });

  it('returns an empty object for undefined or empty header', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('')).toEqual({});
  });

  it('decodes percent-encoded values', () => {
    expect(parseCookies('itg_session=abc%2Edef')).toEqual({ itg_session: 'abc.def' });
  });

  it('skips malformed segments without a value', () => {
    expect(parseCookies('a=1; nokeyvalue; b=2')).toEqual({ a: '1', b: '2' });
  });

  it('falls back to the raw value when percent-decoding fails', () => {
    expect(parseCookies('a=%')).toEqual({ a: '%' });
  });
});
