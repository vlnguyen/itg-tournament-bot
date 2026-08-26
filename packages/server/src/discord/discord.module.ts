import { Module } from '@nestjs/common';
import { Client } from 'discord.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { createDiscordClient } from './client.js';
import { DiscordBootstrapService } from './discord-bootstrap.service.js';
import { DISCORD_CLIENT } from './discord.tokens.js';

@Module({
  imports: [PrismaModule],
  providers: [
    {
      provide: DISCORD_CLIENT,
      useFactory: (): Client => createDiscordClient(),
    },
    DiscordBootstrapService,
  ],
  exports: [DISCORD_CLIENT],
})
export class DiscordModule {}
