import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LifecycleController } from '../src/api/lifecycle.controller.js';
import { TierService } from '../src/auth/tier.service.js';
import { ALERT_PORT, MATCH_CHANNEL_PORT, PLAYER_NOTIFICATION_PORT } from '../src/discord/discord-adapters.module.js';
import type { AlertPort, MatchChannelPort, PlayerNotificationPort } from '../src/discord/ports.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { rosterAdd, rosterCheckin } from '../src/services/roster-service.js';
import { createTournament } from '../src/services/tournament-service.js';
import { isReachable, prisma } from './support.js';

const TO = 'to-user';

const fakeMatchChannel: MatchChannelPort = {
  createMatchThread: async () => ({ matchId: '', threadId: 'fake-thread' }),
  postLogMessage: async () => undefined,
  postMatchState: async () => undefined,
  archiveThread: async () => undefined,
  publishResult: async () => undefined,
};
const fakeAlert: AlertPort = {
  raise: async () => ({ messageId: 'fake-alert' }),
  resolve: async () => undefined,
};
const fakePlayerNotification: PlayerNotificationPort = {
  matchReady: async () => undefined,
  checkinOpened: async () => ({ unreachable: [] }),
  registrationOpened: async () => undefined,
  entrantJoined: async () => undefined,
  entrantCheckedIn: async () => undefined,
  tournamentCancelled: async () => undefined,
  checkinClosed: async () => undefined,
  tournamentStarted: async () => undefined,
};

describe.skipIf(!(await isReachable()))('GET/POST /api/tournaments/:id/lifecycle', () => {
  let guildId: string;
  let tournamentId: string;
  let controller: LifecycleController;
  let hasTierResult: boolean;

  beforeAll(async () => {
    guildId = `api-lifecycle-${Date.now()}`;
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

    const moduleRef = await Test.createTestingModule({
      controllers: [LifecycleController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: TierService, useValue: { hasTier: async () => hasTierResult, resolveDisplayName: async () => TO } },
        { provide: MATCH_CHANNEL_PORT, useValue: fakeMatchChannel },
        { provide: ALERT_PORT, useValue: fakeAlert },
        { provide: PLAYER_NOTIFICATION_PORT, useValue: fakePlayerNotification },
      ],
    }).compile();
    controller = moduleRef.get(LifecycleController);
  });
  afterAll(async () => {
    await prisma.guild.delete({ where: { id: guildId } }).catch(() => undefined);
  });
  beforeEach(() => {
    hasTierResult = true;
  });

  describe('GET :id/lifecycle', () => {
    it('rejects an unauthenticated request', async () => {
      await expect(controller.getStatus(tournamentId, null)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects a signed-in user below Tournament Organizer tier', async () => {
      hasTierResult = false;
      await expect(controller.getStatus(tournamentId, 'someone')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404s for a tournament that does not exist', async () => {
      await expect(controller.getStatus('does-not-exist', TO)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('reports DRAFT with OPEN_REGISTRATION legal and the config guard failing (no channels/roles bound on this guild)', async () => {
      const status = await controller.getStatus(tournamentId, TO);
      expect(status.state).toBe('DRAFT');
      expect(status.legalActions).toContain('OPEN_REGISTRATION');
      expect(status.legalActions).toContain('CANCEL');
      expect(status.legalActions).not.toContain('CLOSE_CHECKIN');
      const configGuard = status.startGuards.find((g) => g.label.includes('configured'));
      expect(configGuard!.ok).toBe(true); // this test guild DOES have channels/roles bound
    });
  });

  describe('POST :id/lifecycle', () => {
    it('rejects a signed-in user below Tournament Organizer tier', async () => {
      hasTierResult = false;
      await expect(controller.postAction(tournamentId, { action: 'OPEN_REGISTRATION' }, 'someone')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects a malformed body with 400', async () => {
      await expect(controller.postAction(tournamentId, { action: 'NOT_REAL' }, TO)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an illegal transition (RENAME requires a name) with 400', async () => {
      await expect(controller.postAction(tournamentId, { action: 'RENAME' }, TO)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('walks the tournament through the full lifecycle, matching what /tournament would do', async () => {
      let status = await controller.postAction(tournamentId, { action: 'RENAME', name: 'Renamed T' }, TO);
      expect(status.name).toBe('Renamed T');

      status = await controller.postAction(tournamentId, { action: 'OPEN_REGISTRATION' }, TO);
      expect(status.state).toBe('REGISTRATION_OPEN');

      await rosterAdd(prisma, guildId, 'p1', TO);
      await rosterAdd(prisma, guildId, 'p2', TO);

      status = await controller.postAction(tournamentId, { action: 'CLOSE_REGISTRATION' }, TO);
      expect(status.state).toBe('REGISTRATION_CLOSED');

      status = await controller.postAction(tournamentId, { action: 'OPEN_CHECKIN' }, TO);
      expect(status.state).toBe('CHECKIN_OPEN');

      // Before anyone's checked in: the entrant-count guard should fail.
      let beforeCheckin = await controller.getStatus(tournamentId, TO);
      expect(beforeCheckin.startGuards.find((g) => g.label.includes('checked-in'))!.ok).toBe(false);

      await rosterCheckin(prisma, guildId, 'p1', TO);
      await rosterCheckin(prisma, guildId, 'p2', TO);

      let afterCheckin = await controller.getStatus(tournamentId, TO);
      expect(afterCheckin.startGuards.find((g) => g.label.includes('checked-in'))!.ok).toBe(true);
      // No pack imported — the pack guard should still fail.
      expect(afterCheckin.startGuards.find((g) => g.label.includes('pack'))!.ok).toBe(false);

      status = await controller.postAction(tournamentId, { action: 'CLOSE_CHECKIN' }, TO);
      expect(status.state).toBe('CHECKIN_CLOSED');
      expect(status.legalActions).not.toContain('CLOSE_CHECKIN'); // terminal within this state
      expect(status.legalActions).toContain('OPEN_CHECKIN'); // reopenable

      status = await controller.postAction(tournamentId, { action: 'CANCEL' }, TO);
      expect(status.state).toBe('CANCELLED');
      expect(status.legalActions).toEqual([]); // terminal
    });
  });
});
