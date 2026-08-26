import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { generateBracket, matchKey, PublicMatch, TournamentSnapshot, type ChartInput } from '@itg/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChartsController } from '../src/api/charts.controller.js';
import { GuildsController } from '../src/api/guilds.controller.js';
import { MatchesController } from '../src/api/matches.controller.js';
import { PlayersController } from '../src/api/players.controller.js';
import { TournamentsController } from '../src/api/tournaments.controller.js';
import { TierService } from '../src/auth/tier.service.js';
import { materializeBracket } from '../src/services/bracket-service.js';
import { cryptoRandomPort, sequentialRandomPort } from '../src/services/ports.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { cleanupTournament, driveToCompletion, isReachable, makeTournament, prisma, type TestTournament } from './support.js';

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
      providers: [{ provide: PrismaService, useValue: prisma }, { provide: TierService, useValue: { hasTier: async () => true } }],
    }).compile();
    matchesController = moduleRef.get(MatchesController);
    tournamentsController = moduleRef.get(TournamentsController);
    guildsController = moduleRef.get(GuildsController);
  });
  afterAll(() => cleanupTournament(t));

  describe('GET /api/guilds/:guildId/overview', () => {
    it("names the guild's running tournament as active, with no history yet", async () => {
      const body = await guildsController.getOverview(t.guildId);
      expect(body.activeTournament?.id).toBe(t.tournamentId);
      expect(body.history).toEqual([]);
    });

    it('returns an empty overview for a guild that has never had one', async () => {
      const body = await guildsController.getOverview('no-such-guild');
      expect(body).toEqual({ activeTournament: null, history: [] });
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

  describe('GET /api/tournaments/:id/standings', () => {
    it('is empty before the tournament has a decided outcome', async () => {
      const body = await tournamentsController.getStandings(t.tournamentId);
      expect(body).toEqual([]);
    });

    it('404s for an id that does not exist', async () => {
      await expect(tournamentsController.getStandings('does-not-exist')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

/**
 * Standings and player pages both need a *decided* tournament — a
 * separate fixture, driven all the way to COMPLETE via chalk (lowest
 * seed always wins), so results/placements/win-loss records are real
 * rather than asserted against an in-progress bracket.
 */
describe.skipIf(!(await isReachable()))('standings and player pages, against a completed tournament', () => {
  let t: TestTournament;
  let tournamentsController: TournamentsController;
  let playersController: PlayersController;

  beforeAll(async () => {
    t = await makeTournament(`api-complete-${Date.now()}`, 4);
    await materializeBracket(prisma, sequentialRandomPort('api-complete'), t.tournamentId);
    await driveToCompletion(t.tournamentId, t.entrantIds, cryptoRandomPort);

    const moduleRef = await Test.createTestingModule({
      controllers: [TournamentsController, PlayersController],
      providers: [{ provide: PrismaService, useValue: prisma }, { provide: TierService, useValue: { hasTier: async () => true } }],
    }).compile();
    tournamentsController = moduleRef.get(TournamentsController);
    playersController = moduleRef.get(PlayersController);
  });
  afterAll(() => cleanupTournament(t));

  it('standings rank the chalk finish — seed 1 champion, seed 2 runner-up', async () => {
    const body = await tournamentsController.getStandings(t.tournamentId);
    expect(body.find((r) => r.seed === 1)?.place).toBe(1);
    expect(body.find((r) => r.seed === 2)?.place).toBe(2);
  });

  it('a player page shows the win-loss record and match history for the champion', async () => {
    const championDiscordId = `${t.guildId}-p1`;
    const page = await playersController.getPlayer(t.guildId, championDiscordId);
    expect(page.discordUserId).toBe(championDiscordId);
    expect(page.losses).toBe(0);
    expect(page.wins).toBeGreaterThan(0);
    expect(page.matches.every((m) => m.won)).toBe(true);
  });

  it('404s for a discord user who never played in this guild', async () => {
    await expect(playersController.getPlayer(t.guildId, 'never-played')).rejects.toBeInstanceOf(NotFoundException);
  });
});

const validChart: ChartInput = {
  title: 'Test Song',
  titleTranslit: null,
  subtitle: null,
  subtitleTranslit: null,
  artist: null,
  artistTranslit: null,
  playStyle: 'SINGLE',
  difficulty: 'EXPERT',
  meter: 12,
  stepartist: null,
  description: null,
  sourcePack: 'Test Pack',
  flags: [],
};

/**
 * `ChartsController`'s POST route is the first real usage of the tier-auth
 * machinery from step 4 (`TierService`, `@CurrentUser()`) against a live
 * route — faked here rather than wired to a real Discord gateway/session
 * cookie, the same way `PrismaService` is faked with the real test
 * database elsewhere in this file.
 */
describe.skipIf(!(await isReachable()))('song pack import — GET/POST /api/tournaments/:id/charts', () => {
  let t: TestTournament;
  let chartsController: ChartsController;
  let hasTierResult: boolean;

  beforeAll(async () => {
    t = await makeTournament(`api-charts-${Date.now()}`, 2);
    // `makeTournament` seeds `RUNNING` (most fixtures here need a live
    // bracket) — pack import needs a not-yet-started tournament, so this
    // suite overrides it. The dedicated "once RUNNING" test below flips it
    // back deliberately, and only after every other test has already run.
    await prisma.tournament.update({ where: { id: t.tournamentId }, data: { state: 'DRAFT' } });

    const moduleRef = await Test.createTestingModule({
      controllers: [ChartsController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: TierService, useValue: { hasTier: async () => hasTierResult } },
      ],
    }).compile();
    chartsController = moduleRef.get(ChartsController);
  });
  afterAll(() => cleanupTournament(t));

  it('GET returns the pack the fixture already seeded, as ChartSnapshots', async () => {
    const body = await chartsController.getCharts(t.tournamentId);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0]).toHaveProperty('chartId');
  });

  it('GET 404s for an id that does not exist', async () => {
    await expect(chartsController.getCharts('does-not-exist')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('POST rejects an unauthenticated request', async () => {
    hasTierResult = true; // irrelevant — no discordUserId at all short-circuits first
    await expect(chartsController.importCharts(t.tournamentId, { charts: [validChart] }, null)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('POST rejects a signed-in user below Tournament Organizer tier', async () => {
    hasTierResult = false;
    await expect(chartsController.importCharts(t.tournamentId, { charts: [validChart] }, 'some-user')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('POST rejects a malformed payload with 400, not 500 — the client fully controls this payload', async () => {
    hasTierResult = true;
    await expect(chartsController.importCharts(t.tournamentId, { charts: [{ title: '' }] }, 'organizer')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('POST persists a valid import for an authorized organizer, additively', async () => {
    hasTierResult = true;
    const before = await chartsController.getCharts(t.tournamentId);
    const result = await chartsController.importCharts(t.tournamentId, { charts: [validChart] }, 'organizer');
    expect(result.imported).toBe(1);
    const after = await chartsController.getCharts(t.tournamentId);
    expect(after.length).toBe(before.length + 1);
    expect(after.some((c) => c.title === 'Test Song')).toBe(true);
  });

  it('POST rejects import once the tournament has started', async () => {
    hasTierResult = true;
    await prisma.tournament.update({ where: { id: t.tournamentId }, data: { state: 'RUNNING' } });
    await expect(chartsController.importCharts(t.tournamentId, { charts: [validChart] }, 'organizer')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
