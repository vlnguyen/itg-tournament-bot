import { Module } from '@nestjs/common';
import { MatchesController } from './matches.controller.js';
import { TournamentsController } from './tournaments.controller.js';

@Module({
  controllers: [TournamentsController, MatchesController],
})
export class ApiModule {}
