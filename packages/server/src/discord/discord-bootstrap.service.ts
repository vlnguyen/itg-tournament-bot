import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Client, Events } from 'discord.js';
import { plural } from '@itg/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { REALTIME_PORT } from '../realtime/realtime.tokens.js';
import { cryptoRandomPort } from '../services/ports.js';
import type { RealtimeBroadcastPort } from '../services/ports.js';
import { createAlertAdapter } from './alert-adapter.js';
import { loginDiscordClient } from './client.js';
import { DISCORD_CLIENT } from './discord.tokens.js';
import { registerCommandsForAllGuilds, registerGuildCommands } from './commands/register.js';
import { registerInteractionHandlers } from './interactions.js';
import { createMatchChannelAdapter } from './match-channel-adapter.js';
import { registerMessageListener } from './message-listener.js';
import { createPlayerNotificationAdapter } from './player-notification-adapter.js';
import { parseAdminDiscordIds, syncConfigAdmins } from '../services/admin-service.js';

/**
 * The bot bootstrap sequence, unchanged from the pre-Nest `main.ts` — this
 * class only relocates it behind the application lifecycle so a later
 * ApiModule can share the same Nest process. `onApplicationBootstrap` (not
 * `onModuleInit`) so every module has finished wiring before the client
 * logs in and starts dispatching.
 */
@Injectable()
export class DiscordBootstrapService implements OnApplicationBootstrap, OnModuleDestroy {
  constructor(
    // Both params explicit @Inject — an undecorated param mixed with a
    // decorated one silently resolves to `undefined` under this project's
    // esbuild/tsx toolchain (see the same fix in TierService), and unlike
    // there, Nest didn't even throw at boot: it just left `this.prisma`
    // unset, so every command hit "the application did not respond"
    // instead of a resolvable startup error.
    @Inject(DISCORD_CLIENT) private readonly client: Client,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(REALTIME_PORT) private readonly realtime: RealtimeBroadcastPort,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const token = process.env.DISCORD_TOKEN;
    if (!token) throw new Error('DISCORD_TOKEN is not set in .env');

    // "Config admins are re-applied additively at boot... editing the
    // config and redeploying always restores access — the lockout
    // recovery path the requirements specify." See DESIGN.md,
    // "Authentication and Authorization".
    await syncConfigAdmins(this.prisma, parseAdminDiscordIds(process.env.ADMIN_DISCORD_IDS));

    const matchChannel = createMatchChannelAdapter(this.client, this.prisma);
    const alert = createAlertAdapter(this.client, this.prisma);
    const playerNotification = createPlayerNotificationAdapter(this.client, this.prisma);
    registerInteractionHandlers(
      this.client,
      this.prisma,
      cryptoRandomPort,
      matchChannel,
      alert,
      playerNotification,
      this.realtime,
    );
    registerMessageListener(this.client, this.prisma, cryptoRandomPort, matchChannel, this.realtime);

    // A guild joined while already running gets its commands the moment it's
    // available — no separate registration script or restart to remember.
    this.client.on(Events.GuildCreate, (guild) => {
      registerGuildCommands(this.client, guild.id).catch((err: unknown) => {
        console.error(`[discord] failed to register commands for newly-joined guild ${guild.id}`, err);
      });
    });

    await loginDiscordClient(this.client, token);
    console.log(`Logged in as ${this.client.user?.tag}, serving ${plural(this.client.guilds.cache.size, 'guild', 'guilds')}`);

    await registerCommandsForAllGuilds(this.client);
    console.log('Commands registered. Listening.');
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
