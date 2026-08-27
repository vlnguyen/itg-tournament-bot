import { Test } from '@nestjs/testing';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GuildsController } from '../src/api/guilds.controller.js';
import { DiscordGuildsService } from '../src/auth/discord-guilds.service.js';
import { TierService } from '../src/auth/tier.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { findPublicCurrentTournament, getTournamentHistory } from '../src/services/tournament-service.js';
import { isReachable, prisma } from './support.js';

const tournament = (guildId: string, name: string, state: string) =>
  prisma.tournament.create({
    data: { guildId, name, defaultFormatKey: 'bo5-protect-veto', config: {}, state: state as never },
  });

/** Backs `/pack` — unlike the guild overview's history, this never falls back to a past tournament: "a link to a past pack comes from that tournament's archived page, which is permanent anyway." */
describe.skipIf(!(await isReachable()))('findPublicCurrentTournament', () => {
  const guildIds: string[] = [];
  afterEach(async () => {
    for (const id of guildIds.splice(0)) await prisma.guild.delete({ where: { id } }).catch(() => undefined);
  });

  async function makeGuild(): Promise<string> {
    const id = `pack-current-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await prisma.guild.create({ data: { id } });
    guildIds.push(id);
    return id;
  }

  it('returns null for a DRAFT tournament — not yet announced', async () => {
    const guildId = await makeGuild();
    await tournament(guildId, 'draft', 'DRAFT');
    expect(await findPublicCurrentTournament(prisma, guildId)).toBeNull();
  });

  it('returns null once the tournament is COMPLETE, even though it just finished', async () => {
    const guildId = await makeGuild();
    await tournament(guildId, 'done', 'COMPLETE');
    expect(await findPublicCurrentTournament(prisma, guildId)).toBeNull();
  });

  it('returns a REGISTRATION_OPEN tournament', async () => {
    const guildId = await makeGuild();
    const t = await tournament(guildId, 'open', 'REGISTRATION_OPEN');
    expect((await findPublicCurrentTournament(prisma, guildId))?.id).toBe(t.id);
  });
});

/** Backs the `/g/:guildId` page's history section — `DRAFT` and anything still active are excluded, newest first. */
describe.skipIf(!(await isReachable()))('getTournamentHistory', () => {
  const guildIds: string[] = [];
  afterEach(async () => {
    for (const id of guildIds.splice(0)) await prisma.guild.delete({ where: { id } }).catch(() => undefined);
  });

  async function makeGuild(): Promise<string> {
    const id = `history-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await prisma.guild.create({ data: { id } });
    guildIds.push(id);
    return id;
  }

  // One non-terminal tournament per guild at a time is a real DB constraint
  // (`one_active_tournament_per_guild`), so `RUNNING` and `DRAFT` can't
  // coexist here — each gets its own guild.
  it('is empty for a guild whose only tournament is still running', async () => {
    const guildId = await makeGuild();
    await tournament(guildId, 'running', 'RUNNING');
    expect(await getTournamentHistory(prisma, guildId)).toEqual([]);
  });

  it('is empty for a guild whose only tournament is a DRAFT', async () => {
    const guildId = await makeGuild();
    await tournament(guildId, 'draft', 'DRAFT');
    expect(await getTournamentHistory(prisma, guildId)).toEqual([]);
  });

  it('includes COMPLETE and CANCELLED tournaments, newest first', async () => {
    const guildId = await makeGuild();
    const older = await tournament(guildId, 'older', 'COMPLETE');
    const newer = await tournament(guildId, 'newer', 'CANCELLED');
    const history = await getTournamentHistory(prisma, guildId);
    expect(history.map((t) => t.id)).toEqual([newer.id, older.id]);
  });
});

/**
 * `GET /api/guilds/:guildId/overview` — the `/g/:guildId` page itself.
 * Public, unauthenticated: no tier gating, unlike `/first-run`.
 */
