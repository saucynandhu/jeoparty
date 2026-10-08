/**
 * Socket wiring (SPEC §6).
 *
 * Pattern for every host action: authenticate → call the pure state machine →
 * broadcast role-filtered snapshots. All authority lives in `game.ts`; handlers
 * only translate between sockets and that API.
 */

import { createServer, type Server as HttpServer } from "node:http";
import express from "express";
import cors from "cors";
import { Server, type Socket } from "socket.io";

import type {
  ClientToServerEvents,
  ErrorCode,
  HostToken,
  InterServerEvents,
  RoomCode,
  ServerToClientEvents,
  SocketData,
} from "@buzz/shared";

import {
  MAX_PLAYERS,
  addPlayer,
  createRoom,
  findPlayerByToken,
  getRoom,
  isHostToken,
  normalizeCode,
  normalizeName,
  stats,
  touchRoom,
  type Room,
} from "./rooms.js";
import * as game from "./game.js";
import { toHostState, toPlayerState } from "./project.js";

export interface GameServer {
  app: express.Express;
  httpServer: HttpServer;
  io: Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
  port: number;
  close: () => Promise<void>;
}

type AppSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export async function createGameServer(options: { port?: number } = {}): Promise<GameServer> {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // -------------------------------------------------------------------------
  // Health check
  // -------------------------------------------------------------------------
  app.get("/health", (_req, res) => {
    const store = stats();
    res.json({
      status: "ok",
      service: "buzz-server",
      version: "0.1.0",
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      rooms: store.rooms,
      players: store.players,
      roomsByPhase: store.byPhase,
    });
  });

  app.get("/", (_req, res) => {
    res.json({ service: "buzz-server", docs: "/health", socket: "/socket.io" });
  });

  const httpServer = createServer(app);
  const io = new Server<
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketData
  >(httpServer, { cors: { origin: true, credentials: true } });

  // -------------------------------------------------------------------------
  // Broadcast helpers
  // -------------------------------------------------------------------------

  /**
   * Pushes a fresh, role-filtered snapshot to the host and every seated player.
   * Sent on every accepted transition — clients never compute state themselves.
   */
  function broadcast(room: Room): void {
    if (room.hostSocketId) {
      io.to(room.hostSocketId).emit("room:state", toHostState(room));
    }
    for (const player of room.players.values()) {
      if (player.connected && player.socketId) {
        io.to(player.socketId).emit("room:state", toPlayerState(room, player));
      }
    }
  }

  function error(socket: AppSocket, code: ErrorCode, message: string): void {
    socket.emit("room:error", { code, message });
  }

  function seat(socket: AppSocket, role: "host" | "player", room: Room, token: string, playerId: string | null): void {
    socket.data.role = role;
    socket.data.roomCode = room.code;
    socket.data.token = token;
    socket.data.playerId = playerId;
    void socket.join(room.code);
  }

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  type AuthResult = { ok: true; room: Room } | { ok: false; code: ErrorCode; message: string };

  function requireHost(payload: { code: RoomCode; hostToken: HostToken }): AuthResult {
    const room = getRoom(payload?.code ?? "");
    if (!room) return { ok: false, code: "ROOM_NOT_FOUND", message: "That room no longer exists." };
    if (!isHostToken(room, payload.hostToken)) {
      return { ok: false, code: "UNAUTHORIZED", message: "Not the host of this room." };
    }
    return { ok: true, room };
  }

  /** Resolves the player behind a socket, confirming the room it claims. */
  function requirePlayer(
    socket: AppSocket,
    claimedCode: string,
  ): { ok: true; room: Room; player: { id: string } } | { ok: false } {
    const code = socket.data.roomCode;
    const playerId = socket.data.playerId;
    if (!code || !playerId) return { ok: false };
    if (normalizeCode(claimedCode) !== code) return { ok: false };
    const room = getRoom(code);
    if (!room) return { ok: false };
    const player = room.players.get(playerId);
    if (!player) return { ok: false };
    return { ok: true, room, player };
  }

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  io.on("connection", (socket: AppSocket) => {
    socket.data.role = null;
    socket.data.roomCode = null;
    socket.data.playerId = null;
    socket.data.token = null;

    // --- create room -------------------------------------------------------
    socket.on("host:create", (ack) => {
      const room = createRoom();
      room.hostSocketId = socket.id;
      seat(socket, "host", room, room.hostToken, null);
      ack({ ok: true, code: room.code, hostToken: room.hostToken, state: toHostState(room) });
    });

    // --- reconnect (host or player) ----------------------------------------
    socket.on("session:resume", (payload, ack) => {
      const room = getRoom(payload?.code ?? "");
      if (!room) {
        ack({ ok: false, code: "ROOM_NOT_FOUND", message: "That room no longer exists." });
        return;
      }

      if (isHostToken(room, payload.token)) {
        room.hostSocketId = socket.id;
        seat(socket, "host", room, room.hostToken, null);
        touchRoom(room);
        ack({ ok: true, state: toHostState(room) });
        broadcast(room);
        return;
      }

      const player = findPlayerByToken(room, payload.token);
      if (!player) {
        ack({ ok: false, code: "UNAUTHORIZED", message: "That session is no longer valid." });
        return;
      }

      player.connected = true;
      player.socketId = socket.id;
      seat(socket, "player", room, player.token, player.id);
      touchRoom(room);
      ack({ ok: true, state: toPlayerState(room, player) });
      broadcast(room);
    });

    // --- join --------------------------------------------------------------
    socket.on("player:join", (payload, ack) => {
      const room = getRoom(payload?.code ?? "");
      if (!room) {
        ack({ ok: false, code: "ROOM_NOT_FOUND", message: "No room with that code." });
        return;
      }
      if (room.phase !== "LOBBY") {
        ack({
          ok: false,
          code: "GAME_ALREADY_STARTED",
          message: "That game has already started.",
        });
        return;
      }
      if (room.players.size >= MAX_PLAYERS) {
        ack({ ok: false, code: "ROOM_FULL", message: "That room is full." });
        return;
      }
      const name = normalizeName(payload.name ?? "");
      if (!name) {
        ack({ ok: false, code: "NAME_INVALID", message: "Please enter a name." });
        return;
      }

      const player = addPlayer(room, name);
      player.socketId = socket.id;
      seat(socket, "player", room, player.token, player.id);
      ack({
        ok: true,
        playerId: player.id,
        playerToken: player.token,
        state: toPlayerState(room, player),
      });
      broadcast(room);
    });

    // --- host transitions --------------------------------------------------
    socket.on("host:start", (payload) => {
      const auth = requireHost(payload);
      if (!auth.ok) return error(socket, auth.code, auth.message);
      const result = game.startGame(auth.room);
      if (!result.ok) return error(socket, result.code, result.message);
      broadcast(auth.room);
    });

    socket.on("host:pickClue", (payload) => {
      const auth = requireHost(payload);
      if (!auth.ok) return error(socket, auth.code, auth.message);
      const result = game.pickClue(auth.room, payload.clueId);
      if (!result.ok) return error(socket, result.code, result.message);
      broadcast(auth.room);
    });

    socket.on("host:openBuzzers", (payload) => {
      const auth = requireHost(payload);
      if (!auth.ok) return error(socket, auth.code, auth.message);
      const result = game.openBuzzers(auth.room);
      if (!result.ok) return error(socket, result.code, result.message);
      const active = auth.room.activeClue;
      if (active) io.to(auth.room.code).emit("buzzers:open", { clueId: active.clueId });
      broadcast(auth.room);
    });

    socket.on("host:judge", (payload) => {
      const auth = requireHost(payload);
      if (!auth.ok) return error(socket, auth.code, auth.message);

      const before = auth.room.players.get(payload.playerId)?.score ?? 0;
      const result = game.judge(auth.room, payload.playerId, payload.correct);
      if (!result.ok) return error(socket, result.code, result.message);

      const after = auth.room.players.get(payload.playerId)?.score ?? 0;
      const player = auth.room.players.get(payload.playerId);
      if (player) {
        io.to(auth.room.code).emit("judged", {
          playerId: player.id,
          name: player.name,
          correct: payload.correct,
          delta: after - before,
          newScore: after,
        });
      }
      broadcast(auth.room);
    });

    socket.on("host:closeClue", (payload) => {
      const auth = requireHost(payload);
      if (!auth.ok) return error(socket, auth.code, auth.message);
      const result = game.closeClue(auth.room);
      if (!result.ok) return error(socket, result.code, result.message);
      broadcast(auth.room);
    });

    socket.on("host:next", (payload) => {
      const auth = requireHost(payload);
      if (!auth.ok) return error(socket, auth.code, auth.message);
      const result = game.nextClue(auth.room);
      if (!result.ok) return error(socket, result.code, result.message);
      broadcast(auth.room);
    });

    socket.on("host:endGame", (payload) => {
      const auth = requireHost(payload);
      if (!auth.ok) return error(socket, auth.code, auth.message);
      const result = game.endGame(auth.room);
      if (!result.ok) return error(socket, result.code, result.message);
      broadcast(auth.room);
      io.to(auth.room.code).emit("game:over", { standings: game.standings(auth.room) });
    });

    // --- the race ----------------------------------------------------------
    socket.on("player:buzz", (payload, ack) => {
      const auth = requirePlayer(socket, payload?.code ?? "");
      if (!auth.ok) {
        ack({ ok: false, code: "UNAUTHORIZED", reason: "buzzers_closed", message: "You are not seated in a room." });
        return;
      }
      const { room, player } = auth;

      // Synchronous: no await may be introduced between the phase check and the
      // winner claim inside game.buzz, or the race guarantee is lost.
      const outcome = game.buzz(room, player.id);
      ack(outcome);

      if (outcome.ok) {
        const winner = room.players.get(player.id);
        if (winner) io.to(room.code).emit("buzzed", { playerId: winner.id, name: winner.name });
        broadcast(room);
      }
    });

    // --- disconnect --------------------------------------------------------
    socket.on("disconnect", () => {
      const code = socket.data.roomCode;
      if (!code) return;
      const room = getRoom(code);
      if (!room) return;

      if (socket.data.role === "host") {
        if (room.hostSocketId === socket.id) room.hostSocketId = null;
      } else if (socket.data.playerId) {
        const player = room.players.get(socket.data.playerId);
        if (player && player.socketId === socket.id) {
          // The seat is kept (score, name, lockout state) so a reconnect with the
          // stored token restores it. Only connectivity is dropped.
          player.connected = false;
          player.socketId = null;
        }
      }
      touchRoom(room);
      broadcast(room);
    });
  });

  // -------------------------------------------------------------------------
  // Listen
  // -------------------------------------------------------------------------

  const port = options.port ?? 3001;
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  return {
    app,
    httpServer,
    io,
    port: actualPort,
    close: () =>
      new Promise<void>((resolve) => {
        io.close(() => httpServer.close(() => resolve()));
      }),
  };
}
