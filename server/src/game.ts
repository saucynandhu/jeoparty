/**
 * Room state machine (SPEC §5).
 *
 * Every function here is SYNCHRONOUS and free of I/O. That is a correctness
 * requirement, not a style preference: Node runs one event-loop tick at a time,
 * so a synchronous check-and-set is atomic with respect to other sockets. The
 * "first buzz wins" guarantee depends on `buzz()` never awaiting between
 * checking the phase and claiming the winner — do not make these async.
 */

import type {
  BuzzRejectReason,
  ErrorCode,
  PlayerId,
  RoomPhase,
  Standing,
} from "@buzz/shared";
import type { Room } from "./rooms.js";
import { findClue, remainingClueCount, touchRoom } from "./rooms.js";

export type ActionResult = { ok: true } | { ok: false; code: ErrorCode; message: string };

export type BuzzOutcome =
  | { ok: true; won: boolean; seq: number }
  | { ok: false; code: ErrorCode; reason: BuzzRejectReason; message: string };

const pass = (): ActionResult => ({ ok: true });
const fail = (code: ErrorCode, message: string): ActionResult => ({ ok: false, code, message });

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Connected players who are still allowed to buzz on the current clue. */
export function eligibleBuzzers(room: Room): PlayerId[] {
  return [...room.players.values()]
    .filter((player) => player.connected && !room.lockedOut.has(player.id))
    .map((player) => player.id);
}

/** Would the server accept a buzz from this player right now? */
export function canPlayerBuzz(room: Room, playerId: PlayerId): boolean {
  if (room.phase !== "BUZZING_OPEN") return false;
  const player = room.players.get(playerId);
  if (!player || !player.connected) return false;
  return !room.lockedOut.has(playerId);
}

export function standings(room: Room): Standing[] {
  return [...room.players.values()]
    .sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt)
    .map((player, index) => ({
      playerId: player.id,
      name: player.name,
      score: player.score,
      rank: index + 1,
    }));
}

// ---------------------------------------------------------------------------
// Host transitions
// ---------------------------------------------------------------------------

export function startGame(room: Room): ActionResult {
  if (room.phase !== "LOBBY") {
    return fail("ILLEGAL_PHASE", `The game has already started (${room.phase}).`);
  }
  if (room.players.size === 0) {
    return fail("ILLEGAL_PHASE", "At least one player must join before starting.");
  }
  room.phase = "BOARD";
  touchRoom(room);
  return pass();
}

export function pickClue(room: Room, clueId: string): ActionResult {
  if (room.phase !== "BOARD") {
    return fail("ILLEGAL_PHASE", `Cannot pick a clue while the room is ${room.phase}.`);
  }
  const clue = findClue(room, clueId);
  if (!clue) return fail("CLUE_UNAVAILABLE", "No clue with that id.");
  if (clue.consumed) return fail("CLUE_UNAVAILABLE", "That clue has already been played.");

  clue.revealed = true;
  room.lockedOut = new Set();
  room.activeClue = {
    clueId,
    shownAt: Date.now(),
    buzzingOpenedAt: null,
    buzzOrder: [],
    currentAnswerer: null,
    attempts: [],
  };
  room.phase = "CLUE_SHOWN";
  touchRoom(room);
  return pass();
}

/** Host finishes reading the clue aloud and arms the buzzers. */
export function openBuzzers(room: Room): ActionResult {
  if (room.phase !== "CLUE_SHOWN") {
    return fail("ILLEGAL_PHASE", `Buzzers can only open while a clue is shown (${room.phase}).`);
  }
  if (!room.activeClue) return fail("ILLEGAL_PHASE", "There is no active clue.");
  if (eligibleBuzzers(room).length === 0) {
    return fail("ILLEGAL_PHASE", "No connected player is eligible to buzz.");
  }
  room.activeClue.buzzingOpenedAt = Date.now();
  room.phase = "BUZZING_OPEN";
  touchRoom(room);
  return pass();
}

/**
 * THE race. Accepts exactly one buzz per window.
 *
 * The phase flip to ANSWERING happens inside this synchronous block, so any
 * buzz that arrives afterwards — including one handled microseconds later in
 * the same tick — observes a non-BUZZING_OPEN phase and is rejected. That is
 * what "locks everyone else out" means mechanically.
 */