describe.skipIf(!(await isReachable()))('GET /api/guilds/:guildId/overview', () => {
  let controller: GuildsController;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [GuildsController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: TierService, useValue: {} },
        { provide: DiscordGuildsService, useValue: {} },
      ],
    }).compile();
    controller = moduleRef.get(GuildsController);
  });

  const guildIds: string[] = [];
  afterEach(async () => {
    for (const id of guildIds.splice(0)) await prisma.guild.delete({ where: { id } }).catch(() => undefined);
  });

  async function makeGuild(): Promise<string> {
    const id = `overview-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await prisma.guild.create({ data: { id } });
    guildIds.push(id);
    return id;
  }

  it('returns an empty overview for a guild that has never run a tournament', async () => {
    const guildId = await makeGuild();
    expect(await controller.getOverview(guildId)).toEqual({ activeTournament: null, history: [] });
  });

  it('returns an empty overview for an unknown guild id — no 404, nothing to distinguish', async () => {
    expect(await controller.getOverview('no-such-guild')).toEqual({ activeTournament: null, history: [] });
  });

  it('reports a running tournament as active', async () => {
    const guildId = await makeGuild();
    const running = await tournament(guildId, 'running', 'RUNNING');
    const body = await controller.getOverview(guildId);
    expect(body.activeTournament?.id).toBe(running.id);
    expect(body.history).toEqual([]);
  });

  it('never leaks a DRAFT tournament as active or in history', async () => {
    const guildId = await makeGuild();
    await tournament(guildId, 'draft', 'DRAFT');
    const body = await controller.getOverview(guildId);
    expect(body).toEqual({ activeTournament: null, history: [] });
  });

  it('reports history alongside a null active tournament once everything has finished', async () => {
    const guildId = await makeGuild();
    const done = await tournament(guildId, 'done', 'COMPLETE');
    const body = await controller.getOverview(guildId);
    expect(body.activeTournament).toBeNull();
    expect(body.history).toEqual([{ id: done.id, name: 'done', state: 'COMPLETE', createdAt: done.createdAt.toISOString() }]);
  });
});

/** `POST /api/guilds/:guildId/tournaments` — the web equivalent of `/tournament create`. */
describe.skipIf(!(await isReachable()))('POST /api/guilds/:guildId/tournaments', () => {
  let controller: GuildsController;
  let hasTierResult: boolean;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [GuildsController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: TierService, useValue: { hasTier: async () => hasTierResult } },
        { provide: DiscordGuildsService, useValue: {} },
      ],
    }).compile();
    controller = moduleRef.get(GuildsController);
  });

  const guildIds: string[] = [];
  afterEach(async () => {
    for (const id of guildIds.splice(0)) await prisma.guild.delete({ where: { id } }).catch(() => undefined);
  });

  async function makeGuild(): Promise<string> {
    const id = `create-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await prisma.guild.create({ data: { id } });
    guildIds.push(id);
    return id;
  }

  it('rejects a signed-out request', async () => {
    hasTierResult = true;
    const guildId = await makeGuild();
    await expect(controller.createTournament(guildId, { name: 'Storm' }, null)).rejects.toThrow();
  });

  it('rejects a signed-in user below Tournament Organizer tier', async () => {
    hasTierResult = false;
    const guildId = await makeGuild();
    await expect(controller.createTournament(guildId, { name: 'Storm' }, 'someone')).rejects.toThrow();
  });

  it('rejects a blank name', async () => {
    hasTierResult = true;
    const guildId = await makeGuild();
    await expect(controller.createTournament(guildId, { name: '' }, 'a-to')).rejects.toThrow();
  });

  it('creates a DRAFT tournament and returns its id', async () => {
    hasTierResult = true;
    const guildId = await makeGuild();
    const { tournamentId } = await controller.createTournament(guildId, { name: 'Storm 2027' }, 'a-to');
    const t = await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } });
    expect(t.name).toBe('Storm 2027');
    expect(t.state).toBe('DRAFT');
  });

  it('refuses a second tournament while one is already held, naming what it holds', async () => {
    hasTierResult = true;
    const guildId = await makeGuild();
    await controller.createTournament(guildId, { name: 'First' }, 'a-to');
    await expect(controller.createTournament(guildId, { name: 'Second' }, 'a-to')).rejects.toThrow(/First/);
  });
});
