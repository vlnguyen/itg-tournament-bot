import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { DiscordModule } from './discord/discord.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { StaticModule } from './static.module.js';

@Module({
  imports: [PrismaModule, DiscordModule, AuthModule, StaticModule],
})
export class AppModule {}
