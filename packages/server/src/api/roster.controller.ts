import type { Roster as RosterWire } from '@itg/shared';
import { Roster as RosterSchema, SeedingRequest } from '@itg/shared';
import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post } from '@nestjs/common';
import { ZodError } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { TierService } from '../auth/tier.service.js';
import { Tier } from '../discord/tier.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { REALTIME_PORT } from '../realtime/realtime.tokens.js';
import type { RealtimeBroadcastPort } from '../services/ports.js';
import { getRoster, reorderSeeds, type RosterEntry } from '../services/roster-service.js';

/**
 * Pre-start, `Entrant.displayName` is still null (it's only frozen at
 * `startTournament`) — resolving it live here is what keeps the seeding
 * page from falling back to a raw Discord id, the same "guild nickname,
 * else username, never the id if it can be helped" resolution
 * `TierService.resolveDisplayName` already gives every other
 * web-originated action.
 */
async function toWire(tierService: TierService, guildId: string, entrants: RosterEntry[]): Promise<RosterWire> {
  const resolved = await Promise.all(
    entrants.map((e) => e.displayName ?? tierService.resolveDisplayName(guildId, e.discordUserId)),
  );
  return RosterSchema.parse(
    entrants.map((e, i) => ({
      entrantId: e.id,
      discordUserId: e.discordUserId,
      displayName: resolved[i],
      checkedIn: e.checkedIn,
      seed: e.seed,
      joinedAt: e.joinedAt.toISOString(),
    })),
  );
}

/**
 * `GET`/`POST /api/tournaments/:id/roster`+`/seeding` — DESIGN.md,
 * "Seeding": "The roster is the seeding interface." Tournament Organizer
 * tier, same as `/roster` itself and the console's other roster actions —
 * "a Tournament Organizer can do anything a player can do for themselves...
 * to any entrant, until the tournament starts." The public bracket and
 * standings are enough for anyone else once a tournament finishes; the
 * roster/seeding order stays organizer-only at every state.
 */
@Controller('api/tournaments')
export class RosterController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TierService) private readonly tierService: TierService,
    @Inject(REALTIME_PORT) private readonly realtime: RealtimeBroadcastPort,
  ) {}

  private async requireOrganizer(tournamentId: string, discordUserId: string | null): Promise<{ guildId: string }> {
    const tournament = await this.prisma.tournament.findUnique({ where: { id: tournamentId } });
    if (!tournament) throw new NotFoundException(`no tournament ${tournamentId}`);

    if (!discordUserId || !(await this.tierService.hasTier(tournament.guildId, discordUserId, Tier.TOURNAMENT_ORGANIZER))) {
      throw new ForbiddenException('You need Tournament Organizer tier to manage the roster.');
    }
    return { guildId: tournament.guildId };
  }

  @Get(':id/roster')
  async getRoster(@Param('id') id: string, @CurrentUser() discordUserId: string | null): Promise<RosterWire> {
    const { guildId } = await this.requireOrganizer(id, discordUserId);
    return toWire(this.tierService, guildId, await getRoster(this.prisma, id));
  }

  @Post(':id/seeding')
  async setSeeding(@Param('id') id: string, @Body() body: unknown, @CurrentUser() discordUserId: string | null): Promise<RosterWire> {
    const { guildId } = await this.requireOrganizer(id, discordUserId);

    let order: string[];
    try {
      order = SeedingRequest.parse(body).order;
    } catch (err) {
      if (err instanceof ZodError) throw new BadRequestException(err.issues);
      throw err;
    }

    const result = await reorderSeeds(this.prisma, guildId, order, discordUserId!);
    switch (result.kind) {
      case 'NO_TOURNAMENT':
        throw new NotFoundException(`no active tournament for guild ${guildId}`);
      case 'TOO_LATE':
        throw new BadRequestException(`Can't reorder seeding: the tournament is already ${result.phase}.`);
      case 'INVALID_ORDER':
        throw new BadRequestException("That order doesn't match the active roster. Someone likely joined, checked in, or withdrew. Reload and try again.");
      case 'REORDERED':
        break;
    }

    this.realtime.publishRosterChanged(id);
    return toWire(this.tierService, guildId, await getRoster(this.prisma, id));
  }
}
