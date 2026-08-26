import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { MatchState } from '../src/domain/types.js';
import { Bo5ProtectVetoFormat as F } from '../src/domain/bo5.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RulingsController } from '../src/api/rulings.controller.js';
import { ALERT_PORT, MATCH_CHANNEL_PORT, PLAYER_NOTIFICATION_PORT } from '../src/discord/discord-adapters.module.js';
import type { AlertPort, MatchChannelPort, PlayerNotificationPort } from '../src/discord/ports.js';
import { REALTIME_PORT } from '../src/realtime/realtime.tokens.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TierService } from '../src/auth/tier.service.js';
import { materializeBracket } from '../src/services/bracket-service.js';
import { appendMatchEvent } from '../src/services/match-service.js';
import { cryptoRandomPort, sequentialRandomPort } from '../src/services/ports.js';
import { isReachable, makeTournament, prisma, cleanupTournament, type TestTournament } from './support.js';

/** No-op fakes for every port method a ruling's `applyAppendResult` call might reach — same role `PrismaService: useValue: prisma` plays elsewhere in this suite, just for the Discord side. */
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

describe.skipIf(!(await isReachable()))('POST /api/matches/:id/rulings', () => {
  let t: TestTournament;
  let matchId: string;
  let controller: RulingsController;
  let hasTierResult: boolean;

  beforeAll(async () => {
    t = await makeTournament(`api-rulings-${Date.now()}`, 2);
    await materializeBracket(prisma, sequentialRandomPort('api-rulings'), t.tournamentId);
    const match = await prisma.match.findFirstOrThrow({ where: { tournamentId: t.tournamentId, bracket: 'WINNERS', round: 1 } });
    matchId = match.id;

    const moduleRef = await Test.createTestingModule({
      controllers: [RulingsController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: TierService, useValue: { hasTier: async () => hasTierResult, resolveDisplayName: async () => 'referee' } },
        { provide: MATCH_CHANNEL_PORT, useValue: fakeMatchChannel },
        { provide: ALERT_PORT, useValue: fakeAlert },
        { provide: PLAYER_NOTIFICATION_PORT, useValue: fakePlayerNotification },
        { provide: REALTIME_PORT, useValue: { publish: () => undefined } },
      ],
    }).compile();
    controller = moduleRef.get(RulingsController);
  });
  afterAll(() => cleanupTournament(t));

  it('rejects an unauthenticated request', async () => {
    hasTierResult = true;
    await expect(controller.rule(matchId, { type: 'SONG_RULED', songIndex: 0, result: 'TIE' }, null)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rejects a signed-in user below Referee tier', async () => {
    hasTierResult = false;
    await expect(controller.rule(matchId, { type: 'SONG_RULED', songIndex: 0, result: 'TIE' }, 'some-user')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('404s for a match that does not exist', async () => {
    hasTierResult = true;
    await expect(controller.rule('does-not-exist', { type: 'PROTECT_VETO_RESET', reason: 'test' }, 'referee')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects a malformed ruling body with 400', async () => {
    hasTierResult = true;
    await expect(controller.rule(matchId, { type: 'NOT_A_REAL_TYPE' }, 'referee')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a ruling the freeze predicate makes illegal — a song that never started', async () => {
    hasTierResult = true;
    // Round-1 materialization stops at the first human action (seed choice)
    // — song 0 hasn't been drawn yet, so ruling on it is a stale/illegal action.
    await expect(controller.rule(matchId, { type: 'SONG_RULED', songIndex: 0, result: 'TIE' }, 'referee')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('resolves a real WINNER_DISAGREEMENT escalation, guarded by the same freeze predicate Discord uses', async () => {
    hasTierResult = true;

    // Drive the real match up to the point both players have submitted
    // conflicting winner selections for song 0 — the same setup
    // bo5.test.ts's own "resumes once a referee rules" test uses.
    let match = await prisma.match.findUniqueOrThrow({ where: { id: matchId } });
    let state = match.state as unknown as MatchState;
    const [a, b] = state.participants.map((p) => p.entrantId);

    await appendMatchEvent(prisma, cryptoRandomPort, matchId, {
      actorId: a!,
      type: 'SEED_CHOICE_MADE',
      payload: { by: a!, order: 'FIRST' },
    });
    for (;;) {
      match = await prisma.match.findUniqueOrThrow({ where: { id: matchId } });
      state = match.state as unknown as MatchState;
      const pending = F.pendingAction(state);
      if (pending.kind !== 'PROTECT' && pending.kind !== 'VETO') break;
      await appendMatchEvent(prisma, cryptoRandomPort, matchId, {
        actorId: pending.actor,
        type: pending.kind === 'PROTECT' ? 'CHART_PROTECTED' : 'CHART_VETOED',
        payload: { by: pending.actor, drawIndex: pending.choices[0]! },
      });
    }

    // Both players' scores and photos land first — SELECT_WINNER isn't
    // pending for either until both have submitted, so this can't
    // interleave per-player the way the Protect/Veto loop above does.
    for (const id of [a!, b!]) {
      await appendMatchEvent(prisma, cryptoRandomPort, matchId, {
        actorId: id,
        type: 'SCORE_SUBMITTED',
        payload: { songIndex: 0, by: id, ex: 90 },
      });
      await appendMatchEvent(prisma, cryptoRandomPort, matchId, {
        actorId: null,
        type: 'PHOTO_OBSERVED',
        payload: { songIndex: 0, by: id, messageId: 'm' },
      });
    }
    for (const id of [a!, b!]) {
      await appendMatchEvent(prisma, cryptoRandomPort, matchId, {
        actorId: id,
        type: 'SONG_WINNER_SELECTED',
        payload: { songIndex: 0, by: id, choice: id }, // each picks themself — a real disagreement
      });
    }

    match = await prisma.match.findUniqueOrThrow({ where: { id: matchId } });
    state = match.state as unknown as MatchState;
    expect(F.pendingAction(state).kind).toBe('AWAITING_TO');

    const body = await controller.rule(matchId, { type: 'SONG_RULED', songIndex: 0, result: a! }, 'referee');
    expect(body.songs[0]!.result).toEqual({ winner: a, by: 'RULING' });
    expect(body.pending.kind).toBe('SUBMIT_SCORE'); // song 1 opened back up
  });
});
