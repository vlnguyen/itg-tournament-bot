import { createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { requireEnv } from './env.js';
import { parseCookies, SESSION_COOKIE_NAME, verifySessionCookie } from './session.js';

/** The signed-in Discord user id, or `null` when there's no valid session cookie. */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): string | null => {
  const req = ctx.switchToHttp().getRequest<Request>();
  const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
  return raw ? verifySessionCookie(raw, requireEnv('SESSION_SECRET')) : null;
});
