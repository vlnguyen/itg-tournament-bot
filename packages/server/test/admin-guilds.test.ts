import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AdminController } from '../src/api/admin.controller.js';
import { DISCORD_CLIENT } from '../src/discord/discord.tokens.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { isReachable, prisma } from './support.js';

const tournament = (guildId: string, name: string, state: string) =>
  prisma.tournament.create({
    data: { guildId, name, defaultFormatKey: 'bo5-protect-veto', config: {}, state: state as never },
  });

/**
 * `GET /api/admin/guilds` — the Bot Administrator's read-only server list.
 * `isBotAdmin` is deployment-scoped (the real `Admin` table, not a mocked
 * tier check like every other controller's suite here), and the fake
 * Discord client's `guilds.cache` stands in for "every server the bot is
 * in" — the one thing this endpoint reads that Postgres alone can't answer,
 * since a guild can be a member with no `Guild` row at all.
 */
describe.skipIf(!(await isReachable()))('GET /api/admin/guilds', () => {
  let controller: AdminController;
  const guildIds: string[] = [];
  const adminIds: string[] = [];

  const fakeClient = { guilds: { cache: new Map<string, { id: string; name: string }>() } };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: DISCORD_CLIENT, useValue: fakeClient },
      ],
    }).compile();
    controller = moduleRef.get(AdminController);
  });

  afterEach(async () => {
    fakeClient.guilds.cache.clear();
    for (const id of guildIds.splice(0)) await prisma.guild.delete({ where: { id } }).catch(() => undefined);
    for (const id of adminIds.splice(0)) await prisma.admin.delete({ where: { discordUserId: id } }).catch(() => undefined);
  });
  afterAll(async () => {
    for (const id of adminIds.splice(0)) await prisma.admin.delete({ where: { discordUserId: id } }).catch(() => undefined);
  });

  async function makeAdmin(): Promise<string> {
    const id = `bot-admin-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await prisma.admin.create({ data: { discordUserId: id } });
    adminIds.push(id);
    return id;
  }

  async function makeGuild(name: string): Promise<string> {
    const id = `admin-guilds-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await prisma.guild.create({ data: { id } });
    guildIds.push(id);
    fakeClient.guilds.cache.set(id, { id, name });
    return id;
  }

  it('rejects a signed-out request', async () => {
    await expect(controller.getGuilds(null)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a signed-in user who is not a bot administrator', async () => {
    await expect(controller.getGuilds('someone')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lists every guild the bot is in, sorted by name, DRAFT included', async () => {
    const admin = await makeAdmin();
    const bId = await makeGuild('Bravo Server');
    const aId = await makeGuild('Alpha Server');
    await tournament(aId, 'draft', 'DRAFT');
    await tournament(bId, 'done', 'COMPLETE');

    const body = await controller.getGuilds(admin);
    expect(body.map((g) => g.guildName)).toEqual(['Alpha Server', 'Bravo Server']);
    expect(body.find((g) => g.guildId === aId)?.tournaments.map((t) => t.state)).toEqual(['DRAFT']);
    expect(body.find((g) => g.guildId === bId)?.tournaments.map((t) => t.state)).toEqual(['COMPLETE']);
  });

  it('includes a guild with no tournaments at all, as an empty list', async () => {
    const admin = await makeAdmin();
    await makeGuild('Empty Server');
    const body = await controller.getGuilds(admin);
    expect(body).toHaveLength(1);
    expect(body[0]!.tournaments).toEqual([]);
  });
});
