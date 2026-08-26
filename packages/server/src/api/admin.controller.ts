import type { AdminGuildList as AdminGuildListWire, TournamentSummary } from '@itg/shared';
import { AdminGuildList as AdminGuildListSchema } from '@itg/shared';
import type { Tournament } from '@prisma/client';
import { Client } from 'discord.js';
import { Controller, ForbiddenException, Get, Inject } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { DISCORD_CLIENT } from '../discord/discord.tokens.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isBotAdmin } from '../services/admin-service.js';

function toSummary(t: Tournament): TournamentSummary {
  return { id: t.id, name: t.name, state: t.state, createdAt: t.createdAt.toISOString() };
}

/**
 * `GET /api/admin/guilds` — the Bot Administrator's one extra surface, per
 * DESIGN.md, "Everything else": every server the bot is in, with its
 * tournaments, and nothing else. Deployment-scoped (`isBotAdmin`), not a
 * per-guild tier, so unlike every other controller here this is a flat
 * 403 for anyone else — there's no "reveal nothing" shape to preserve, a
 * Bot Administrator either is or isn't one.
 */
@Controller('api/admin')
export class AdminController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(DISCORD_CLIENT) private readonly client: Client,
  ) {}

  @Get('guilds')
  async getGuilds(@CurrentUser() discordUserId: string | null): Promise<AdminGuildListWire> {
    if (!discordUserId || !(await isBotAdmin(this.prisma, discordUserId))) {
      throw new ForbiddenException('You need to be a bot administrator to see this.');
    }

    const guilds = [...this.client.guilds.cache.values()].map((g) => ({ id: g.id, name: g.name }));
    const tournaments = await this.prisma.tournament.findMany({
      where: { guildId: { in: guilds.map((g) => g.id) } },
      orderBy: { createdAt: 'desc' },
    });

    const byGuild = new Map<string, Tournament[]>();
    for (const t of tournaments) {
      const list = byGuild.get(t.guildId);
      if (list) list.push(t);
      else byGuild.set(t.guildId, [t]);
    }

    return AdminGuildListSchema.parse(
      guilds
        .map((g) => ({ guildId: g.id, guildName: g.name, tournaments: (byGuild.get(g.id) ?? []).map(toSummary) }))
        .sort((a, b) => a.guildName.localeCompare(b.guildName)),
    );
  }
}
