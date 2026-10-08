/**
 * Integration tests over real Socket.IO/websocket connections.
 *
 * These complement the pure state-machine tests: they prove the race is decided
 * correctly across actual network boundaries, where five independent sockets
 * deliver their frames in the same event-loop tick.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";

import type {
  BuzzResult,
  ClientToServerEvents,
  CreateResult,
  HostState,
  JoinResult,
  PlayerState,
  ResumeResult,
  RoomPhase,
  RoomState,
  ServerToClientEvents,
} from "@buzz/shared";

import { createGameServer, type GameServer } from "./server.js";

type TestSocket = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

let server: GameServer;
let url: string;
const opened: TestSocket[] = [];

before(async () => {
  server = await createGameServer({ port: 0 });
  url = `http://localhost:${server.port}`;
});

after(async () => {
  for (const socket of opened) socket.disconnect();
  await server.close();
});

async function newClient(): Promise<TestSocket> {
  const socket = connect(url, { transports: ["websocket"], forceNew: true }) as TestSocket;
  opened.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", (error) => reject(error));
  });
  return socket;
}

/** Emits and resolves with the ack, whatever the event's typed signature is. */
function emitAck<TRes>(socket: TestSocket, event: string, payload?: unknown): Promise<TRes> {
  return new Promise<TRes>((resolve) => {
    const emitter = socket as unknown as { emit: (e: string, ...args: unknown[]) => void };
    if (payload === undefined) {
      emitter.emit(event, (res: TRes) => resolve(res));
    } else {
      emitter.emit(event, payload, (res: TRes) => resolve(res));
    }
  });
}

/** Resolves once the phone reports the given phase. Register before triggering. */
function waitForPlayerPhase(phone: TestSocket, phase: RoomPhase): Promise<PlayerState> {
  return new Promise<PlayerState>((resolve) => {
    const onState = (state: RoomState) => {
      if (state.role === "player" && state.phase === phase) {
        phone.off("room:state", onState);
        resolve(state);
      }
    };
    phone.on("room:state", onState);
  });
}

/** Resolves once the host reports the given phase. Register before triggering. */
function waitForPhase(host: TestSocket, phase: RoomPhase): Promise<HostState> {
  return new Promise<HostState>((resolve) => {
    const onState = (state: RoomState) => {
      if (state.role === "host" && state.phase === phase) {
        host.off("room:state", onState);
        resolve(state);
      }
    };
    host.on("room:state", onState);
  });
}

/** Host + N joined players, sitting on the board. */
async function lobby(playerCount: number) {
  const host = await newClient();
  const created: CreateResult = await emitAck<CreateResult>(host, "host:create");
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("unreachable");

  const players: TestSocket[] = [];
  const seats: Array<{ playerId: string; playerToken: string }> = [];
  for (let i = 0; i < playerCount; i++) {
    const socket = await newClient();
    const joined: JoinResult = await emitAck<JoinResult>(socket, "player:join", {
      code: created.code,
      name: `Player ${i + 1}`,
    });
    assert.equal(joined.ok, true);
    if (!joined.ok) throw new Error("unreachable");
    players.push(socket);
    seats.push({ playerId: joined.playerId, playerToken: joined.playerToken });
  }

  return {
    host,
    hostToken: created.hostToken,
    code: created.code,
    board: created.state.board,
    players,
    seats,
  };
}

// ---------------------------------------------------------------------------

test("the host sees the lobby roster grow as players join", async () => {
  const host = await newClient();
  const created: CreateResult = await emitAck<CreateResult>(host, "host:create");
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.state.phase, "LOBBY");
  assert.equal(created.state.players.length, 0);

  const rosterSizes: number[] = [];
  host.on("room:state", (state) => {
    if (state.role === "host") rosterSizes.push(state.players.length);
  });

  for (const name of ["Ana", "Bo", "Cy"]) {
    const phone = await newClient();
    const joined: JoinResult = await emitAck<JoinResult>(phone, "player:join", { code: created.code, name });
    assert.equal(joined.ok, true);
    if (joined.ok) {
      assert.equal(joined.state.role, "player");
      assert.equal(joined.state.name, name);
      assert.equal(joined.state.score, 0);
    }
  }

  // Give the last roster broadcast a moment to land.
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(rosterSizes.includes(3), `expected a 3-player roster, saw ${rosterSizes}`);
});

