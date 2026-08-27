import { randomBytes } from 'node:crypto';
import { Controller, Get, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PrismaService } from '../prisma/prisma.service.js';
import { requireEnv } from './env.js';
import {
  createSessionCookie,
  OAUTH_STATE_COOKIE_NAME,
  parseCookies,
  SESSION_COOKIE_NAME,
  verifySessionCookie,
} from './session.js';

const DISCORD_AUTHORIZE_URL = 'https://discord.com/api/oauth2/authorize';
const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token';
const DISCORD_API_BASE = 'https://discord.com/api/v10';

function isSecureBaseUrl(): boolean {
  return new URL(requireEnv('PUBLIC_BASE_URL')).protocol === 'https:';
}

interface DiscordTokenResponse {
  access_token: string;
}

interface DiscordUserResponse {
  id: string;
  username: string;
  /** The new-username-system display name — nullable when someone has never set one. */
  global_name: string | null;
  avatar: string | null;
}

/**
 * Discord OAuth2, `identify` scope only, terminating in the signed session
 * cookie described in DESIGN.md, "Authentication and Authorization" — no
 * session table, no stored access token. The access token is used once, to
 * ask Discord who just authorized, and then discarded.
 */
@Controller('api/auth')
export class AuthController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get('login')
  login(@Res() res: Response): void {
    const clientId = requireEnv('DISCORD_CLIENT_ID');
    const redirectUri = requireEnv('DISCORD_OAUTH_REDIRECT_URL');
    const state = randomBytes(16).toString('base64url');

    res.cookie(OAUTH_STATE_COOKIE_NAME, state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isSecureBaseUrl(),
      maxAge: 5 * 60 * 1000,
      path: '/',
    });

    const url = new URL(DISCORD_AUTHORIZE_URL);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'identify');
    url.searchParams.set('state', state);
    res.redirect(url.toString());
  }

  @Get('callback')
  async callback(@Req() req: Request, @Res() res: Response): Promise<void> {
    const code = typeof req.query['code'] === 'string' ? req.query['code'] : undefined;
    const state = typeof req.query['state'] === 'string' ? req.query['state'] : undefined;
    const expectedState = parseCookies(req.headers.cookie)[OAUTH_STATE_COOKIE_NAME];
    res.clearCookie(OAUTH_STATE_COOKIE_NAME, { path: '/' });

    if (!code || !state || !expectedState || state !== expectedState) {
      res.status(400).send('Invalid or expired OAuth state. Try signing in again.');
      return;
    }

    const clientId = requireEnv('DISCORD_CLIENT_ID');
    const clientSecret = requireEnv('DISCORD_CLIENT_SECRET');
    const redirectUri = requireEnv('DISCORD_OAUTH_REDIRECT_URL');

    const tokenRes = await fetch(DISCORD_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    if (!tokenRes.ok) {
      res.status(502).send('Discord rejected the OAuth exchange.');
      return;
    }
    const token = (await tokenRes.json()) as DiscordTokenResponse;

    const userRes = await fetch(`${DISCORD_API_BASE}/users/@me`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!userRes.ok) {
      res.status(502).send('Discord rejected the identify request.');
      return;
    }
    const user = (await userRes.json()) as DiscordUserResponse;

    // The only place `User` (DESIGN.md's "current name" cache for player
    // pages) gets written — there's no broader Discord member-sync yet, so
    // this stays accurate only for people who have actually signed in.
    // Player pages fall back to the tournament-snapshot name otherwise.
    await this.prisma.user.upsert({
      where: { discordUserId: user.id },
      create: {
        discordUserId: user.id,
        displayName: user.global_name ?? user.username,
        avatarHash: user.avatar,
        lastSignInAt: new Date(),
      },
      update: {
        displayName: user.global_name ?? user.username,
        avatarHash: user.avatar,
        lastSignInAt: new Date(),
      },
    });

    const secret = requireEnv('SESSION_SECRET');
    res.cookie(SESSION_COOKIE_NAME, createSessionCookie(user.id, secret), {
      httpOnly: true,
      sameSite: 'lax',
      secure: isSecureBaseUrl(),
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: '/',
    });
    res.redirect(requireEnv('PUBLIC_BASE_URL'));
  }

  @Post('logout')
  logout(@Res() res: Response): void {
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    res.status(204).send();
  }

  @Get('me')
  me(@Req() req: Request, @Res() res: Response): void {
    const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
    // No cookie means "not signed in" regardless of whether OAuth is even
    // configured yet — only verifying an actual cookie needs the secret.
    const discordUserId = raw ? verifySessionCookie(raw, requireEnv('SESSION_SECRET')) : null;
    res.json({ discordUserId });
  }
}
