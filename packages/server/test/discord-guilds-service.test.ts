import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordGuildsService } from '../src/auth/discord-guilds.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';

const NOW = Date.parse('2026-08-27T12:00:00.000Z');

function fakePrisma(user: Record<string, unknown> | null) {
  return {
    user: {
      findUnique: vi.fn().mockResolvedValue(user),
      update: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function fakeClient(presentGuildIds: string[]) {
  return {
    guilds: {
      cache: new Map(presentGuildIds.map((id) => [id, { name: `present-${id}`, iconURL: () => `icon-${id}` }])),
    },
  };
}

/**
 * `DiscordGuildsService.manageableGuildsFor` backs `GET /api/guilds` — the
 * homepage's server list. Unlike the bot's own gateway cache (`TierService.
 * hasManageGuild`), this must surface a server the bot has never joined at
 * all, since that's the whole reason it goes through Discord's `guilds`
 * OAuth2 scope instead.
 */
describe('DiscordGuildsService.manageableGuildsFor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    process.env['DISCORD_CLIENT_ID'] = 'test-client-id';
    process.env['DISCORD_CLIENT_SECRET'] = 'test-client-secret';
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const validUser = {
    discordAccessToken: 'access-token',
    discordRefreshToken: 'refresh-token',
    discordTokenExpiresAt: new Date(NOW + 60 * 60 * 1000),
  };

  it('returns [] for a user who never granted the guilds scope', async () => {
    const prisma = fakePrisma(null);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const service = new DiscordGuildsService(prisma as unknown as PrismaService, fakeClient([]) as never);

    expect(await service.manageableGuildsFor('alice')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps only guilds the user owns or holds Manage Guild in', async () => {
    const prisma = fakePrisma(validUser);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { id: 'g-manage', name: 'Manage Guild Server', icon: null, owner: false, permissions: String(0x20) },
        { id: 'g-owner', name: 'Owned Server', icon: null, owner: true, permissions: '0' },
        { id: 'g-member', name: 'Member Only Server', icon: null, owner: false, permissions: String(0x800) },
      ],
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = new DiscordGuildsService(prisma as unknown as PrismaService, fakeClient([]) as never);

    const result = await service.manageableGuildsFor('alice');
    expect(result.map((g) => g.id).sort()).toEqual(['g-manage', 'g-owner']);
  });

  it('sorts bot-present servers first, alphabetically within each group', async () => {
    const prisma = fakePrisma(validUser);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { id: 'g-zebra-absent', name: 'Zebra (no bot)', icon: null, owner: true, permissions: '0' },
          { id: 'g-alpha-present', name: 'Alpha (bot)', icon: null, owner: true, permissions: '0' },
          { id: 'g-beta-absent', name: 'Beta (no bot)', icon: null, owner: true, permissions: '0' },
          { id: 'g-yankee-present', name: 'Yankee (bot)', icon: null, owner: true, permissions: '0' },
        ],
      }),
    );
    const service = new DiscordGuildsService(
      prisma as unknown as PrismaService,
      fakeClient(['g-alpha-present', 'g-yankee-present']) as never,
    );

    const result = await service.manageableGuildsFor('alice');
    expect(result.map((g) => g.id)).toEqual(['g-alpha-present', 'g-yankee-present', 'g-beta-absent', 'g-zebra-absent']);
  });

  it('marks a guild the bot is already in as botPresent with no inviteUrl', async () => {
    const prisma = fakePrisma(validUser);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ id: 'g-present', name: 'stale-name', icon: null, owner: true, permissions: '0' }],
      }),
    );
    const service = new DiscordGuildsService(prisma as unknown as PrismaService, fakeClient(['g-present']) as never);

    const [guild] = await service.manageableGuildsFor('alice');
    expect(guild).toMatchObject({ id: 'g-present', name: 'present-g-present', botPresent: true, inviteUrl: null });
  });

  it('gives a guild without the bot an inviteUrl and no botPresent', async () => {
    const prisma = fakePrisma(validUser);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ id: 'g-absent', name: 'Absent Server', icon: null, owner: true, permissions: '0' }],
      }),
    );
    const service = new DiscordGuildsService(prisma as unknown as PrismaService, fakeClient([]) as never);

    const [guild] = await service.manageableGuildsFor('alice');
    expect(guild?.botPresent).toBe(false);
    expect(guild?.inviteUrl).toContain('client_id=test-client-id');
    expect(guild?.inviteUrl).toContain('guild_id=g-absent');
    expect(guild?.inviteUrl).toContain('scope=bot+applications.commands');
  });

  it('refreshes an expired token before calling Discord, and persists the new pair', async () => {
    const expiredUser = {
      discordAccessToken: 'old-access',
      discordRefreshToken: 'old-refresh',
      discordTokenExpiresAt: new Date(NOW - 1000),
    };
    const prisma = fakePrisma(expiredUser);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => [] });
    vi.stubGlobal('fetch', fetchMock);
    const service = new DiscordGuildsService(prisma as unknown as PrismaService, fakeClient([]) as never);

    await service.manageableGuildsFor('alice');

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://discord.com/api/oauth2/token', expect.objectContaining({ method: 'POST' }));
    const [, guildsCallOpts] = fetchMock.mock.calls[1]!;
    expect((guildsCallOpts as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer new-access');
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { discordUserId: 'alice' },
      data: {
        discordAccessToken: 'new-access',
        discordRefreshToken: 'new-refresh',
        discordTokenExpiresAt: new Date(NOW + 3600 * 1000),
      },
    });
  });

  it('returns [] when Discord rejects the refresh', async () => {
    const expiredUser = {
      discordAccessToken: 'old-access',
      discordRefreshToken: 'old-refresh',
      discordTokenExpiresAt: new Date(NOW - 1000),
    };
    const prisma = fakePrisma(expiredUser);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    const service = new DiscordGuildsService(prisma as unknown as PrismaService, fakeClient([]) as never);

    expect(await service.manageableGuildsFor('alice')).toEqual([]);
  });

  it('returns [] when the /users/@me/guilds call itself fails', async () => {
    const prisma = fakePrisma(validUser);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const service = new DiscordGuildsService(prisma as unknown as PrismaService, fakeClient([]) as never);

    expect(await service.manageableGuildsFor('alice')).toEqual([]);
  });
});
