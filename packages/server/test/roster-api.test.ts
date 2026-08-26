import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RosterController } from '../src/api/roster.controller.js';
import { TierService } from '../src/auth/tier.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { REALTIME_PORT } from '../src/realtime/realtime.tokens.js';
import { rosterAdd, rosterCheckin } from '../src/services/roster-service.js';
import { closeRegistration, createTournament, openCheckin, openRegistration } from '../src/services/tournament-service.js';
import { isReachable, prisma } from './support.js';

const TO = 'to-user';

describe.skipIf(!(await isReachable()))('GET/POST /api/tournaments/:id/roster and /seeding', () => {
  let guildId: string;
  let tournamentId: string;
  let controller: RosterController;
  let hasTierResult: boolean;
  const rosterChangedCalls: string[] = [];

  beforeAll(async () => {
    guildId = `api-roster-${Date.now()}`;
    await prisma.guild.create({
      data: {
        id: guildId,
        matchesChannelId: 'matches-chan',
        alertChannelId: 'alerts-chan',
        resultsChannelId: 'results-chan',
        refereeRoleId: 'referee-role',
        toRoleId: 'to-role',
      },
    });
    const t = await createTournament(prisma, guildId, 'T', TO);
    tournamentId = t.id;
    await openRegistration(prisma, tournamentId, TO);
    await rosterAdd(prisma, guildId, 'p1', TO);
    await rosterAdd(prisma, guildId, 'p2', TO);
    await closeRegistration(prisma, tournamentId, TO);
    await openCheckin(prisma, tournamentId, TO);
    await rosterCheckin(prisma, guildId, 'p1', TO);
    await rosterCheckin(prisma, guildId, 'p2', TO);

    const moduleRef = await Test.createTestingModule({
      controllers: [RosterController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: TierService, useValue: { hasTier: async () => hasTierResult, resolveDisplayName: async (_guildId: string, discordUserId: string) => discordUserId } },
        { provide: REALTIME_PORT, useValue: { publishRosterChanged: (id: string) => rosterChangedCalls.push(id) } },
      ],
    }).compile();
    controller = moduleRef.get(RosterController);
  });
  afterAll(async () => {
    await prisma.guild.delete({ where: { id: guildId } }).catch(() => undefined);
  });

  describe('GET :id/roster', () => {
    it('rejects an unauthenticated request', async () => {
      hasTierResult = true;
      await expect(controller.getRoster(tournamentId, null)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects a signed-in user below Tournament Organizer tier', async () => {
      hasTierResult = false;
      await expect(controller.getRoster(tournamentId, 'someone')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404s for a tournament that does not exist', async () => {
      hasTierResult = true;
      await expect(controller.getRoster('does-not-exist', TO)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns the checked-in roster for a Tournament Organizer', async () => {
      hasTierResult = true;
      const roster = await controller.getRoster(tournamentId, TO);
      expect(roster.map((e) => e.discordUserId).sort()).toEqual(['p1', 'p2']);
      expect(roster.every((e) => e.checkedIn)).toBe(true);
    });
  });

  describe('POST :id/seeding', () => {
    it('rejects a signed-in user below Tournament Organizer tier', async () => {
      hasTierResult = false;
      await expect(controller.setSeeding(tournamentId, { order: [] }, 'someone')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects a malformed body with 400', async () => {
      hasTierResult = true;
      await expect(controller.setSeeding(tournamentId, { order: 'not-an-array' }, TO)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an order that does not match the checked-in roster', async () => {
      hasTierResult = true;
      await expect(controller.setSeeding(tournamentId, { order: ['bogus-id'] }, TO)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('reorders the roster, returns the updated wire shape, and broadcasts the change', async () => {
      hasTierResult = true;
      const before = await controller.getRoster(tournamentId, TO);
      const [a, b] = before;
      rosterChangedCalls.length = 0;
      const reversed = await controller.setSeeding(tournamentId, { order: [b!.entrantId, a!.entrantId] }, TO);

      expect(reversed.find((e) => e.entrantId === b!.entrantId)!.seed).toBe(1);
      expect(reversed.find((e) => e.entrantId === a!.entrantId)!.seed).toBe(2);
      // A browser with the seeding page open, on any surface, needs to
      // hear about this — see `RealtimeBroadcastPort.publishRosterChanged`.
      expect(rosterChangedCalls).toEqual([tournamentId]);
    });
  });
});
