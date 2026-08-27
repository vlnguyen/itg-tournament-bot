import { Module } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway.js';
import { REALTIME_PORT } from './realtime.tokens.js';

@Module({
  providers: [RealtimeGateway, { provide: REALTIME_PORT, useExisting: RealtimeGateway }],
  exports: [REALTIME_PORT],
})
export class RealtimeModule {}
