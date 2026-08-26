import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { generateBracket, matchKey, PublicMatch, TournamentSnapshot } from '@itg/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GuildsController } from '../src/api/guilds.controller.js';
import { MatchesController } from '../src/api/matches.controller.js';
import { TournamentsController } from '../src/api/tournaments.controller.js';
import { materializeBracket } from '../src/services/bracket-service.js';
import { sequentialRandomPort } from '../src/services/ports.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { cleanupTournament, isReachable, makeTournament, prisma, type TestTournament } from './support.js';

/**
 * Integration coverage for step 5's two GET routes. Real Postgres, real
 * `materializeBracket` output — a round-1 match with real state, and a
 * later-round match with none yet (`state: null`) — so both branches
 * `matches.controller.ts`/`tournaments.controller.ts` handle are actually
 * exercised, not just typechecked. Response bodies are parsed against the
 * shared zod schema, same as the controllers themselves do, so a drift
 * between what's returned and what the client expects fails here first.
 */
describe.skipIf(!(await isReachable()))('public REST routes', () => {
  let t: TestTournament;
  let matchesController: MatchesController;
  let tournamentsController: TournamentsController;
  let guildsController: GuildsController;

  beforeAll(async () => {
    t = await makeTournament(`api-${Date.now()}`, 4);
    await materializeBracket(prisma, sequentialRandomPort('api'), t.tournamentId);

    const moduleRef = await Test.createTestingModule({
      controllers: [MatchesController, TournamentsController, GuildsController],
      providers: [{ provide: PrismaService, useValue: prisma }],
    }).compile();
    matchesController = moduleRef.get(MatchesController);
    tournamentsController = moduleRef.get(TournamentsController);
    guildsController = moduleRef.get(GuildsController);
  });
  afterAll(() => cleanupTournament(t));

  describe('GET /api/guilds/:guildId/landing-tournament', () => {
    it('resolves to the guild\'s running tournament', async () => {
      const body = await guildsController.getLandingTournament(t.guildId);
      expect(body.tournamentId).toBe(t.tournamentId);
    });

    it('returns null for a guild that has never had one', async () => {
      const body = await guildsController.getLandingTournament('no-such-guild');
      expect(body.tournamentId).toBeNull();
    });
  });

  describe('GET /api/matches/:id', () => {
    it('returns a schema-valid PublicMatch for a started round-1 match', async () => {
      const round1 = await prisma.match.findFirstOrThrow({
        where: { tournamentId: t.tournamentId, bracket: 'WINNERS', round: 1 },
      });
      const body = await matchesController.getMatch(round1.id);
      expect(() => PublicMatch.parse(body)).not.toThrow();
      expect(body.participants).toHaveLength(2);
    });

    it('returns the empty-state projection for a not-yet-created later match, not a crash', async () => {
      const later = await prisma.match.findFirstOrThrow({
        where: { tournamentId: t.tournamentId, NOT: { bracket: 'WINNERS', round: 1 } },
      });
      expect(later.state).toBeNull();
      const body = await matchesController.getMatch(later.id);
      expect(body.participants).toEqual([]);
      // No participants yet, so the format reports nothing to do — see
      // `bo5.ts`'s `pendingAction`, `state.participants.length === 0`.
      expect(body.pending).toEqual({ kind: 'DONE' });
    });

    it('404s for an id that does not exist', async () => {
      await expect(matchesController.getMatch('does-not-exist')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('GET /api/tournaments/:id', () => {
    it('returns a schema-valid snapshot covering every generated match', async () => {
      const body = await tournamentsController.getTournament(t.tournamentId);
      expect(() => TournamentSnapshot.parse(body)).not.toThrow();
      expect(body.entrantCount).toBe(4);

      const allMatches = await prisma.match.findMany({ where: { tournamentId: t.tournamentId } });
      expect(body.matches).toHaveLength(allMatches.length);

      const round1 = body.matches.filter((m) => m.bracket === 'WINNERS' && m.round === 1);
      expect(round1.every((m) => m.match.status === 'IN_PROGRESS')).toBe(true);
      expect(round1.every((m) => m.match.participants.length === 2)).toBe(true);
    });

    it('404s for an id that does not exist', async () => {
      await expect(tournamentsController.getTournament('does-not-exist')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('entrantCount reproduces the exact match set the server generated — the bracket UI\'s connector graph', async () => {
      const body = await tournamentsController.getTournament(t.tournamentId);
      const generated = generateBracket(body.entrantCount);
      const returnedKeys = new Set(body.matches.map((m) => matchKey({ bracket: m.bracket, round: m.round, slot: m.slot })));
      for (const gm of generated.matches) {
        expect(returnedKeys.has(matchKey(gm.ref))).toBe(true);
      }
      expect(returnedKeys.size).toBe(generated.matches.length);
    });
  });
});
