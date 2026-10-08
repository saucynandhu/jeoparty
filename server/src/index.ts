/**
 * Boot script. Policy (ports, sweeping, shutdown) lives here; the game server
 * itself is built by `createGameServer` so tests can start one on a random port.
 */

import { createGameServer } from "./server.js";
import { sweep } from "./rooms.js";

/**
 * Read a positive integer from the environment, falling back when the value is
 * missing, empty, non-numeric, or non-positive. A bare `??` is not enough:
 * environments commonly export `PORT=` or `PORT=0`, which coerce to 0 and would
 * silently bind an ephemeral port.
 */
function envInt(
  name: string,
  fallback: number,
  { min = 1, max = Number.MAX_SAFE_INTEGER } = {},
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

const PORT = envInt("PORT", 3001, { max: 65535 });
const SWEEP_INTERVAL_MS = envInt("SWEEP_INTERVAL_MS", 60_000);
const ROOM_TTL_MS = envInt("ROOM_TTL_MS", 2 * 60 * 60 * 1000);

const server = await createGameServer({ port: PORT });

console.log(`[buzz] server listening on http://localhost:${server.port}`);
console.log(`[buzz] health check: http://localhost:${server.port}/health`);

const sweeper = setInterval(() => {
  const removed = sweep(ROOM_TTL_MS);
  if (removed > 0) console.log(`[rooms] swept ${removed} idle room(s)`);
}, SWEEP_INTERVAL_MS);
sweeper.unref();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[buzz] ${signal} received — shutting down`);
  clearInterval(sweeper);
  const force = setTimeout(() => process.exit(0), 3_000);
  force.unref();
  await server.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
