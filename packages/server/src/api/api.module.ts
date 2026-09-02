import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DiscordAdaptersModule } from '../discord/discord-adapters.module.js';
import { DiscordModule } from '../discord/discord.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { AdminController } from './admin.controller.js';
import { ChartsController } from './charts.controller.js';
import { GuildsController } from './guilds.controller.js';
import { LifecycleController } from './lifecycle.controller.js';
import { MatchesController } from './matches.controller.js';
import { PlayersController } from './players.controller.js';
import { RosterController } from './roster.controller.js';
import { RulingsController } from './rulings.controller.js';
import { SetupController } from './setup.controller.js';
import { SongPoolController } from './song-pool.controller.js';
import { TournamentsController } from './tournaments.controller.js';

@Module({
  imports: [AuthModule, DiscordAdaptersModule, DiscordModule, RealtimeModule],
  controllers: [
    TournamentsController,
    MatchesController,
    GuildsController,
    PlayersController,
    ChartsController,
    SongPoolController,
    RulingsController,
    RosterController,
    LifecycleController,
    SetupController,
    AdminController,
  ],
})
export class ApiModule {}
