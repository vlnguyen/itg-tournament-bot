import type { LifecycleStatus as LifecycleStatusWire } from '@itg/shared';
import { LifecycleRequest, LifecycleStatus as LifecycleStatusSchema, plural } from '@itg/shared';
import { EmbedBuilder, type Client } from 'discord.js';
import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post } from '@nestjs/common';
import { ZodError } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { TierService } from '../auth/tier.service.js';
import { ALERT_PORT, MATCH_CHANNEL_PORT, PLAYER_NOTIFICATION_PORT } from '../discord/discord-adapters.module.js';
import { DISCORD_CLIENT } from '../discord/discord.tokens.js';
import { LOG_COLOR } from '../discord/render/draw.js';
import { logToOrganizers } from '../discord/commands/organizer-log.js';
import { linkifyTournamentName } from '../web-url.js';
import type { AlertPort, MatchChannelPort, PlayerNotificationPort } from '../discord/ports.js';
import { REALTIME_PORT } from '../realtime/realtime.tokens.js';
import { startTournamentWithDiscordEffects } from '../discord/start-tournament-effects.js';
import { Tier } from '../discord/tier.js';
import { cryptoRandomPort } from '../services/ports.js';
import type { RealtimeBroadcastPort } from '../services/ports.js';
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
 * itself. Every action here calls the *exact same* service function (or,
 * for `START`, the same `startTournamentWithDiscordEffects`)
 * `discord/commands/tournament.ts` calls, then replicates that command's
 * own Discord-side effects (the announcement, the alert-channel log line,
 * closing a cancelled match's thread) through the same ports the REST
 * ruling endpoint already uses — so a lifecycle change made from the
 * console and one made from `/tournament` post identical records.
 */
@Controller('api/tournaments')
export class LifecycleController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TierService) private readonly tierService: TierService,
    @Inject(MATCH_CHANNEL_PORT) private readonly matchChannel: MatchChannelPort,
    @Inject(ALERT_PORT) private readonly alert: AlertPort,
    @Inject(PLAYER_NOTIFICATION_PORT) private readonly playerNotification: PlayerNotificationPort,
    @Inject(DISCORD_CLIENT) private readonly client: Client,
    @Inject(REALTIME_PORT) private readonly realtime: RealtimeBroadcastPort,
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
    // One call covers every action below — a lifecycle change made here
    // needs to reach any other browser (or Discord-side re-check) watching
    // this tournament, the same way a Discord-originated change now does.
    this.realtime.publishLifecycleChanged(id);

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
        await this.log(guildId, actorName, linkifyTournamentName(`Registration is open for **${t.name}** — \`/join\` now works.`, t.name, t.id), LOG_COLOR.REGISTRATION_OPEN);
        await this.playerNotification.registrationOpened(guildId, t.id, t.name);
        return;
      }
      case 'CLOSE_REGISTRATION': {
        const t = await closeRegistration(this.prisma, tournamentId, actorId);
        await this.log(guildId, actorName, linkifyTournamentName(`Registration is closed for **${t.name}**.`, t.name, t.id));
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
        await this.log(
          guildId,
          actorName,
          linkifyTournamentName(`Check-in is open for **${t.name}** — registered players have been notified.${suffix}`, t.name, t.id),
          LOG_COLOR.TOURNAMENT_STARTING,
        );
        return;
      }
      case 'CLOSE_CHECKIN': {
        const t = await closeCheckin(this.prisma, tournamentId, actorId);
        await this.log(guildId, actorName, linkifyTournamentName(`Check-in is closed for **${t.name}**.`, t.name, t.id), LOG_COLOR.CHECKIN_CLOSED);
        await this.playerNotification.checkinClosed(guildId, t.id, t.name);
        return;
      }
      case 'START': {
        const guildRow = await this.prisma.guild.findUnique({ where: { id: guildId } });
        if (!guildRow) throw new BadRequestException("This server isn't configured yet — run /setup.");

        const guild = this.client.guilds.cache.get(guildId) ?? (await this.client.guilds.fetch(guildId).catch(() => null));
        if (!guild) throw new BadRequestException("The bot isn't in this server anymore.");

        const outcome = await startTournamentWithDiscordEffects(
          {
            prisma: this.prisma,
            random: cryptoRandomPort,
            matchChannel: this.matchChannel,
            playerNotification: this.playerNotification,
            alert: this.alert,
            client: this.client,
            realtime: this.realtime,
          },
          guild,
          guildRow,
          tournamentId,
          actorId,
        );
        if (outcome.kind === 'BLOCKED') throw new BadRequestException(outcome.message);
        if (outcome.kind === 'TRANSITION_ERROR') throw new TournamentTransitionError(tournamentId, outcome.reason);

        const lines = [`🏁 **${outcome.tournament.name}** has started — ${plural(outcome.threads.length, 'match thread', 'match threads')} created.`];
        if (outcome.packSizeWarning) {
          lines.push(`⚠️ The chart pack has only ${plural(outcome.packSizeWarning.actual, 'chart', 'charts')}; ${outcome.packSizeWarning.recommended}+ is recommended.`);
        }
        if (outcome.refereePoolEmpty) {
          lines.push('⚠️ Nobody holds a role at Referee tier or above yet — a dispute has nobody to rule on it.');
        }
        if (outcome.holdsTierRole.length > 0) {
          lines.push(`⚠️ These entrants also hold a tier role: ${outcome.holdsTierRole.join(', ')}.`);
        }
        await this.log(guildId, actorName, linkifyTournamentName(lines.join(' '), outcome.tournament.name, outcome.tournament.id), LOG_COLOR.TOURNAMENT_STARTED);
        await this.playerNotification.tournamentStarted(guildId, outcome.tournament.id, outcome.tournament.name);
        // Starting drops no-shows and collapses seeds — a real roster
        // change a seeding page held open elsewhere needs to hear about.
        this.realtime.publishRosterChanged(tournamentId);
        return;
      }
      case 'CANCEL': {
        const result = await cancelTournament(this.prisma, tournamentId, actorId);
        await this.closeCancelledThreads(result.cancelledMatchIds);
        const suffix =
          result.cancelledMatchIds.length > 0
            ? ` ⚠️ ${plural(result.cancelledMatchIds.length, 'in-progress match', 'in-progress matches')} were cancelled.`
            : '';
        await this.log(
          guildId,
          actorName,
          linkifyTournamentName(`**${result.tournament.name}** is cancelled.${suffix}`, result.tournament.name, result.tournament.id),
          LOG_COLOR.GENERAL_TOURNAMENT_CANCELLED,
        );
        await this.playerNotification.tournamentCancelled(guildId, result.tournament.id, result.tournament.name);
        return;
      }
      case 'RENAME': {
        const t = await renameTournament(this.prisma, tournamentId, request.name, actorId);
        await this.log(guildId, actorName, linkifyTournamentName(`Renamed to **${t.name}**.`, t.name, t.id));
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
      await this.matchChannel.postLogMessage(ref, {
        embeds: [new EmbedBuilder().setColor(LOG_COLOR.TOURNAMENT_CANCELLED).setDescription('⚠️ This tournament has been cancelled. This match will not be completed.')],
      });
      await this.matchChannel.postMatchState(ref, {
        embeds: [new EmbedBuilder().setColor(LOG_COLOR.TOURNAMENT_CANCELLED).setDescription('⚠️ This match has been cancelled — no further action is possible.')],
      });
      await this.matchChannel.archiveThread(ref);
    }
  }

  /** `color` matches this transition's own public-facing announcement, where one exists — same reasoning as `runTransition`'s Discord-side counterpart (`commands/tournament.ts`). */
  private async log(guildId: string, actorName: string, description: string, color?: number): Promise<void> {
    await logToOrganizers(this.alert, guildId, `📋 **${actorName}** (web): ${description}`, { color });
  }
}
