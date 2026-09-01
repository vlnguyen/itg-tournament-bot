import type { PublicMatch as PublicMatchWire } from '@itg/shared';
import { PublicMatch as PublicMatchSchema } from '@itg/shared';
import { Controller, Get, Inject, NotFoundException, Param } from '@nestjs/common';
import { entrantDisplayNames } from './entrant-names.js';
import { toPublicMatch } from '../domain/projection.js';
import { emptyState } from '../domain/types.js';
import type { MatchState } from '../domain/types.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { requireFormat } from '../services/engine.js';

/**
 * `GET /api/matches/:id` — DESIGN.md's public match detail: "the Draw, the
 * full Protect/Veto sequence, per-song EX% and winners, tiebreak rounds,
 * final result." `toPublicMatch` is the one function allowed to turn
 * `MatchState` into anything a browser sees; this controller's only job is
 * loading the state and validating the result against the shared wire
 * schema before it leaves the process.
 */
@Controller('api/matches')
export class MatchesController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get(':id')
  async getMatch(@Param('id') id: string): Promise<PublicMatchWire> {
    const match = await this.prisma.match.findUnique({ where: { id } });
    if (!match) throw new NotFoundException(`no match ${id}`);

    const format = requireFormat(match.formatKey);
    const state = (match.state as unknown as MatchState | null) ?? emptyState();
    const pub = toPublicMatch(format, state);
    const names = await entrantDisplayNames(
      this.prisma,
      pub.participants.map((p) => p.entrantId),
    );

    return PublicMatchSchema.parse({
      ...pub,
      bracket: match.bracket,
      round: match.round,
      slot: match.slot,
      participants: pub.participants.map((p) => ({ ...p, displayName: names.get(p.entrantId) ?? p.entrantId })),
    });
  }
}
