import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ChartsController } from './charts.controller.js';
import { GuildsController } from './guilds.controller.js';
import { MatchesController } from './matches.controller.js';
import { PlayersController } from './players.controller.js';
import { TournamentsController } from './tournaments.controller.js';

@Module({
  imports: [AuthModule],
  controllers: [TournamentsController, MatchesController, GuildsController, PlayersController, ChartsController],
})
export class ApiModule {}
