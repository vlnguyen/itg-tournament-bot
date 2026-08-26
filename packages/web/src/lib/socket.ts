import { io, type Socket } from 'socket.io-client';

/**
 * One socket for the whole tab — DESIGN.md's `tournament:{id}` channel is a
 * room joined per open page, not a separate connection. Connects to the
 * page's own origin: in production the Nest process serves the static
 * build and the gateway together; in dev, `vite.config.ts` proxies
 * `/socket.io` to the Nest process the same way it proxies `/api`.
 */
let socket: Socket | undefined;

export function getSocket(): Socket {
  socket ??= io({ transports: ['websocket'] });
  return socket;
}
