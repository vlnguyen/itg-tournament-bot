import type { Standings as StandingsWire, TournamentSnapshot as TournamentSnapshotWire } from '@itg/shared';
import { Standings as StandingsSchema, TournamentSnapshot as TournamentSnapshotSchema } from '@itg/shared';
import { Controller, Get, Inject, NotFoundException, Param } from '@nestjs/common';
import { entrantDisplayNamesForTournament } from './entrant-names.js';
import { toBracketMatch } from '../domain/projection.js';
import { emptyState } from '../domain/types.js';
import type { MatchState } from '../domain/types.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { entrantCountAtStart, requireFormat } from '../services/engine.js';
import { computeTournamentStandings } from '../services/advancement-service.js';

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

    const [matches, entrantCount, names] = await Promise.all([
      this.prisma.match.findMany({ where: { tournamentId: id } }),
      entrantCountAtStart(this.prisma, id),
      entrantDisplayNamesForTournament(this.prisma, id),
    ]);

    return TournamentSnapshotSchema.parse({
      id: tournament.id,
      name: tournament.name,
      state: tournament.state,
      entrantCount,
      matches: matches.map((m) => {
        const format = requireFormat(m.formatKey);
        const state = (m.state as unknown as MatchState | null) ?? emptyState();
        const bracketMatch = toBracketMatch(format, state);
        return {
          id: m.id,
          bracket: m.bracket,
          round: m.round,
          slot: m.slot,
          match: {
            ...bracketMatch,
            participants: bracketMatch.participants.map((p) => ({ ...p, displayName: names.get(p.entrantId) ?? p.entrantId })),
          },
        };
      }),
    });
  }

  /**
   * `GET /api/tournaments/:id/standings` — DESIGN.md, "Standings":
   * "Derived from elimination depth, never stored." Reuses
   * `computeTournamentStandings` directly, the same source the Discord
   * announcement already uses — so they can't disagree. Empty until the
   * tournament has a decided outcome (`computeTournamentStandings`
   * returns `[]` with no completed decider match).
   */
  @Get(':id/standings')
  async getStandings(@Param('id') id: string): Promise<StandingsWire> {
    const tournament = await this.prisma.tournament.findUnique({ where: { id } });
    if (!tournament) throw new NotFoundException(`no tournament ${id}`);

    const rows = await computeTournamentStandings(this.prisma, id);
    return StandingsSchema.parse(rows.map((r) => ({ ...r, displayName: r.displayName ?? r.entrantId })));
  }
}
