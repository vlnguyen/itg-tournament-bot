import type { LifecycleStatus as LifecycleStatusWire } from '@itg/shared';
import { LifecycleRequest, LifecycleStatus as LifecycleStatusSchema } from '@itg/shared';
import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post } from '@nestjs/common';
import { ZodError } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { TierService } from '../auth/tier.service.js';
import { ALERT_PORT, MATCH_CHANNEL_PORT, PLAYER_NOTIFICATION_PORT } from '../discord/discord-adapters.module.js';
import { logToOrganizers } from '../discord/commands/organizer-log.js';
import type { AlertPort, MatchChannelPort, PlayerNotificationPort } from '../discord/ports.js';
import { Tier } from '../discord/tier.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  cancelTournament,
  closeCheckin,
  closeRegistration,
  getLifecycleStatus,
  openCheckin,
  openRegistration,
  renameTournament,
  TournamentTransitionError,
} from '../services/tournament-service.js';

/**
 * `GET`/`POST /api/tournaments/:id/lifecycle` — DESIGN.md's tournament
 * configuration panel. Tournament Organizer tier, same as `/tournament`
 * itself. Every action here calls the *exact same* service function
 * `discord/commands/tournament.ts` calls, then replicates that command's
 * own Discord-side effects (the announcement, the alert-channel log line,
 * closing a cancelled match's thread) through the same ports the REST
 * ruling endpoint already uses — so a lifecycle change made from the
 * console and one made from `/tournament` post identical records. `START`
 * is not an action here; see `LifecycleRequest`'s comment in `@itg/shared`.
 */
@Controller('api/tournaments')
export class LifecycleController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TierService) private readonly tierService: TierService,
    @Inject(MATCH_CHANNEL_PORT) private readonly matchChannel: MatchChannelPort,
    @Inject(ALERT_PORT) private readonly alert: AlertPort,
    @Inject(PLAYER_NOTIFICATION_PORT) private readonly playerNotification: PlayerNotificationPort,
  ) {}

  private async requireOrganizer(tournamentId: string, discordUserId: string | null): Promise<{ guildId: string }> {
    const tournament = await this.prisma.tournament.findUnique({ where: { id: tournamentId } });
    if (!tournament) throw new NotFoundException(`no tournament ${tournamentId}`);

    if (!discordUserId || !(await this.tierService.hasTier(tournament.guildId, discordUserId, Tier.TOURNAMENT_ORGANIZER))) {
      throw new ForbiddenException('You need Tournament Organizer tier to manage this tournament.');
    }
    return { guildId: tournament.guildId };
  }

  @Get(':id/lifecycle')
  async getStatus(@Param('id') id: string, @CurrentUser() discordUserId: string | null): Promise<LifecycleStatusWire> {
    await this.requireOrganizer(id, discordUserId);
    return LifecycleStatusSchema.parse(await getLifecycleStatus(this.prisma, id));
  }

  @Post(':id/lifecycle')
  async postAction(@Param('id') id: string, @Body() body: unknown, @CurrentUser() discordUserId: string | null): Promise<LifecycleStatusWire> {
    const { guildId } = await this.requireOrganizer(id, discordUserId);

    let request: LifecycleRequest;
    try {
      request = LifecycleRequest.parse(body);
    } catch (err) {
      if (err instanceof ZodError) throw new BadRequestException(err.issues);
      throw err;
    }

    const actorName = await this.tierService.resolveDisplayName(guildId, discordUserId!);
    try {
      await this.applyAction(guildId, id, request, discordUserId!, actorName);
    } catch (err) {
      if (err instanceof TournamentTransitionError) throw new BadRequestException(`Can't do that — ${err.reason}.`);
      throw err;
    }

    return LifecycleStatusSchema.parse(await getLifecycleStatus(this.prisma, id));
  }

  private async applyAction(
    guildId: string,
    tournamentId: string,
    request: LifecycleRequest,
    actorId: string,
    actorName: string,
  ): Promise<void> {
    switch (request.action) {
      case 'OPEN_REGISTRATION': {
        const t = await openRegistration(this.prisma, tournamentId, actorId);
        await this.log(guildId, actorName, `Registration is open for **${t.name}** — \`/join\` now works.`);
        await this.playerNotification.registrationOpened(guildId, t.name);
        return;
      }
      case 'CLOSE_REGISTRATION': {
        const t = await closeRegistration(this.prisma, tournamentId, actorId);
        await this.log(guildId, actorName, `Registration is closed for **${t.name}**.`);
        return;
      }
      case 'OPEN_CHECKIN': {
        const t = await openCheckin(this.prisma, tournamentId, actorId);
        const registered = await this.prisma.entrant.findMany({
          where: { tournamentId, status: 'ACTIVE' },
          select: { discordUserId: true },
        });
        const { unreachable } = await this.playerNotification.checkinOpened(
          guildId,
          t.name,
          registered.map((e) => e.discordUserId),
        );
        const suffix = unreachable.length > 0 ? ` ⚠️ Could not DM: ${unreachable.join(', ')}.` : '';
        await this.log(guildId, actorName, `Check-in is open for **${t.name}** — registered players have been notified.${suffix}`);
        return;
      }
      case 'CLOSE_CHECKIN': {
        const t = await closeCheckin(this.prisma, tournamentId, actorId);
        await this.log(guildId, actorName, `Check-in is closed for **${t.name}**.`);
        await this.playerNotification.checkinClosed(guildId, t.name);
        return;
      }
      case 'CANCEL': {
        const result = await cancelTournament(this.prisma, tournamentId, actorId);
        await this.closeCancelledThreads(result.cancelledMatchIds);
        const suffix = result.cancelledMatchIds.length > 0 ? ` ⚠️ ${result.cancelledMatchIds.length} in-progress match(es) were cancelled.` : '';
        await this.log(guildId, actorName, `**${result.tournament.name}** is cancelled.${suffix}`);
        await this.playerNotification.tournamentCancelled(guildId, result.tournament.name);
        return;
      }
      case 'RENAME': {
        const t = await renameTournament(this.prisma, tournamentId, request.name, actorId);
        await this.log(guildId, actorName, `Renamed to **${t.name}**.`);
        return;
      }
    }
  }

  /** Same close-the-thread sequence `handleCancel` runs — a note, a cleared prompt, then archived. */
  private async closeCancelledThreads(cancelledMatchIds: string[]): Promise<void> {
    if (cancelledMatchIds.length === 0) return;
    const withThreads = await this.prisma.match.findMany({
      where: { id: { in: cancelledMatchIds }, threadId: { not: null } },
      select: { id: true, threadId: true },
    });
    for (const m of withThreads) {
      const ref = { matchId: m.id, threadId: m.threadId! };
      await this.matchChannel.postLogMessage(ref, { content: '⚠️ This tournament has been cancelled. This match will not be completed.' });
      await this.matchChannel.postMatchState(ref, { content: 'This match has been cancelled — no further action is possible.' });
      await this.matchChannel.archiveThread(ref);
    }
  }

  private async log(guildId: string, actorName: string, description: string): Promise<void> {
    await logToOrganizers(this.alert, guildId, `📋 **${actorName}** (web): ${description}`);
  }
}
