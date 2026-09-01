import type { PublicMatch as PublicMatchWire } from '@itg/shared';
import { PublicMatch as PublicMatchSchema, RulingRequest } from '@itg/shared';
import { BadRequestException, Body, Controller, ForbiddenException, Inject, NotFoundException, Param, Post } from '@nestjs/common';
import { ZodError } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { TierService } from '../auth/tier.service.js';
import { entrantDisplayNames } from './entrant-names.js';
import { toPublicMatch } from '../domain/projection.js';
import type { EntrantId, MatchEvent, MatchState } from '../domain/types.js';
import { Tier } from '../discord/tier.js';
import { ALERT_PORT, MATCH_CHANNEL_PORT, PLAYER_NOTIFICATION_PORT } from '../discord/discord-adapters.module.js';
import { REALTIME_PORT } from '../realtime/realtime.tokens.js';
import { logToOrganizers, matchLinksBlock } from '../discord/commands/organizer-log.js';
import { compactChartLabel } from '../discord/render/chart.js';
import { LOG_COLOR } from '../discord/render/draw.js';
import { buildResolvedAlert } from '../discord/render/escalation.js';
import { renderDqLog, renderResetLog, renderRulingLog, renderSetRulingLog } from '../discord/log-messages.js';
import { applyAppendResult, CANCELLED_MATCH_MESSAGE, describeStale } from '../discord/match-event-effects.js';
import { buildPlayerDirectory, loadMatch, type MatchWithParticipants } from '../discord/match-lookup.js';
import type { AlertPort, MatchChannelPort, PlayerNotificationPort, ThreadRef } from '../discord/ports.js';
import { displayName } from '../discord/state-message.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { requireFormat } from '../services/engine.js';
import { appendMatchEvent, IllegalActionError, type AppendResult } from '../services/match-service.js';
import type { RealtimeBroadcastPort } from '../services/ports.js';
import { cryptoRandomPort } from '../services/ports.js';

/**
 * `POST /api/matches/:id/rulings` — DESIGN.md's route table: "Referee
 * overrides, guarded by the freeze predicate." Runs every ruling through
 * the exact same `appendMatchEvent` → `applyAppendResult` pipeline as
 * `discord/commands/rulings.ts` and the ruling buttons in `interactions.ts`
 * — same validation, same thread log, same alert resolution, same
 * realtime broadcast — so a ruling made from the console and one made
 * from the alert channel are indistinguishable in their effects, only in
 * which surface an organizer happened to be looking at.
 */
