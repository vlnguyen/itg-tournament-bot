import type {
  CreateTournamentRequest,
  CreateTournamentResult as CreateTournamentResultWire,
  FirstRunStatus as FirstRunStatusWire,
  GuildOverview as GuildOverviewWire,
  GuildSummary as GuildSummaryWire,
  TournamentSummary,
} from '@itg/shared';
import {
  CreateTournamentRequest as CreateTournamentRequestSchema,
  CreateTournamentResult as CreateTournamentResultSchema,
  FirstRunStatus as FirstRunStatusSchema,
  GuildOverview as GuildOverviewSchema,
  GuildSummary as GuildSummarySchema,
} from '@itg/shared';
import type { Tournament } from '@prisma/client';
import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Param, Post } from '@nestjs/common';
import { ZodError } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { DiscordGuildsService } from '../auth/discord-guilds.service.js';
import { TierService } from '../auth/tier.service.js';
import { Tier } from '../discord/tier.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  createTournament,
  findDraftTournament,
  findPublicCurrentTournament,
  getTournamentHistory,
  missingGuildConfig,
  TournamentSlotOccupiedError,
} from '../services/tournament-service.js';

function toSummary(t: Tournament): TournamentSummary {
  return { id: t.id, name: t.name, state: t.state, createdAt: t.createdAt.toISOString() };
}

/**
 * `GET /api/guilds/:guildId/overview` — the `/g/:guildId` page itself, not
 * a redirect into one tournament. No 404 for an unknown guild: the answer
 * is simply an empty overview, the same as a real guild that has never run
 * a tournament — there's nothing to distinguish from the client's point of
 * view, and guessing a guild id reveals nothing either way.
 */
@Controller('api/guilds')
export class GuildsController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TierService) private readonly tierService: TierService,
    @Inject(DiscordGuildsService) private readonly discordGuildsService: DiscordGuildsService,
  ) {}

  /**
   * `GET /api/guilds` — the homepage's server list. Always the caller's
   * own guilds (`@CurrentUser()`), never a lookup by some other id; a
   * signed-out request just gets `[]`, the same as anyone else asking
   * "what are *my* guilds" with no identity to answer for.
   */
  @Get()
  async listMine(@CurrentUser() discordUserId: string | null): Promise<GuildSummaryWire[]> {
    const guilds = discordUserId ? await this.discordGuildsService.manageableGuildsFor(discordUserId) : [];
    return GuildSummarySchema.array().parse(guilds);
  }

  @Get(':guildId/overview')
  async getOverview(@Param('guildId') guildId: string): Promise<GuildOverviewWire> {
    const [active, history] = await Promise.all([
      findPublicCurrentTournament(this.prisma, guildId),
      getTournamentHistory(this.prisma, guildId),
    ]);
    return GuildOverviewSchema.parse({
      activeTournament: active ? toSummary(active) : null,
      history: history.map(toSummary),
    });
  }

  /**
   * `GET /api/guilds/:guildId/first-run` — see `FirstRunStatus`'s comment
   * in `@itg/shared`. `canManage` gates on Manage Guild (who'd run
   * `/setup`) *or* Tournament Organizer tier (who'd continue a `DRAFT`),
   * since either one is a reason to show the wizard; the two panels it
   * feeds are gated on their own actual tier separately, same as
   * everywhere else in this app.
   */
  @Get(':guildId/first-run')
  async getFirstRun(@Param('guildId') guildId: string, @CurrentUser() discordUserId: string | null): Promise<FirstRunStatusWire> {
    const canManage = discordUserId
      ? (await this.tierService.hasManageGuild(guildId, discordUserId)) ||
        (await this.tierService.hasTier(guildId, discordUserId, Tier.TOURNAMENT_ORGANIZER))
      : false;

    if (!canManage) {
      return FirstRunStatusSchema.parse({ canManage: false, missingConfig: [], draftTournamentId: null, draftTournamentName: null });
    }

    const [guild, draft] = await Promise.all([
      this.prisma.guild.findUnique({ where: { id: guildId } }),
      findDraftTournament(this.prisma, guildId),
    ]);
    return FirstRunStatusSchema.parse({
      canManage: true,
      missingConfig: missingGuildConfig(guild),
      draftTournamentId: draft?.id ?? null,
      draftTournamentName: draft?.name ?? null,
    });
  }

  /**
   * `POST /api/guilds/:guildId/tournaments` — the web equivalent of
   * `/tournament create`, same Tournament Organizer gate and same
   * underlying `createTournament`. A guild already holding one (`DRAFT`
   * included — one tournament per guild from creation) surfaces as a 400
   * naming what it's holding, not a 500 or a silently-ignored click.
   */
  @Post(':guildId/tournaments')
  async createTournament(
    @Param('guildId') guildId: string,
    @Body() body: unknown,
    @CurrentUser() discordUserId: string | null,
  ): Promise<CreateTournamentResultWire> {
    if (!discordUserId || !(await this.tierService.hasTier(guildId, discordUserId, Tier.TOURNAMENT_ORGANIZER))) {
      throw new ForbiddenException('You need Tournament Organizer tier to create a tournament.');
    }

    let request: CreateTournamentRequest;
    try {
      request = CreateTournamentRequestSchema.parse(body);
    } catch (err) {
      if (err instanceof ZodError) throw new BadRequestException(err.issues);
      throw err;
    }

    try {
      const tournament = await createTournament(this.prisma, guildId, request.name, discordUserId);
      return CreateTournamentResultSchema.parse({ tournamentId: tournament.id });
    } catch (err) {
      if (err instanceof TournamentSlotOccupiedError) {
        throw new BadRequestException(`This server already holds "${err.held.name}" (${err.held.state}).`);
      }
      throw err;
    }
  }
}
