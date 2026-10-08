import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { CODE_ALPHABET, allClues, addPlayer, clearAllRooms, createRoom, normalizeCode } from "./rooms.js";
import * as game from "./game.js";

beforeEach(() => clearAllRooms());

/** A room with `n` players, already started and sitting on the board. */
function startedRoom(n = 3) {
  const room = createRoom();
  const players = Array.from({ length: n }, (_, i) => addPlayer(room, `Player ${i + 1}`));
  const started = game.startGame(room);
  assert.equal(started.ok, true);
  return { room, players };
}

/** Drives the room to BUZZING_OPEN on the given clue index. */
function openBuzzersOn(room: ReturnType<typeof createRoom>, clueIndex = 0) {
  const clue = allClues(room)[clueIndex];
  assert.ok(clue, `no clue at index ${clueIndex}`);
  assert.equal(game.pickClue(room, clue.id).ok, true);
  assert.equal(game.openBuzzers(room).ok, true);
  return clue;
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

test("room codes are 4 letters from the confusable-free alphabet and unique", () => {
  const codes = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const room = createRoom();
    assert.equal(room.code.length, 4);
    for (const ch of room.code) {
      assert.ok(CODE_ALPHABET.includes(ch), `${room.code} contains ${ch}`);
    }
    codes.add(room.code);
  }
  // 200 draws from 24^4 — collisions are possible but must be rare.
  assert.ok(codes.size >= 199, `expected near-unique codes, got ${codes.size}`);
});

test("codes normalize from messy user input", () => {
  assert.equal(normalizeCode("  abcd "), "ABCD");
  assert.equal(normalizeCode("a b"), "AB");
});

test("duplicate names are de-duplicated rather than rejected", () => {
  const room = createRoom();
  const a = addPlayer(room, "Alex");
  const b = addPlayer(room, "alex");
  const c = addPlayer(room, "Alex");
  assert.equal(a.name, "Alex");
  assert.equal(b.name, "alex (2)");
  assert.equal(c.name, "Alex (3)");
});

// ---------------------------------------------------------------------------
// Phase guards
// ---------------------------------------------------------------------------

test("start requires at least one player", () => {
  const room = createRoom();
  const result = game.startGame(room);
  assert.equal(result.ok, false);
  assert.equal(room.phase, "LOBBY");

  addPlayer(room, "Solo");
  assert.equal(game.startGame(room).ok, true);
  assert.equal(room.phase, "BOARD");
});

test("host transitions are phase-gated", () => {
  const { room } = startedRoom();
  const clue = allClues(room)[0];
  assert.ok(clue);

  // Can't open buzzers before a clue is picked.
  assert.equal(game.openBuzzers(room).ok, false);
  // Can't advance before the clue resolves.
  assert.equal(game.nextClue(room).ok, false);

  assert.equal(game.pickClue(room, clue.id).ok, true);
  assert.equal(room.phase, "CLUE_SHOWN");
  // Can't pick a second clue while one is live.
  assert.equal(game.pickClue(room, allClues(room)[1]!.id).ok, false);

  assert.equal(game.openBuzzers(room).ok, true);
  assert.equal(room.phase, "BUZZING_OPEN");
  // Opening twice is rejected.
  assert.equal(game.openBuzzers(room).ok, false);
});

test("a consumed clue cannot be picked again", () => {
  const { room, players } = startedRoom(1);
  const clue = openBuzzersOn(room);
  const player = players[0]!;

  assert.equal(game.buzz(room, player.id).ok, true);
  assert.equal(game.judge(room, player.id, true).ok, true);
  assert.equal(room.phase, "RESOLVED");
  assert.equal(game.nextClue(room).ok, true);
  assert.equal(room.phase, "BOARD");

  const again = game.pickClue(room, clue.id);
  assert.equal(again.ok, false);
});

// ---------------------------------------------------------------------------
// The race
// ---------------------------------------------------------------------------

test("exactly one of five simultaneous buzzes wins", () => {
  const { room, players } = startedRoom(5);
  openBuzzersOn(room);

  // Same tick, in order — this is the worst case for a race.
  const outcomes = players.map((player) => game.buzz(room, player.id));

  const winners = outcomes.filter((o) => o.ok && o.won);
  assert.equal(winners.length, 1, "exactly one buzzer must win");

  const first = players[0]!;
  assert.equal(room.activeClue?.currentAnswerer, first.id);
  assert.equal(room.phase, "ANSWERING");
  assert.deepEqual(room.activeClue?.buzzOrder, [first.id]);

  for (const loser of outcomes.slice(1)) {
    assert.equal(loser.ok, false);
    if (!loser.ok) assert.equal(loser.reason, "too_late");
  }
});

test("the winner is whoever the server hears first, regardless of player order", () => {
  const { room, players } = startedRoom(5);
  openBuzzersOn(room);

  // Reverse arrival order — the last player should win.
  const order = [...players].reverse();
  const results = order.map((player) => game.buzz(room, player.id));

  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(room.activeClue?.currentAnswerer, order[0]!.id);
});

