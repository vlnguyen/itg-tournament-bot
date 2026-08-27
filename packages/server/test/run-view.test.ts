import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { MatchState } from '../src/domain/types.js';
import { Bo5ProtectVetoFormat as F } from '../src/domain/bo5.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TournamentsController } from '../src/api/tournaments.controller.js';
import { TierService } from '../src/auth/tier.service.js';
import { DISCORD_CLIENT } from '../src/discord/discord.tokens.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { materializeBracket } from '../src/services/bracket-service.js';
import { appendMatchEvent } from '../src/services/match-service.js';
import { cryptoRandomPort, sequentialRandomPort } from '../src/services/ports.js';
import { getRunView } from '../src/services/run-view-service.js';
import { isReachable, makeTournament, prisma, cleanupTournament, type TestTournament } from './support.js';

describe.skipIf(!(await isReachable()))('run view', () => {
  let t: TestTournament;
  let matchId: string;

  beforeAll(async () => {
    t = await makeTournament(`api-run-view-${Date.now()}`, 4);
    await materializeBracket(prisma, sequentialRandomPort('api-run-view'), t.tournamentId);
    const match = await prisma.match.findFirstOrThrow({ where: { tournamentId: t.tournamentId, bracket: 'WINNERS', round: 1, slot: 0 } });
    matchId = match.id;

    // Start the match — a seed choice is enough to flip status to
    // IN_PROGRESS (engine.ts sets it on every append), which is all the
    // live-match-list half of the run view needs.
    const state = match.state as unknown as MatchState;
    const [a] = state.participants.map((p) => p.entrantId);
    await appendMatchEvent(prisma, cryptoRandomPort, matchId, {
      actorId: a!,
      type: 'SEED_CHOICE_MADE',
      payload: { by: a!, order: 'FIRST' },
    });
  });
  afterAll(() => cleanupTournament(t));

  describe('getRunView (service)', () => {
    it('lists the started match as a live match, with no open escalation yet', async () => {
      // A 4-entrant bracket seeds both WR1 matches at once — materializeBracket
      // auto-starts each as soon as it has two real seeds — so this asserts
      // on the one match under test, not on the live list's total length.
      const view = await getRunView(prisma, t.tournamentId);
      expect(view.alerts).toEqual([]);
      const live = view.liveMatches.find((m) => m.matchId === matchId);
      expect(live).toBeDefined();
      expect(live!.matchLabel).toContain('Winners Round 1');
      expect(live!.participants).toHaveLength(2);
      expect(live!.since).toEqual(expect.any(String));
    });

    it('surfaces a real WINNER_DISAGREEMENT as an escalation, oldest-first', async () => {
      let match = await prisma.match.findUniqueOrThrow({ where: { id: matchId } });
      let state = match.state as unknown as MatchState;
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

      const [a, b] = state.participants.map((p) => p.entrantId);
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
          payload: { songIndex: 0, by: id, choice: id },
        });
      }

      match = await prisma.match.findUniqueOrThrow({ where: { id: matchId } });
      expect(match.awaitingTo).toBe(true);

      const view = await getRunView(prisma, t.tournamentId);
      expect(view.alerts).toHaveLength(1);
      const alert = view.alerts[0]!;
      expect(alert.kind).toBe('ESCALATION');
      if (alert.kind !== 'ESCALATION') throw new Error('unreachable');
      expect(alert.matchId).toBe(matchId);
      expect(alert.reason).toBe('WINNER_DISAGREEMENT');
      expect(alert.songIndex).toBe(0);

      // Still awaiting a ruling — still IN_PROGRESS, not COMPLETE — so it
      // remains on the live match list too, per DESIGN.md's "an open
      // escalation, still IN_PROGRESS by status alone."
      expect(view.liveMatches.some((m) => m.matchId === matchId)).toBe(true);
    });
  });

  describe('GET /api/tournaments/:id/run-view (controller)', () => {
    let controller: TournamentsController;
    let hasTierResult: boolean;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        controllers: [TournamentsController],
        providers: [
          { provide: PrismaService, useValue: prisma },
          { provide: TierService, useValue: { hasTier: async () => hasTierResult } },
          { provide: DISCORD_CLIENT, useValue: { guilds: { cache: new Map(), fetch: async () => null } } },
        ],
      }).compile();
      controller = moduleRef.get(TournamentsController);
    });

    it('rejects an unauthenticated request', async () => {
      hasTierResult = true;
      await expect(controller.getRunView(t.tournamentId, null)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects a signed-in user below Referee tier', async () => {
      hasTierResult = false;
      await expect(controller.getRunView(t.tournamentId, 'some-user')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404s for a tournament that does not exist', async () => {
      hasTierResult = true;
      await expect(controller.getRunView('does-not-exist', 'referee')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns a schema-valid run view for a Referee', async () => {
      hasTierResult = true;
      const view = await controller.getRunView(t.tournamentId, 'referee');
      expect(view.alerts.length).toBeGreaterThan(0);
      expect(view.liveMatches.length).toBeGreaterThan(0);
    });
  });
});
