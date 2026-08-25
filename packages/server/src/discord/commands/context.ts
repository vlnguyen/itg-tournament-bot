import type { Client } from 'discord.js';
import type { PrismaClient } from '@prisma/client';
import type { RandomPort } from '../../services/ports.js';
import type { AlertPort, MatchChannelPort, PlayerNotificationPort } from '../ports.js';

/** Everything a slash-command handler needs, bundled once at boot rather than threaded argument by argument. */
export interface CommandContext {
  client: Client;
  prisma: PrismaClient;
  random: RandomPort;
  matchChannel: MatchChannelPort;
  playerNotification: PlayerNotificationPort;
  alert: AlertPort;
}
