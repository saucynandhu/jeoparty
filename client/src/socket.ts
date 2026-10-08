import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@buzz/shared";

/**
 * Typed socket. Event names and payloads are checked against the shared
 * contract in `@buzz/shared` (SPEC §6).
 */
export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * Connects to the same origin. In dev, Vite proxies `/socket.io` to the server
 * (see vite.config.ts), so there is no hardcoded host to keep in sync.
 */
export function createSocket(): AppSocket {
  return io({ transports: ["websocket", "polling"] });
}
