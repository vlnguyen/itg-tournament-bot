import type { PlayerPage as PlayerPageWire } from '@itg/shared';
import { PlayerPage as PlayerPageSchema } from '@itg/shared';
import { Controller, Get, Header, Inject, NotFoundException, Param } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { getPlayerPage } from '../services/player-service.js';

/**
 * `GET /api/guilds/:guildId/players/:discordUserId` — DESIGN.md, "Player
 * pages". `X-Robots-Tag: noindex` on every response: the page stays fully
 * public and linkable, it's simply not surfaced by a name search — "an
 * event is worth finding by search... entering a tournament is not
 * consent to [ranking for your name and enumerating every match you
 * lost]." A header, not a meta tag, so it holds for this JSON response
 * too, not only the HTML the client renders from it.
 */
@Controller('api/guilds')
export class PlayersController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get(':guildId/players/:discordUserId')
  @Header('X-Robots-Tag', 'noindex')
  async getPlayer(@Param('guildId') guildId: string, @Param('discordUserId') discordUserId: string): Promise<PlayerPageWire> {
    const page = await getPlayerPage(this.prisma, guildId, discordUserId);
    if (!page) throw new NotFoundException(`no player ${discordUserId} in guild ${guildId}`);
    return PlayerPageSchema.parse(page);
  }
}