export function buzz(room: Room, playerId: PlayerId, now = Date.now()): BuzzOutcome {
  if (room.phase !== "BUZZING_OPEN") {
    const reason: BuzzRejectReason =
      room.phase === "ANSWERING" || room.phase === "RESOLVED" ? "too_late" : "buzzers_closed";
    return {
      ok: false,
      code: "ILLEGAL_PHASE",
      reason,
      message: `Ignored: buzzers are not open (${room.phase}).`,
    };
  }

  const player = room.players.get(playerId);
  if (!player) {
    return { ok: false, code: "UNAUTHORIZED", reason: "buzzers_closed", message: "Unknown player." };
  }
  if (!player.connected) {
    return { ok: false, code: "UNAUTHORIZED", reason: "buzzers_closed", message: "Player is not connected." };
  }
  if (room.lockedOut.has(playerId)) {
    return {
      ok: false,
      code: "ILLEGAL_PHASE",
      reason: "locked_out",
      message: "You are locked out of this clue.",
    };
  }

  const active = room.activeClue;
  if (!active) {
    return { ok: false, code: "ILLEGAL_PHASE", reason: "buzzers_closed", message: "There is no active clue." };
  }

  // --- atomic claim ---
  room.buzzSeq += 1;
  active.buzzOrder.push(playerId);
  active.currentAnswerer = playerId;
  room.phase = "ANSWERING";
  touchRoom(room);

  return { ok: true, won: true, seq: room.buzzSeq };
}

/**
 * Host judges the answer.
 *
 * Correct: +value, clue consumed, RESOLVED.
 * Incorrect: NO score deduction (decision: Jeopardy-style lockout), the player
 * is barred from the clue, and buzzing reopens for everyone else if anyone is
 * still eligible — otherwise the clue resolves with no winner.
 */
export function judge(
  room: Room,
  playerId: PlayerId,
  correct: boolean,
  now = Date.now(),
): ActionResult {
  if (room.phase !== "ANSWERING") {
    return fail("ILLEGAL_PHASE", `Nothing to judge while the room is ${room.phase}.`);
  }
  const active = room.activeClue;
  if (!active) return fail("ILLEGAL_PHASE", "There is no active clue.");
  if (active.currentAnswerer !== playerId) {
    return fail("UNAUTHORIZED", "That player is not the one answering.");
  }
  const player = room.players.get(playerId);
  if (!player) return fail("UNAUTHORIZED", "Unknown player.");
  const clue = findClue(room, active.clueId);
  if (!clue) return fail("CLUE_UNAVAILABLE", "The active clue has vanished.");

  active.attempts.push({ playerId, correct, at: now });

  if (correct) {
    player.score += clue.value;
    clue.consumed = true;
    clue.answeredBy = playerId;
    clue.answeredCorrectly = true;
    room.phase = "RESOLVED";
  } else {
    room.lockedOut.add(playerId);
    active.currentAnswerer = null;
    if (eligibleBuzzers(room).length > 0) {
      active.buzzingOpenedAt = now;
      room.phase = "BUZZING_OPEN";
    } else {
      room.phase = "RESOLVED"; // nobody left — host reveals and moves on
    }
  }

  touchRoom(room);
  return pass();
}

/** Abandons the current clue mid-flight (nobody buzzed, or everyone is locked out). */
export function closeClue(room: Room): ActionResult {
  const closable: RoomPhase[] = ["CLUE_SHOWN", "BUZZING_OPEN", "ANSWERING"];
  if (!closable.includes(room.phase)) {
    return fail("ILLEGAL_PHASE", `There is no live clue to close (${room.phase}).`);
  }
  return advance(room);
}

/** RESOLVED → next clue, or GAME_OVER when the board is exhausted. */
export function nextClue(room: Room): ActionResult {
  if (room.phase !== "RESOLVED") {
    return fail("ILLEGAL_PHASE", `Cannot advance from ${room.phase}.`);
  }
  return advance(room);
}

export function endGame(room: Room): ActionResult {
  if (room.phase === "GAME_OVER") return fail("ILLEGAL_PHASE", "The game is already over.");
  room.activeClue = null;
  room.lockedOut = new Set();
  room.phase = "GAME_OVER";
  touchRoom(room);
  return pass();
}

/** Clears the active clue, burning it if nobody won it, then picks the next phase. */
function advance(room: Room): ActionResult {
  const active = room.activeClue;
  if (active) {
    const clue = findClue(room, active.clueId);
    if (clue && !clue.consumed) {
      clue.consumed = true;
      clue.answeredBy = null;
      clue.answeredCorrectly = false;
    }
  }
  room.activeClue = null;
  room.lockedOut = new Set();
  room.phase = remainingClueCount(room) > 0 ? "BOARD" : "GAME_OVER";
  touchRoom(room);
  return pass();
}
