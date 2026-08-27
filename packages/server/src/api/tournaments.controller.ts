import type { RunView as RunViewWire, Standings as StandingsWire, TournamentSnapshot as TournamentSnapshotWire } from '@itg/shared';
import { RunView as RunViewSchema, Standings as StandingsSchema, TournamentSnapshot as TournamentSnapshotSchema } from '@itg/shared';
import type { Client } from 'discord.js';
import { Controller, ForbiddenException, Get, Inject, NotFoundException, Param } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { TierService } from '../auth/tier.service.js';
import { DISCORD_CLIENT } from '../discord/discord.tokens.js';
import { Tier } from '../discord/tier.js';
import { entrantDisplayNamesForTournament } from './entrant-names.js';
import { toBracketMatch } from '../domain/projection.js';
import { emptyState } from '../domain/types.js';
import type { MatchState } from '../domain/types.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { entrantCountAtStart, requireFormat } from '../services/engine.js';
import { computeTournamentStandings } from '../services/advancement-service.js';
import { getRunView } from '../services/run-view-service.js';

/**
 * `GET /api/tournaments/:id` — the bracket snapshot, DESIGN.md's "resync
 * fetch": on first load or reconnect, the client fetches this and then
 * applies websocket frames on top, dropping any whose `seq` isn't newer
 * than what it already has. `toBracketMatch` (not `toPublicMatch`) per
 * match, deliberately — see the schema's own comment for why.
 */
@Controller('api/tournaments')
export class TournamentsController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TierService) private readonly tierService: TierService,
    @Inject(DISCORD_CLIENT) private readonly client: Client,
  ) {}

  @Get(':id')
  async getTournament(@Param('id') id: string): Promise<TournamentSnapshotWire> {
    const tournament = await this.prisma.tournament.findUnique({ where: { id } });
    if (!tournament) throw new NotFoundException(`no tournament ${id}`);

    const [matches, entrantCount, names] = await Promise.all([
      this.prisma.match.findMany({ where: { tournamentId: id } }),
      entrantCountAtStart(this.prisma, id),
      entrantDisplayNamesForTournament(this.prisma, id),
    ]);

    // `Guild` rows carry no cached name — resolved live from the bot's
    // own client, same source `TierService.guildsFor` already trusts.
    const guild = this.client.guilds.cache.get(tournament.guildId);

    return TournamentSnapshotSchema.parse({
      id: tournament.id,
      name: tournament.name,
      state: tournament.state,
      guildId: tournament.guildId,
      guildName: guild?.name ?? tournament.guildId,
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

  /**
   * `GET /api/tournaments/:id/run-view` — DESIGN.md's organizer console:
   * "used by both tiers." Referee-gated, same threshold `POST
   * /api/matches/:id/rulings` uses, since this is the console's own read
   * path rather than anything a spectator sees.
   */
  @Get(':id/run-view')
  async getRunView(@Param('id') id: string, @CurrentUser() discordUserId: string | null): Promise<RunViewWire> {
    const tournament = await this.prisma.tournament.findUnique({ where: { id } });
    if (!tournament) throw new NotFoundException(`no tournament ${id}`);

    if (!discordUserId || !(await this.tierService.hasTier(tournament.guildId, discordUserId, Tier.REFEREE))) {
      throw new ForbiddenException('You need Referee tier to view the run view.');
    }

    const runView = await getRunView(this.prisma, id);
    return RunViewSchema.parse(runView);
  }
}
