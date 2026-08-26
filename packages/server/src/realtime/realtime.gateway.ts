import { PublicMatch as PublicMatchSchema } from '@itg/shared';
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import type { PublicMatch } from '../domain/projection.js';
import type { RealtimeBroadcastPort } from '../services/ports.js';

function roomFor(tournamentId: string): string {
  return `tournament:${tournamentId}`;
}

/**
 * One room per tournament (`tournament:{id}`) — DESIGN.md, "Realtime". A
 * client subscribes by emitting `subscribe` with `{ tournamentId }`; every
 * committed `MatchEvent` then reaches it as a `frame` event carrying
 * `{ matchId, seq, projection }`, validated against the same shared zod
 * schema the REST match-detail endpoint serves, so the two can never
 * disagree about what's on the wire. No per-client replay buffer: a
 * reconnecting client refetches the REST snapshot and resumes from there —
 * frames are idempotent (drop any `seq` not greater than what's held), so
 * nothing is lost by the server keeping no history.
 */
@WebSocketGateway({ cors: { origin: true } })
export class RealtimeGateway implements RealtimeBroadcastPort {
  @WebSocketServer() private readonly server!: Server;

  @SubscribeMessage('subscribe')
  handleSubscribe(@ConnectedSocket() client: Socket, @MessageBody() body: { tournamentId?: string }): void {
    if (!body?.tournamentId) return;
    client.join(roomFor(body.tournamentId));
  }

  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(@ConnectedSocket() client: Socket, @MessageBody() body: { tournamentId?: string }): void {
    if (!body?.tournamentId) return;
    client.leave(roomFor(body.tournamentId));
  }

  publish(tournamentId: string, matchId: string, seq: number, projection: PublicMatch): void {
    const wireProjection = PublicMatchSchema.parse(projection);
    this.server.to(roomFor(tournamentId)).emit('frame', { matchId, seq, projection: wireProjection });
  }

  /** No payload — see `RealtimeBroadcastPort`'s comment. The same `tournament:{id}` room a roster/seeding page joins just to watch for match frames already exists; this reuses it. */
  publishRosterChanged(tournamentId: string): void {
    this.server.to(roomFor(tournamentId)).emit('roster');
  }
}
