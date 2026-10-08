/**
 * Role-filtered projections (SPEC §4, §7).
 *
 * This module is the ONLY place that decides what a client may see. The rule it
 * enforces: a player never receives a clue's answer while that clue is live.
 * The host always gets answers because the host is the judge.
 */

import type {
  ActiveClueView,
  HostState,
  PlayerState,
  PublicCategory,
  PublicPlayer,
} from "@buzz/shared";
import type { Room, RoomPlayer } from "./rooms.js";
import { categoryOf, findClue, remainingClueCount } from "./rooms.js";
import { canPlayerBuzz, standings } from "./game.js";

/** Players are listed in join order so the lobby roster is stable. */
function publicPlayers(room: Room): PublicPlayer[] {
  return [...room.players.values()]
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score,
      connected: player.connected,
    }));
}

/** Board without answers. */
function publicBoard(room: Room): PublicCategory[] {
  return room.board.map((category) => ({
    title: category.title,
    clues: category.clues.map((clue) => ({
      id: clue.id,
      value: clue.value,
      revealed: clue.revealed,
      consumed: clue.consumed,
    })),
  }));
}

interface ActiveClueOptions {
  revealAnswer: boolean;
  includeLockedOut: boolean;
}

function activeClueView(room: Room, options: ActiveClueOptions): ActiveClueView | null {
  const active = room.activeClue;
  if (!active) return null;
  const clue = findClue(room, active.clueId);
  if (!clue) return null;

  return {
    clueId: clue.id,
    category: categoryOf(room, clue.id),
    value: clue.value,
    question: clue.question,
    answer: options.revealAnswer ? clue.answer : null,
    currentAnswerer: active.currentAnswerer,
    lockedOut: options.includeLockedOut ? [...room.lockedOut] : [],
    buzzCount: active.buzzOrder.length,
  };
}

export function toHostState(room: Room): HostState {
  return {
    role: "host",
    code: room.code,
    phase: room.phase,
    players: publicPlayers(room),
    standings: standings(room),
    activeClue: activeClueView(room, { revealAnswer: true, includeLockedOut: true }),
    remainingClues: remainingClueCount(room),
    board: room.board,
  };
}

export function toPlayerState(room: Room, player: RoomPlayer): PlayerState {
  const resolved = room.phase === "RESOLVED" || room.phase === "GAME_OVER";

  return {
    role: "player",
    code: room.code,
    phase: room.phase,
    players: publicPlayers(room),
    standings: standings(room),
    // The answer only reaches phones once the clue is finished.
    activeClue: activeClueView(room, { revealAnswer: resolved, includeLockedOut: false }),
    remainingClues: remainingClueCount(room),
    board: publicBoard(room),
    playerId: player.id,
    name: player.name,
    score: player.score,
    canBuzz: canPlayerBuzz(room, player.id),
    lockedOut: room.lockedOut.has(player.id),
  };
}
