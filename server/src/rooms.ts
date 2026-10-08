/**
 * In-memory room store (SPEC §3, §11).
 *
 * Rooms are the unit of isolation: every piece of authoritative game state hangs
 * off a Room, and rooms are keyed by their 4-letter code. Single-process only —
 * horizontal scaling needs the Redis adapter (SPEC Q12).
 */

import { randomUUID } from "node:crypto";
import type {
  ActiveClue,
  Category,
  Clue,
  HostToken,
  PlayerId,
  PlayerToken,
  RoomCode,
  RoomPhase,
} from "@buzz/shared";
import { createPlaceholderBoard } from "./board.js";

/** Confusable-free alphabet: no I, O, 0 or 1. */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
export const CODE_LENGTH = 4;

/** Refuse to grow a room past this, to keep one lobby from saturating a host. */
export const MAX_PLAYERS = 16;

export interface RoomPlayer {
  id: PlayerId;
  token: PlayerToken;
  name: string;
  score: number;
  connected: boolean;
  joinedAt: number;
  socketId: string | null;
}

export interface Room {
  code: RoomCode;
  createdAt: number;
  lastActivityAt: number;
  phase: RoomPhase;
  hostSocketId: string | null;
  hostToken: HostToken;
  players: Map<PlayerId, RoomPlayer>;
  board: Category[];
  activeClue: ActiveClue | null;
  /** Players barred from the current clue (wrong answer, or later: early buzz). */
  lockedOut: Set<PlayerId>;
  /** Monotonic per-room buzz counter — never exposed as a winner tiebreak. */
  buzzSeq: number;
}

const rooms = new Map<RoomCode, Room>();

/** Display-name cap. Mirrored on the client; the server is the enforcer. */
export const MAX_NAME = 20;

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------

function randomCode(): RoomCode {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

function uniqueCode(maxAttempts = 25): RoomCode {
  for (let i = 0; i < maxAttempts; i++) {
    const code = randomCode();
    if (!rooms.has(code)) return code;
  }
  throw new Error("Unable to allocate a free room code — room store is saturated");
}

/**
 * Normalizes user input for lookups.
 *
 * Strips everything that cannot appear in a code rather than only trimming, so
 * " a b" , "a-b", "ab cd" and "AB0D" all reduce to letters the store can match.
 * Anything dropped here could never have been part of a real code anyway.
 */
export function normalizeCode(input: string): RoomCode {
  return input
    .toUpperCase()
    .split("")
    .filter((ch) => CODE_ALPHABET.includes(ch))
    .join("")
    .slice(0, CODE_LENGTH);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function createRoom(): Room {
  const now = Date.now();
  const room: Room = {
    code: uniqueCode(),
    createdAt: now,
    lastActivityAt: now,
    phase: "LOBBY",
    hostSocketId: null,
    hostToken: randomUUID(),
    players: new Map(),
    board: createPlaceholderBoard(),
    activeClue: null,
    lockedOut: new Set(),
    buzzSeq: 0,
  };
  rooms.set(room.code, room);
  return room;
}

export function getRoom(code: string): Room | undefined {
  return rooms.get(normalizeCode(code));
}

export function touchRoom(room: Room): void {
  room.lastActivityAt = Date.now();
}

export function deleteRoom(code: RoomCode): boolean {
  return rooms.delete(code);
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

/** Normalizes a display name: trimmed, collapsed whitespace, length-capped. */
export function normalizeName(input: string): string {
  return input.trim().replace(/\s+/g, " ").slice(0, MAX_NAME);
}

/**
 * Names are de-duplicated rather than rejected — a party game should never
 * block someone at the door. "Alex" then becomes "Alex (2)", "Alex (3)", …
 */
export function uniqueName(room: Room, desired: string): string {
  const taken = new Set([...room.players.values()].map((p) => p.name.toLowerCase()));
  if (!taken.has(desired.toLowerCase())) return desired;

  for (let n = 2; n < 100; n++) {
    const suffix = ` (${n})`;
    const candidate = desired.slice(0, MAX_NAME - suffix.length) + suffix;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return desired.slice(0, MAX_NAME - 5) + ` (${randomUUID().slice(0, 3)})`;
}

export function addPlayer(room: Room, desiredName: string): RoomPlayer {
  const player: RoomPlayer = {
    id: randomUUID(),
    token: randomUUID(),
    name: uniqueName(room, desiredName),
    score: 0,
    connected: true,
    joinedAt: Date.now(),
    socketId: null,
  };
  room.players.set(player.id, player);
  touchRoom(room);
  return player;
}

/** Finds a seat by its secret token — how reconnects re-acquire an identity. */
export function findPlayerByToken(room: Room, token: PlayerToken): RoomPlayer | undefined {
  for (const player of room.players.values()) {
    if (player.token === token) return player;
  }
  return undefined;
}

export function isHostToken(room: Room, token: string): boolean {
  return room.hostToken === token;
}

// ---------------------------------------------------------------------------
// Board helpers
// ---------------------------------------------------------------------------

export function allClues(room: Room): Clue[] {
  return room.board.flatMap((category) => category.clues);
}

export function findClue(room: Room, clueId: string): Clue | undefined {
  return allClues(room).find((clue) => clue.id === clueId);
}

export function categoryOf(room: Room, clueId: string): string {
  for (const category of room.board) {
    if (category.clues.some((clue) => clue.id === clueId)) return category.title;
  }
  return "Unknown";
}

export function remainingClueCount(room: Room): number {
  return allClues(room).filter((clue) => !clue.consumed).length;
}

// ---------------------------------------------------------------------------
// Stats + sweeping (SPEC §11)
// ---------------------------------------------------------------------------

export interface StoreStats {
  rooms: number;
  players: number;
  byPhase: Record<RoomPhase, number>;
}

const PHASES: RoomPhase[] = [
  "LOBBY",
  "BOARD",
  "CLUE_SHOWN",
  "BUZZING_OPEN",
  "ANSWERING",
  "RESOLVED",
  "GAME_OVER",
];

export function stats(): StoreStats {
  const byPhase = Object.fromEntries(PHASES.map((p) => [p, 0])) as Record<RoomPhase, number>;
  let players = 0;
  for (const room of rooms.values()) {
    byPhase[room.phase] += 1;
    players += room.players.size;
  }
  return { rooms: rooms.size, players, byPhase };
}

/** Deletes rooms idle for longer than `ttlMs` with no attached sockets. */
export function sweep(ttlMs: number, now = Date.now()): number {
  let removed = 0;
  for (const [code, room] of rooms) {
    const idle = now - room.lastActivityAt;
    const hasSockets =
      room.hostSocketId !== null ||
      [...room.players.values()].some((p) => p.socketId !== null);
    if (idle > ttlMs && !hasSockets) {
      rooms.delete(code);
      removed += 1;
    }
  }
  return removed;
}

export function clearAllRooms(): void {
  rooms.clear();
}
