import { describe, expect, it, vi } from 'vitest';
import { TierService } from '../src/auth/tier.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';

const USER_ID = 'alice';

interface GuildFixture {
  id: string;
  name: string;
  toRoleId?: string | null;
  refereeRoleId?: string | null;
  adminRoleId?: string | null;
  memberRoleIds?: string[]; // undefined -> user isn't a member of this guild at all
  manageGuild?: boolean;
}

function fakeMember(roleIds: string[], manageGuild: boolean) {
  return {
    permissions: { has: () => manageGuild },
    roles: { cache: new Map(roleIds.map((r) => [r, r])) },
  };
}

function fakeGuild(fixture: GuildFixture) {
  const members = new Map(
    fixture.memberRoleIds !== undefined ? [[USER_ID, fakeMember(fixture.memberRoleIds, fixture.manageGuild ?? false)]] : [],
  );
  return {
    id: fixture.id,
    name: fixture.name,
    iconURL: () => `icon-${fixture.id}`,
    members: {
      cache: members,
      fetch: async () => {
        throw new Error('not a member');
      },
    },
  };
}

function fakeClient(fixtures: GuildFixture[]) {
  return {
    guilds: { cache: new Map(fixtures.map((f) => [f.id, fakeGuild(f)])) },
  };
}

function fakePrisma(fixtures: GuildFixture[]) {
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  return {
    guild: {
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => {
        const f = byId.get(id);
        if (!f) return null;
        return { toRoleId: f.toRoleId ?? null, refereeRoleId: f.refereeRoleId ?? null, adminRoleId: f.adminRoleId ?? null };
      }),
    },
  };
}

function service(fixtures: GuildFixture[]) {
  const prisma = fakePrisma(fixtures);
  const client = fakeClient(fixtures);
  return new TierService(prisma as unknown as PrismaService, client as never);
}

/**
 * `TierService.organizerOnlyGuildsFor` backs the homepage's "Servers You
 * TO" list — unlike `DiscordGuildsService.manageableGuildsFor`'s OAuth-based
 * approach, this can only ever answer for guilds already in the bot's own
 * gateway cache, since TO role membership isn't visible any other way.
 */
describe('TierService.organizerOnlyGuildsFor', () => {
  it('excludes a guild where the user already holds Manage Guild', async () => {
    const svc = service([
      { id: 'g-manager', name: 'Managed Server', toRoleId: 'to-role', memberRoleIds: ['to-role'], manageGuild: true },
    ]);
    expect(await svc.organizerOnlyGuildsFor(USER_ID)).toEqual([]);
  });

  it('excludes a guild where the user holds no Tournament Organizer role', async () => {
    const svc = service([
      { id: 'g-referee', name: 'Referee Only Server', toRoleId: 'to-role', refereeRoleId: 'ref-role', memberRoleIds: ['ref-role'] },
    ]);
    expect(await svc.organizerOnlyGuildsFor(USER_ID)).toEqual([]);
  });

  it("excludes a guild the bot isn't in, even if it were somehow configured", async () => {
    const svc = service([]);
    expect(await svc.organizerOnlyGuildsFor(USER_ID)).toEqual([]);
  });

  it('includes a Tournament Organizer guild the user does not manage', async () => {
    const svc = service([{ id: 'g-to', name: 'TO Server', toRoleId: 'to-role', memberRoleIds: ['to-role'], manageGuild: false }]);
    const result = await svc.organizerOnlyGuildsFor(USER_ID);
    expect(result).toEqual([{ id: 'g-to', name: 'TO Server', iconUrl: 'icon-g-to', botPresent: true, inviteUrl: null }]);
  });

  it('sorts multiple organizer-only guilds alphabetically by name', async () => {
    const svc = service([
      { id: 'g-zebra', name: 'Zebra TO Server', toRoleId: 'to-role', memberRoleIds: ['to-role'] },
      { id: 'g-alpha', name: 'Alpha TO Server', toRoleId: 'to-role', memberRoleIds: ['to-role'] },
    ]);
    const result = await svc.organizerOnlyGuildsFor(USER_ID);
    expect(result.map((g) => g.id)).toEqual(['g-alpha', 'g-zebra']);
  });
});
