import { Module } from '@nestjs/common';
import { GuildsController } from './guilds.controller.js';
import { MatchesController } from './matches.controller.js';
import { PlayersController } from './players.controller.js';
import { TournamentsController } from './tournaments.controller.js';

@Module({
  controllers: [TournamentsController, MatchesController, GuildsController, PlayersController],
})
export class ApiModule {}
