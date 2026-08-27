import { Test } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GuildsController } from '../src/api/guilds.controller.js';
import { TierService } from '../src/auth/tier.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { isReachable, prisma } from './support.js';

/**
 * `GET /api/guilds/:guildId/first-run` — DESIGN.md's first-run wizard. The
 * whole point is that a `DRAFT` tournament must never leak to a viewer who
 * can't act on it, the same rule `findPublicCurrentTournament` and
 * `getTournamentHistory` enforce for `/g/:guildId`'s own overview — so most
 * of this suite is about `canManage` gating that leak, not about the config
 * checklist itself (already covered by `missingGuildConfig`'s own callers).
 */
describe.skipIf(!(await isReachable()))('GET /api/guilds/:guildId/first-run', () => {
  let guildId: string;
  let controller: GuildsController;
  let hasManageGuildResult: boolean;
  let hasTierResult: boolean;

  beforeAll(async () => {
    guildId = `first-run-${Date.now()}`;
    await prisma.guild.create({ data: { id: guildId, matchesChannelId: 'matches-chan' } });

    const moduleRef = await Test.createTestingModule({
      controllers: [GuildsController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        {
          provide: TierService,
          useValue: {
            hasManageGuild: async () => hasManageGuildResult,
            hasTier: async () => hasTierResult,
          },
        },
      ],
    }).compile();
    controller = moduleRef.get(GuildsController);
  });
  afterEach(async () => {
    await prisma.tournament.deleteMany({ where: { guildId } });
  });
  afterAll(async () => {
    await prisma.guild.delete({ where: { id: guildId } }).catch(() => undefined);
  });

  it('reveals nothing to a signed-out viewer', async () => {
    hasManageGuildResult = true; // irrelevant — CurrentUser is null below
    hasTierResult = true;
    const body = await controller.getFirstRun(guildId, null);
    expect(body).toEqual({ canManage: false, missingConfig: [], draftTournamentId: null, draftTournamentName: null });
  });

  it('reveals nothing to a signed-in viewer with neither Manage Guild nor Tournament Organizer tier here', async () => {
    hasManageGuildResult = false;
    hasTierResult = false;
    const body = await controller.getFirstRun(guildId, 'someone');
    expect(body).toEqual({ canManage: false, missingConfig: [], draftTournamentId: null, draftTournamentName: null });
  });

  it('reports the missing-config checklist for a Manage Guild holder, even with no draft tournament', async () => {
    hasManageGuildResult = true;
    hasTierResult = false;
    const body = await controller.getFirstRun(guildId, 'owner');
    expect(body.canManage).toBe(true);
    expect(body.draftTournamentId).toBeNull();
    expect(body.missingConfig).toContain('organizer alert channel');
    expect(body.missingConfig).not.toContain('matches channel');
  });

  it("surfaces a DRAFT tournament's id to a Tournament Organizer", async () => {
    hasManageGuildResult = false;
    hasTierResult = true;
    const draft = await prisma.tournament.create({
      data: { guildId, name: 'draft', defaultFormatKey: 'bo5-protect-veto', config: {}, state: 'DRAFT' },
    });
    const body = await controller.getFirstRun(guildId, 'a-to');
    expect(body.canManage).toBe(true);
    expect(body.draftTournamentId).toBe(draft.id);
    expect(body.draftTournamentName).toBe('draft');
  });

  it('never surfaces a non-DRAFT tournament as the draft', async () => {
    hasManageGuildResult = false;
    hasTierResult = true;
    await prisma.tournament.create({
      data: { guildId, name: 'running', defaultFormatKey: 'bo5-protect-veto', config: {}, state: 'RUNNING' },
    });
    const body = await controller.getFirstRun(guildId, 'a-to');
    expect(body.draftTournamentId).toBeNull();
  });
});
