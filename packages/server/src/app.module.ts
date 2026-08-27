import { Module } from '@nestjs/common';
import { ApiModule } from './api/api.module.js';
import { AuthModule } from './auth/auth.module.js';
import { DiscordModule } from './discord/discord.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { StaticModule } from './static.module.js';

@Module({
  imports: [PrismaModule, RealtimeModule, DiscordModule, AuthModule, ApiModule, StaticModule],
})
export class AppModule {}
