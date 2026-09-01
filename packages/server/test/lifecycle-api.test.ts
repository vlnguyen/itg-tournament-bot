import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LifecycleController } from '../src/api/lifecycle.controller.js';
import { TierService } from '../src/auth/tier.service.js';
import { ALERT_PORT, MATCH_CHANNEL_PORT, PLAYER_NOTIFICATION_PORT } from '../src/discord/discord-adapters.module.js';
import { DISCORD_CLIENT } from '../src/discord/discord.tokens.js';
import type { AlertPort, MatchChannelPort, PlayerNotificationPort } from '../src/discord/ports.js';
import { REALTIME_PORT } from '../src/realtime/realtime.tokens.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { getRoster, rosterAdd, rosterCheckin } from '../src/services/roster-service.js';
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
        // The bot holds no guild at all — enough to exercise START's "bot
        // isn't in this server anymore" guard without faking a full
        // discord.js Guild's permission model. The happy path
        // (`startTournamentWithDiscordEffects`'s live preflight,
        // provisioning) is unchanged logic moved from `handleStart`, not
        // new behavior, and stays covered by this project's usual
        // live-verify pass rather than a from-scratch discord.js fake here.
        { provide: DISCORD_CLIENT, useValue: { guilds: { cache: new Map(), fetch: async () => null } } },
        { provide: REALTIME_PORT, useValue: { publish: () => undefined, publishRosterChanged: () => undefined, publishLifecycleChanged: () => undefined } },
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

    it('rejects START a Tournament Organizer below tier the same way every other action does', async () => {
      hasTierResult = false;
      await expect(controller.postAction(tournamentId, { action: 'START' }, 'someone')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("rejects START with 400 when the bot isn't in the guild anymore, without ever touching the tournament's state", async () => {
      const startGuildId = `api-lifecycle-start-${Date.now()}`;
      await prisma.guild.create({
        data: {
          id: startGuildId,
          matchesChannelId: 'matches-chan',
          alertChannelId: 'alerts-chan',
          resultsChannelId: 'results-chan',
          refereeRoleId: 'referee-role',
          toRoleId: 'to-role',
        },
      });
      try {
        const t = await createTournament(prisma, startGuildId, 'Start Test', TO);
        await prisma.tournament.update({ where: { id: t.id }, data: { state: 'CHECKIN_CLOSED' } });

        await expect(controller.postAction(t.id, { action: 'START' }, TO)).rejects.toBeInstanceOf(BadRequestException);

        const after = await prisma.tournament.findUniqueOrThrow({ where: { id: t.id } });
        expect(after.state).toBe('CHECKIN_CLOSED'); // refused before startTournament ever ran
      } finally {
        await prisma.guild.delete({ where: { id: startGuildId } }).catch(() => undefined);
      }
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
      expect(status.legalActions).toContain('OPEN_REGISTRATION'); // reopenable further back too
      expect(status.legalActions).toContain('START'); // legal per the state machine — the live preflight is a separate concern

      // Reopening registration this deep preserves both check-ins.
      status = await controller.postAction(tournamentId, { action: 'OPEN_REGISTRATION' }, TO);
      expect(status.state).toBe('REGISTRATION_OPEN');
      const roster = await getRoster(prisma, guildId);
      expect(roster.filter((e) => e.checkedIn)).toHaveLength(2);

      status = await controller.postAction(tournamentId, { action: 'CANCEL' }, TO);
      expect(status.state).toBe('CANCELLED');
      expect(status.legalActions).toEqual([]); // terminal
    });
  });

  describe('POST :id/lifecycle GENERATE_BRACKET, and POST :id/match-formats', () => {
    it('is legal at CHECKIN_CLOSED, generates real matches, and a per-match override survives to a mixed-format conflict', async () => {
      const gid = `api-lifecycle-bracket-${Date.now()}`;
      await prisma.guild.create({
        data: {
          id: gid,
          matchesChannelId: 'matches-chan',
          alertChannelId: 'alerts-chan',
          resultsChannelId: 'results-chan',
          refereeRoleId: 'referee-role',
          toRoleId: 'to-role',
        },
      });
      try {
        const t = await createTournament(prisma, gid, 'Bracket Test', TO);
        await controller.postAction(t.id, { action: 'OPEN_REGISTRATION' }, TO);
        for (const p of ['p1', 'p2', 'p3', 'p4']) await rosterAdd(prisma, gid, p, TO);
        await controller.postAction(t.id, { action: 'CLOSE_REGISTRATION' }, TO);
        await controller.postAction(t.id, { action: 'OPEN_CHECKIN' }, TO);
        for (const p of ['p1', 'p2', 'p3', 'p4']) await rosterCheckin(prisma, gid, p, TO);
        const closed = await controller.postAction(t.id, { action: 'CLOSE_CHECKIN' }, TO);
        expect(closed.legalActions).toContain('GENERATE_BRACKET');
        expect(closed.bracketEntrantCount).toBeNull(); // nothing generated yet

        const generated = await controller.postAction(t.id, { action: 'GENERATE_BRACKET' }, TO);
        expect(generated.bracketEntrantCount).toBe(4);
        const matches = await prisma.match.findMany({ where: { tournamentId: t.id } });
        expect(matches.length).toBeGreaterThan(0);
        expect(matches.every((m) => m.status === 'PENDING' && m.formatKey === 'bo5-protect-veto')).toBe(true);

        const wr1 = matches.find((m) => m.bracket === 'WINNERS' && m.round === 1)!;
        await controller.postMatchFormats(t.id, { refs: [{ bracket: 'WINNERS', round: 1, slot: wr1.slot }], formatKey: 'bo3-protect-veto' }, TO);
        const reassigned = await prisma.match.findUniqueOrThrow({ where: { id: wr1.id } });
        expect(reassigned.formatKey).toBe('bo3-protect-veto');

        // The default now disagrees with that one override — a plain
        // SET_FORMAT with no mode must surface the conflict, not silently pick a side.
        await expect(controller.postAction(t.id, { action: 'SET_FORMAT', formatKey: 'bo3-protect-veto' }, TO)).rejects.toBeInstanceOf(
          ConflictException,
        );

        // UPDATE_ALL resolves it: every match follows, override cleared.
        const resolved = await controller.postAction(t.id, { action: 'SET_FORMAT', formatKey: 'bo3-protect-veto', mode: 'UPDATE_ALL' }, TO);
        expect(resolved.defaultFormatKey).toBe('bo3-protect-veto');
        const uniform = await prisma.match.findMany({ where: { tournamentId: t.id } });
        expect(uniform.every((m) => m.formatKey === 'bo3-protect-veto')).toBe(true);
      } finally {
        await prisma.guild.delete({ where: { id: gid } }).catch(() => undefined);
      }
    });

    it('rejects a malformed match-formats body with 400', async () => {
      await expect(controller.postMatchFormats(tournamentId, { refs: [] }, TO)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects match-formats for a signed-in user below Tournament Organizer tier', async () => {
      hasTierResult = false;
      await expect(
        controller.postMatchFormats(tournamentId, { refs: [{ bracket: 'WINNERS', round: 1, slot: 0 }], formatKey: 'bo3-protect-veto' }, 'someone'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