test("FIVE SIMULTANEOUS BUZZES: exactly one winner, everyone else too late", async () => {
  const { host, hostToken, code, players, seats } = await lobby(5);

  let done = waitForPhase(host, "BOARD");
  host.emit("host:start", { code, hostToken });
  const boardState = await done;
  const clue = boardState.board[0]?.clues[0];
  assert.ok(clue, "expected a clue on the placeholder board");

  done = waitForPhase(host, "CLUE_SHOWN");
  host.emit("host:pickClue", { code, hostToken, clueId: clue.id });
  await done;

  done = waitForPhase(host, "BUZZING_OPEN");
  host.emit("host:openBuzzers", { code, hostToken });
  await done;

  // Fire all five buzzes in the SAME tick: no awaits between emits, so the
  // frames hit the wire back-to-back and the server must break the tie.
  const answering = waitForPhase(host, "ANSWERING");
  const results = await Promise.all(
    players.map((phone) => emitAck<BuzzResult>(phone, "player:buzz", { code })),
  );
  const state = await answering;

  const winners = results
    .map((result, index) => ({ result, index }))
    .filter((entry) => entry.result.ok);

  assert.equal(winners.length, 1, `expected exactly one winner, got ${winners.length}`);

  const winnerIndex = winners[0]!.index;
  const winnerId = seats[winnerIndex]!.playerId;

  assert.equal(state.activeClue?.currentAnswerer, winnerId);
  assert.equal(state.activeClue?.buzzCount, 1, "only one buzz may be recorded");
  assert.equal(state.phase, "ANSWERING");

  // Every non-winner got a neutral "too slow", not an error to surface.
  for (const [index, result] of results.entries()) {
    if (index === winnerIndex) continue;
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "too_late");
      assert.equal(result.code, "ILLEGAL_PHASE");
    }
  }
});

test("a buzz outside the open window is refused at the socket level", async () => {
  const { host, hostToken, code, players } = await lobby(1);
  const phone = players[0]!;

  // Buzzers are not open — the player is still in the lobby.
  const result: BuzzResult = await emitAck<BuzzResult>(phone, "player:buzz", { code });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "buzzers_closed");

  // Still LOBBY on the host.
  const state = await new Promise<HostState>((resolve) => {
    host.once("room:state", (s) => {
      if (s.role === "host") resolve(s);
    });
    host.emit("host:start", { code, hostToken });
  });
  assert.equal(state.phase, "BOARD");
});

test("a reconnect restores the same seat, score included", async () => {
  const { host, hostToken, code, board, players, seats } = await lobby(1);
  const phone = players[0]!;
  const seat = seats[0]!;

  let done = waitForPhase(host, "BOARD");
  host.emit("host:start", { code, hostToken });
  await done;

  const clue = board[0]!.clues[0]!;
  done = waitForPhase(host, "CLUE_SHOWN");
  host.emit("host:pickClue", { code, hostToken, clueId: clue.id });
  await done;

  done = waitForPhase(host, "BUZZING_OPEN");
  host.emit("host:openBuzzers", { code, hostToken });
  await done;

  const answering = waitForPhase(host, "ANSWERING");
  await emitAck<BuzzResult>(phone, "player:buzz", { code });
  await answering;

  done = waitForPhase(host, "RESOLVED");
  host.emit("host:judge", { code, hostToken, playerId: seat.playerId, correct: true });
  await done;

  // The phone dies mid-game.
  phone.disconnect();
  await new Promise((r) => setTimeout(r, 50));

  // …and comes back with the token it stored in localStorage.
  const revived = await newClient();
  const resumed: ResumeResult = await emitAck<ResumeResult>(revived, "session:resume", {
    code,
    token: seat.playerToken,
  });

  assert.equal(resumed.ok, true);
  if (!resumed.ok) return;
  assert.equal(resumed.state.role, "player");
  const asPlayer = resumed.state as PlayerState;
  assert.equal(asPlayer.playerId, seat.playerId);
  assert.equal(asPlayer.score, clue.value, "the score must survive the reconnect");
  assert.equal(asPlayer.name, "Player 1");
  assert.equal(asPlayer.phase, "RESOLVED");
});

test("a bad session token is refused", async () => {
  const { code } = await lobby(1);
  const stranger = await newClient();
  const resumed: ResumeResult = await emitAck<ResumeResult>(stranger, "session:resume", {
    code,
    token: "not-a-real-token",
  });
  assert.equal(resumed.ok, false);
  if (!resumed.ok) assert.equal(resumed.code, "UNAUTHORIZED");
});

test("joining is refused once the game has started", async () => {
  const { host, hostToken, code } = await lobby(1);

  const done = waitForPhase(host, "BOARD");
  host.emit("host:start", { code, hostToken });
  await done;

  const latecomer = await newClient();
  const joined: JoinResult = await emitAck<JoinResult>(latecomer, "player:join", { code, name: "Late" });
  assert.equal(joined.ok, false);
  if (!joined.ok) assert.equal(joined.code, "GAME_ALREADY_STARTED");
});

test("players never receive the answer while a clue is live", async () => {
  const { host, hostToken, code, board, players } = await lobby(1);
  const phone = players[0]!;

  let done = waitForPhase(host, "BOARD");
  host.emit("host:start", { code, hostToken });
  await done;

  const clue = board[0]!.clues[0]!;

  // Wait on the PHONE's own broadcast, not the host's: they are separate
  // sockets and the host's frame can land first.
  const shownOnPhone = waitForPlayerPhase(phone, "CLUE_SHOWN");
  host.emit("host:pickClue", { code, hostToken, clueId: clue.id });
  const shown = await shownOnPhone;

  assert.ok(shown.activeClue, "the phone must be shown the clue");
  assert.equal(shown.activeClue.question, clue.question);
  assert.equal(shown.activeClue.answer, null, "the answer must not reach the phone yet");

  // The player's board projection carries no answer key at all.
  const projected = shown.board.flatMap((category) => category.clues);
  for (const entry of projected) {
    assert.ok(!("answer" in entry), "public clues must not expose answers");
  }
});
