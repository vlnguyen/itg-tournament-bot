import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * "Sessions are a signed cookie carrying the Discord user ID, and nothing
 * else. There is no session table." See DESIGN.md, "Authentication and
 * Authorization". Rotating `SESSION_SECRET` is the global logout — nothing
 * about a user's authority is stored in the cookie, only their identity.
 */
export const SESSION_COOKIE_NAME = 'itg_session';
export const OAUTH_STATE_COOKIE_NAME = 'itg_oauth_state';

function sign(discordUserId: string, secret: string): string {
  return createHmac('sha256', secret).update(discordUserId).digest('base64url');
}

/** `discordUserId.signature` — a Discord snowflake and a base64url signature never contain '.'. */
export function createSessionCookie(discordUserId: string, secret: string): string {
  return `${discordUserId}.${sign(discordUserId, secret)}`;
}

export function verifySessionCookie(cookieValue: string, secret: string): string | null {
  const dot = cookieValue.lastIndexOf('.');
  if (dot === -1) return null;
  const discordUserId = cookieValue.slice(0, dot);
  const signature = cookieValue.slice(dot + 1);
  if (!discordUserId || !signature) return null;

  const expected = Buffer.from(sign(discordUserId, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return discordUserId;
}

/** Minimal `Cookie` header parser — reading incoming cookies needs no middleware, only setting them does. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!key) continue;
    try {
      result[key] = decodeURIComponent(value);
    } catch {
      result[key] = value;
    }
  }
  return result;
}
