import type { ChartSnapshot as ChartSnapshotWire } from '@itg/shared';
import { canImportPack, ChartImport, ChartSnapshot as ChartSnapshotSchema } from '@itg/shared';
import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post } from '@nestjs/common';
import { ZodError } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { TierService } from '../auth/tier.service.js';
import { Tier } from '../discord/tier.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * `GET`/`POST /api/tournaments/:id/charts` — the read half of "the pack
 * tab" (public, no auth) and the write half of "client-side song pack
 * parsing" (organizer only). See DESIGN.md, "The Song Pack" and
 * "Client-Side Song Pack Parsing": "Simfiles never reach the server...
 * the server re-validates against the same shared zod schema and
 * persists. The parser is shared code, but this step is not optional —
 * the client fully controls that payload." `ChartImport` is exactly that
 * re-validation; nothing here trusts the client's own client-side
 * validation or dedupe pass.
 */
@Controller('api/tournaments')
export class ChartsController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TierService) private readonly tierService: TierService,
  ) {}

  @Get(':id/charts')
  async getCharts(@Param('id') id: string): Promise<ChartSnapshotWire[]> {
    const tournament = await this.prisma.tournament.findUnique({ where: { id } });
    if (!tournament) throw new NotFoundException(`no tournament ${id}`);

    const charts = await this.prisma.chart.findMany({ where: { tournamentId: id } });
    return charts.map((c) => ChartSnapshotSchema.parse({ ...c, chartId: c.id }));
  }

  @Post(':id/charts')
  async importCharts(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() discordUserId: string | null,
  ): Promise<{ imported: number }> {
    const tournament = await this.prisma.tournament.findUnique({ where: { id } });
    if (!tournament) throw new NotFoundException(`no tournament ${id}`);

    if (!discordUserId || !(await this.tierService.hasTier(tournament.guildId, discordUserId, Tier.TOURNAMENT_ORGANIZER))) {
      throw new ForbiddenException('You need Tournament Organizer tier to import charts.');
    }

    if (!canImportPack(tournament.state)) {
      throw new BadRequestException(`Can't import a pack — the tournament is already ${tournament.state}.`);
    }

    // Re-validated here regardless of whatever the browser's own parser/
    // preview pass already checked — "the client fully controls that
    // payload." A malformed request is a 400, not a 500 or a row that
    // silently fails Prisma's own stricter typing.
    let charts: ChartImport['charts'];
    try {
      charts = ChartImport.parse(body).charts;
    } catch (err) {
      if (err instanceof ZodError) throw new BadRequestException(err.issues);
      throw err;
    }

    await this.prisma.chart.createMany({
      data: charts.map((c) => ({ tournamentId: id, ...c })),
    });
    return { imported: charts.length };
  }
}