test("buzzes are ignored outside BUZZING_OPEN, with a neutral reason", () => {
  const { room, players } = startedRoom(2);
  const player = players[0]!;

  // Before a clue exists / before buzzers open.
  const early = game.buzz(room, player.id);
  assert.equal(early.ok, false);
  if (!early.ok) assert.equal(early.reason, "buzzers_closed");

  const clue = allClues(room)[0]!;
  game.pickClue(room, clue.id);
  const duringRead = game.buzz(room, player.id);
  assert.equal(duringRead.ok, false);
  if (!duringRead.ok) assert.equal(duringRead.reason, "buzzers_closed");

  // After the window is claimed.
  game.openBuzzers(room);
  assert.equal(game.buzz(room, players[1]!.id).ok, true);
  const late = game.buzz(room, player.id);
  assert.equal(late.ok, false);
  if (!late.ok) assert.equal(late.reason, "too_late");
});

// ---------------------------------------------------------------------------
// Scoring + lockout
// ---------------------------------------------------------------------------

test("a correct answer adds exactly the clue value", () => {
  const { room, players } = startedRoom(1);
  const clue = openBuzzersOn(room);
  const player = players[0]!;

  game.buzz(room, player.id);
  game.judge(room, player.id, true);

  assert.equal(player.score, clue.value);
  assert.equal(clue.consumed, true);
  assert.equal(clue.answeredBy, player.id);
  assert.equal(clue.answeredCorrectly, true);
});

test("a wrong answer deducts nothing, locks that player out, and reopens buzzing", () => {
  const { room, players } = startedRoom(2);
  const clue = openBuzzersOn(room);
  const [first, second] = [players[0]!, players[1]!];

  game.buzz(room, first.id);
  const result = game.judge(room, first.id, false);
  assert.equal(result.ok, true);

  // Jeopardy-style lockout: no penalty.
  assert.equal(first.score, 0);
  assert.equal(clue.consumed, false, "the clue is still live for others");
  assert.equal(room.phase, "BUZZING_OPEN", "buzzing must reopen");

  // The locked-out player cannot buzz again on this clue.
  const retry = game.buzz(room, first.id);
  assert.equal(retry.ok, false);
  if (!retry.ok) assert.equal(retry.reason, "locked_out");

  // The other player can.
  assert.equal(game.buzz(room, second.id).ok, true);
  assert.equal(room.activeClue?.currentAnswerer, second.id);
});

test("when everyone is locked out the clue resolves with no winner", () => {
  const { room, players } = startedRoom(2);
  const clue = openBuzzersOn(room);

  for (const player of players) {
    game.buzz(room, player.id);
    game.judge(room, player.id, false);
  }

  assert.equal(room.phase, "RESOLVED");
  assert.equal(room.activeClue?.attempts.length, 2);

  // Host moves on; nobody scored and the clue is burned.
  assert.equal(game.nextClue(room).ok, true);
  assert.equal(clue.consumed, true);
  assert.equal(clue.answeredBy, null);
  assert.equal(players[0]!.score + players[1]!.score, 0);
});

test("only the player who buzzed can be judged", () => {
  const { room, players } = startedRoom(2);
  openBuzzersOn(room);
  game.buzz(room, players[0]!.id);

  const result = game.judge(room, players[1]!.id, true);
  assert.equal(result.ok, false);
  assert.equal(players[1]!.score, 0);
});

test("disconnected players are not eligible to buzz", () => {
  const { room, players } = startedRoom(2);
  const [a, b] = [players[0]!, players[1]!];
  b.connected = false;

  const clue = allClues(room)[0]!;
  game.pickClue(room, clue.id);
  assert.equal(game.openBuzzers(room).ok, true);
  assert.deepEqual(game.eligibleBuzzers(room), [a.id]);
});

// ---------------------------------------------------------------------------
// End of game
// ---------------------------------------------------------------------------

test("the game ends when the board is exhausted", () => {
  const { room, players } = startedRoom(1);
  const player = players[0]!;
  const total = allClues(room).length;
  assert.ok(total > 0);

  for (let i = 0; i < total; i++) {
    const clue = allClues(room).find((c) => !c.consumed);
    assert.ok(clue, `expected an unconsumed clue at step ${i}`);
    assert.equal(game.pickClue(room, clue.id).ok, true);
    assert.equal(game.openBuzzers(room).ok, true);
    assert.equal(game.buzz(room, player.id).ok, true);
    assert.equal(game.judge(room, player.id, true).ok, true);
    assert.equal(game.nextClue(room).ok, true);
  }

  assert.equal(room.phase, "GAME_OVER");
  assert.equal(game.standings(room)[0]?.name, player.name);
});

test("standings rank by score then join order", () => {
  const { room, players } = startedRoom(3);
  players[2]!.score = 400;
  players[0]!.score = 400;
  players[1]!.score = 100;

  const table = game.standings(room);
  assert.deepEqual(
    table.map((s) => s.name),
    ["Player 1", "Player 3", "Player 2"],
  );
  assert.deepEqual(
    table.map((s) => s.rank),
    [1, 2, 3],
  );
});
