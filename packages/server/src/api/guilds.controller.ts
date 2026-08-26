import type { LandingTournament as LandingTournamentWire } from '@itg/shared';
import { LandingTournament as LandingTournamentSchema } from '@itg/shared';
import { Controller, Get, Inject, Param } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { resolvePublicLandingTournament } from '../services/tournament-service.js';

/**
 * `GET /api/guilds/:guildId/landing-tournament` — what a server's landing
 * page redirects to, per DESIGN.md, "Permanent URLs". No 404 for an
 * unknown guild: the answer is simply `{ tournamentId: null }`, the same
 * as a real guild that has never run a tournament — there's nothing to
 * distinguish from the client's point of view, and guessing a guild id
 * reveals nothing either way.
 */
@Controller('api/guilds')
export class GuildsController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get(':guildId/landing-tournament')
  async getLandingTournament(@Param('guildId') guildId: string): Promise<LandingTournamentWire> {
    const tournament = await resolvePublicLandingTournament(this.prisma, guildId);
    return LandingTournamentSchema.parse({ tournamentId: tournament?.id ?? null });
  }
}
