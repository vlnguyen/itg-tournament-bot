import { Module } from '@nestjs/common';
import { Client } from 'discord.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { createAlertAdapter } from './alert-adapter.js';
import { DiscordModule } from './discord.module.js';
import { DISCORD_CLIENT } from './discord.tokens.js';
import type { AlertPort, MatchChannelPort, PlayerNotificationPort } from './ports.js';
import { createMatchChannelAdapter } from './match-channel-adapter.js';
import { createPlayerNotificationAdapter } from './player-notification-adapter.js';

export const MATCH_CHANNEL_PORT = Symbol('MATCH_CHANNEL_PORT');
export const ALERT_PORT = Symbol('ALERT_PORT');
export const PLAYER_NOTIFICATION_PORT = Symbol('PLAYER_NOTIFICATION_PORT');

/**
 * The same three Discord adapters `DiscordBootstrapService` constructs for
 * the interaction/message-listener path, exposed as injectable providers
 * so the REST API's own write actions (referee overrides from the web
 * console) can call `applyAppendResult` too. "An override that is illegal
 * in the web UI is illegal from an alert-channel button" cuts both ways —
 * a legal one has the *same effects* regardless of which transport made
 * it, not a parallel path that skips the thread log or alert resolution.
 * `DiscordBootstrapService` keeps constructing its own copies rather than
 * importing this module — cheap, stateless factories, not worth risking a
 * regression in that already-verified boot path to deduplicate.
 */
@Module({
  imports: [PrismaModule, DiscordModule],
  providers: [
    { provide: MATCH_CHANNEL_PORT, useFactory: (client: Client, prisma: PrismaService): MatchChannelPort => createMatchChannelAdapter(client, prisma), inject: [DISCORD_CLIENT, PrismaService] },
    { provide: ALERT_PORT, useFactory: (client: Client, prisma: PrismaService): AlertPort => createAlertAdapter(client, prisma), inject: [DISCORD_CLIENT, PrismaService] },
    {
      provide: PLAYER_NOTIFICATION_PORT,
      useFactory: (client: Client, prisma: PrismaService): PlayerNotificationPort => createPlayerNotificationAdapter(client, prisma),
      inject: [DISCORD_CLIENT, PrismaService],
    },
  ],
  exports: [MATCH_CHANNEL_PORT, ALERT_PORT, PLAYER_NOTIFICATION_PORT],
})
export class DiscordAdaptersModule {}
