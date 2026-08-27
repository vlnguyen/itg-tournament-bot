import { Module } from '@nestjs/common';
import { DiscordModule } from '../discord/discord.module.js';
import { AuthController } from './auth.controller.js';
import { DiscordGuildsService } from './discord-guilds.service.js';
import { TierService } from './tier.service.js';

@Module({
  imports: [DiscordModule],
  controllers: [AuthController],
  providers: [TierService, DiscordGuildsService],
  exports: [TierService, DiscordGuildsService],
})
export class AuthModule {}