@Controller('api/matches')
export class RulingsController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TierService) private readonly tierService: TierService,
    @Inject(MATCH_CHANNEL_PORT) private readonly matchChannel: MatchChannelPort,
    @Inject(ALERT_PORT) private readonly alert: AlertPort,
    @Inject(PLAYER_NOTIFICATION_PORT) private readonly playerNotification: PlayerNotificationPort,
    @Inject(REALTIME_PORT) private readonly realtime: RealtimeBroadcastPort,
  ) {}

  @Post(':id/rulings')
  async rule(@Param('id') matchId: string, @Body() body: unknown, @CurrentUser() discordUserId: string | null): Promise<PublicMatchWire> {
    const match = await loadMatch(this.prisma, matchId);
    if (!match) throw new NotFoundException(`no match ${matchId}`);
    if (match.status === 'CANCELLED') throw new BadRequestException(CANCELLED_MATCH_MESSAGE);

    if (!discordUserId || !(await this.tierService.hasTier(match.tournament.guildId, discordUserId, Tier.REFEREE))) {
      throw new ForbiddenException('You need Referee tier to rule on this match.');
    }

    let ruling: RulingRequest;
    try {
      ruling = RulingRequest.parse(body);
    } catch (err) {
      if (err instanceof ZodError) throw new BadRequestException(err.issues);
      throw err;
    }

    const refName = await this.tierService.resolveDisplayName(match.tournament.guildId, discordUserId);
    const players = buildPlayerDirectory(match);
    const ref: ThreadRef = { matchId: match.id, threadId: match.threadId! };
    const format = requireFormat(match.formatKey);

    try {
      const { event, result } = await this.applyRuling(match, ruling, discordUserId);
      await this.logRuling(match, ruling, result.state, players, ref, refName);
      await applyAppendResult(this.prisma, this.matchChannel, this.alert, this.playerNotification, this.realtime, match, format, event, result);

      const pub = toPublicMatch(format, result.state);
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
    } catch (err) {
      if (err instanceof IllegalActionError) throw new BadRequestException(`Can't rule on that: ${describeStale(err)}.`);
      throw err;
    }
  }

  private rulingEvent(ruling: RulingRequest, discordUserId: string): Omit<MatchEvent, 'seq'> {
    switch (ruling.type) {
      case 'SONG_RULED':
        return { actorId: discordUserId, type: 'SONG_RULED', payload: { songIndex: ruling.songIndex, result: ruling.result } };
      case 'PROTECT_VETO_RESET':
        return { actorId: discordUserId, type: 'PROTECT_VETO_RESET', payload: { reason: ruling.reason } };
      case 'SET_RESULT_RULED':
        return { actorId: discordUserId, type: 'SET_RESULT_RULED', payload: { result: ruling.result } };
      case 'DQ_APPLIED':
        return { actorId: discordUserId, type: 'DQ_APPLIED', payload: { playerId: ruling.playerId, scope: 'MATCH' } };
    }
  }

  private async applyRuling(
    match: MatchWithParticipants,
    ruling: RulingRequest,
    discordUserId: string,
  ): Promise<{ event: Omit<MatchEvent, 'seq'>; result: AppendResult }> {
    const event = this.rulingEvent(ruling, discordUserId);
    const result = await appendMatchEvent(this.prisma, cryptoRandomPort, match.id, event);
    return { event, result };
  }

  /** Same permanent log line + alert resolution Discord's own ruling buttons post — see `interactions.ts`'s `handleRulingButton` and `rulings.ts`'s `handleMatchScopeDq`. */
  private async logRuling(
    match: MatchWithParticipants,
    ruling: RulingRequest,
    afterState: MatchState,
    players: ReturnType<typeof buildPlayerDirectory>,
    ref: ThreadRef,
    refName: string,
  ): Promise<void> {
    if (ruling.type === 'SONG_RULED') {
      const chart = afterState.songs[ruling.songIndex]!.chart;
      await this.matchChannel.postLogMessage(ref, renderRulingLog(ruling.songIndex, chart, ruling.result, refName, players));
      const outcome =
        ruling.result === 'VOID' ? 'voided' : ruling.result === 'TIE' ? 'ruled a tie' : `awarded to ${displayName(players, ruling.result)}`;
      await this.resolveAlertIfOpen(match, refName, outcome, ruling.songIndex);

      const alertOutcome =
        ruling.result === 'VOID' ? 'voided' : ruling.result === 'TIE' ? 'ruled a tie' : `awarded to **${displayName(players, ruling.result)}**`;
      await logToOrganizers(
        this.alert,
        match.tournament.guildId,
        `Song ${ruling.songIndex + 1} (${compactChartLabel(chart)}) ${alertOutcome}, ruling by **${refName}**\n\n${matchLinksBlock(match.tournament.guildId, ref, match.tournamentId)}`,
        { title: '⚖️ Song resolution', color: LOG_COLOR.RULING },
      );
    } else if (ruling.type === 'PROTECT_VETO_RESET') {
      await this.matchChannel.postLogMessage(ref, renderResetLog(refName));
    } else if (ruling.type === 'SET_RESULT_RULED') {
      await this.resolveAlertIfOpen(match, refName, `awarded the set to ${displayName(players, ruling.result)}`, undefined);
      await this.matchChannel.postLogMessage(ref, renderSetRulingLog(ruling.result as EntrantId, refName, players));
      await logToOrganizers(
        this.alert,
        match.tournament.guildId,
        `Set result awarded to **${displayName(players, ruling.result)}**, ruling by **${refName}**\n\n${matchLinksBlock(match.tournament.guildId, ref, match.tournamentId)}`,
        { title: '⚖️ Set resolution', color: LOG_COLOR.RULING },
      );
    } else {
      await this.matchChannel.postLogMessage(ref, renderDqLog(ruling.playerId as EntrantId, 'MATCH', refName, players));
    }
  }

  /**
   * The original escalation reason (winner disagreement vs. settings
   * violation) isn't tracked once resolution reaches this far — only
   * `match.alertMsgId` says "this was escalated." Song-level defaults to
   * `WINNER_DISAGREEMENT`, the far more common case; a set-level
   * disagreement is unambiguous, since it's the only reason without a
   * `songIndex`.
   */
  private async resolveAlertIfOpen(match: MatchWithParticipants, refName: string, outcome: string, songIndex: number | undefined): Promise<void> {
    if (!match.alertMsgId) return;
    const players = buildPlayerDirectory(match);
    const threadLink = `https://discord.com/channels/${match.tournament.guildId}/${match.threadId}`;
    const [p0, p1] = match.participants;
    const escalationPlayers: readonly [{ entrantId: EntrantId; name: string }, { entrantId: EntrantId; name: string }] = [
      { entrantId: p0!.entrantId, name: displayName(players, p0!.entrantId) },
      { entrantId: p1!.entrantId, name: displayName(players, p1!.entrantId) },
    ];
    const reason = songIndex === undefined ? 'SET_RESULT_DISAGREEMENT' : 'WINNER_DISAGREEMENT';
    await this.alert.resolve(
      match.tournament.guildId,
      { messageId: match.alertMsgId },
      buildResolvedAlert(match.id, songIndex, reason, threadLink, match.tournamentId, escalationPlayers, refName, outcome),
    );
    await this.prisma.match.update({ where: { id: match.id }, data: { alertMsgId: null } });
  }
}
