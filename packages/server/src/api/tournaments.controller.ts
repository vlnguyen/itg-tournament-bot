import type { TournamentSnapshot as TournamentSnapshotWire } from '@itg/shared';
import { TournamentSnapshot as TournamentSnapshotSchema } from '@itg/shared';
import { Controller, Get, Inject, NotFoundException, Param } from '@nestjs/common';
import { toBracketMatch } from '../domain/projection.js';
import { emptyState } from '../domain/types.js';
import type { MatchState } from '../domain/types.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { requireFormat } from '../services/engine.js';

/**
 * `GET /api/tournaments/:id` — the bracket snapshot, DESIGN.md's "resync
 * fetch": on first load or reconnect, the client fetches this and then
 * applies websocket frames on top, dropping any whose `seq` isn't newer
 * than what it already has. `toBracketMatch` (not `toPublicMatch`) per
 * match, deliberately — see the schema's own comment for why.
 */
@Controller('api/tournaments')
export class TournamentsController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get(':id')
  async getTournament(@Param('id') id: string): Promise<TournamentSnapshotWire> {
    const tournament = await this.prisma.tournament.findUnique({ where: { id } });
    if (!tournament) throw new NotFoundException(`no tournament ${id}`);

    const matches = await this.prisma.match.findMany({ where: { tournamentId: id } });

    return TournamentSnapshotSchema.parse({
      id: tournament.id,
      name: tournament.name,
      state: tournament.state,
      matches: matches.map((m) => {
        const format = requireFormat(m.formatKey);
        const state = (m.state as unknown as MatchState | null) ?? emptyState();
        return { id: m.id, bracket: m.bracket, round: m.round, slot: m.slot, match: toBracketMatch(format, state) };
      }),
    });
  }
}
