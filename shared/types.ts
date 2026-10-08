/**
 * Shared socket event contract + domain types for Buzz.
 *
 * TYPE-ONLY (no runtime exports) — both the server (tsx) and the client (Vite)
 * consume it via `import type`, so nothing here is bundled or resolved at
 * runtime. Add a build step before introducing runtime values.
 *
 * Event maps plug into Socket.IO generics for end-to-end typing:
 *   server: new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(...)
 *   client: Socket<ServerToClientEvents, ClientToServerEvents>
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** 4 letters from a confusable-free alphabet. */
export type RoomCode = string;

/** Secret that identifies a seat (host or player) across reconnects. */
export type SessionToken = string;

export type HostToken = SessionToken;
export type PlayerToken = SessionToken;

export type PlayerId = string;

/**
 * Room lifecycle. Host-driven transitions only (SPEC §5).
 *
 *   LOBBY ──start──► BOARD ──pick──► CLUE_SHOWN ──open──► BUZZING_OPEN
 *                        ▲                                    │ first buzz
 *                        │                                    ▼
 *                        └──── next ◄── RESOLVED ◄── judge ── ANSWERING
 *                                                            │ wrong answer and
 *                                                            └► back to BUZZING_OPEN
 */
export type RoomPhase =
  | "LOBBY"
  | "BOARD"
  | "CLUE_SHOWN"
  | "BUZZING_OPEN"
  | "ANSWERING"
  | "RESOLVED"
  | "GAME_OVER";

export type Role = "host" | "player";

/** Room codes are exactly this many letters. Kept as a type so this module stays
 *  runtime-free; both sides declare their own constant from it. */
export type RoomCodeLength = 4;

// ---------------------------------------------------------------------------
// Domain model (server-authoritative — SPEC §4)
// ---------------------------------------------------------------------------

export interface Clue {
  id: string;
  value: number;
  /** Shown to everyone once revealed. */
  question: string;
  /** Withheld from player clients until the clue resolves. */
  answer: string;
  revealed: boolean;
  consumed: boolean;
  answeredBy: PlayerId | null;
  answeredCorrectly: boolean | null;
}

export interface Category {
  title: string;
  clues: Clue[];
}

export interface Attempt {
  playerId: PlayerId;
  correct: boolean;
  at: number;
}

export interface ActiveClue {
  clueId: string;
  shownAt: number;
  buzzingOpenedAt: number | null;
  /** Accepted buzzes in server-arrival order — the audit log of the race. */
  buzzOrder: PlayerId[];
  currentAnswerer: PlayerId | null;
  attempts: Attempt[];
}

export interface Standing {
  playerId: PlayerId;
  name: string;
  score: number;
  rank: number;
}

// ---------------------------------------------------------------------------
// Projections — what each role is allowed to see
// ---------------------------------------------------------------------------

/** Clue without the answer, for players (SPEC §7). */
export interface PublicClue {
  id: string;
  value: number;
  revealed: boolean;
  consumed: boolean;
}

export interface PublicCategory {
  title: string;
  clues: PublicClue[];
}

export interface PublicPlayer {
  id: PlayerId;
  name: string;
  score: number;
  connected: boolean;
}

/** The clue on screen. `answer` is null for players until the clue resolves. */
export interface ActiveClueView {
  clueId: string;
  category: string;
  value: number;
  question: string;
  answer: string | null;
  currentAnswerer: PlayerId | null;
  /** Players locked out of this clue (empty for players other than self). */
  lockedOut: PlayerId[];
  buzzCount: number;
}

export interface BaseState {
  code: RoomCode;
  phase: RoomPhase;
  players: PublicPlayer[];
  standings: Standing[];
  activeClue: ActiveClueView | null;
  /** Clues remaining on the board, for the host's grid. */
  remainingClues: number;
}

export interface HostState extends BaseState {
  role: "host";
  /** Full board including answers. */
  board: Category[];
}

export interface PlayerState extends BaseState {
  role: "player";
  playerId: PlayerId;
  name: string;
  score: number;
  /** Answer text or answer already revealed — null while the clue is live. */
  board: PublicCategory[];
  /** True iff the server would currently accept a buzz from this player. */
  canBuzz: boolean;
  /** True iff this player is barred from the current clue. */
  lockedOut: boolean;
}

export type RoomState = HostState | PlayerState;

// ---------------------------------------------------------------------------
// Socket.IO event maps
// ---------------------------------------------------------------------------

/** Client → Server. */
export interface ClientToServerEvents {
  /** Creates a room; the ack carries the code and host token. */
  "host:create": (ack: (res: CreateResult) => void) => void;

  "host:start": (payload: { code: RoomCode; hostToken: HostToken }) => void;

  "host:pickClue": (payload: {
    code: RoomCode;
    hostToken: HostToken;
    clueId: string;
  }) => void;

  "host:openBuzzers": (payload: { code: RoomCode; hostToken: HostToken }) => void;

  "host:judge": (payload: {
    code: RoomCode;
    hostToken: HostToken;
    playerId: PlayerId;
    correct: boolean;
  }) => void;

  /** Closes the clue with no winner (nobody buzzed, or everyone is locked out). */
  "host:closeClue": (payload: { code: RoomCode; hostToken: HostToken }) => void;

  /** RESOLVED → next clue (BOARD) or GAME_OVER when the board is exhausted. */
  "host:next": (payload: { code: RoomCode; hostToken: HostToken }) => void;

  "host:endGame": (payload: { code: RoomCode; hostToken: HostToken }) => void;

  "player:join": (
    payload: { code: RoomCode; name: string },
    ack: (res: JoinResult) => void,
  ) => void;

  /**
   * The socket is already authenticated by join/resume, so a buzz carries no
   * secret — just the room it believes it is in. Sent on the hot path, so keep
   * this payload minimal.
   */
  "player:buzz": (
    payload: { code: RoomCode },
    ack: (res: BuzzResult) => void,
  ) => void;

  /** Reconnect using the stored token — host or player, the server figures out which. */
  "session:resume": (
    payload: { code: RoomCode; token: SessionToken },
    ack: (res: ResumeResult) => void,
  ) => void;
}

/** Server → Client. */
export interface ServerToClientEvents {
  /** Full role-filtered snapshot, emitted on every accepted transition. */
  "room:state": (state: RoomState) => void;

  /** Targeted, non-fatal problem. */
  "room:error": (payload: { code: ErrorCode; message: string }) => void;

  /** First buzz of a window won — for the banner/flash on all devices. */
  "buzzed": (payload: { playerId: PlayerId; name: string }) => void;

  "buzzers:open": (payload: { clueId: string }) => void;

  /** A judgement landed; for score-animation and sound effects. */
  "judged": (payload: {
    playerId: PlayerId;
    name: string;
    correct: boolean;
    delta: number;
    newScore: number;
  }) => void;

  "game:over": (payload: { standings: Standing[] }) => void;
}

/** Reserved for multi-node fan-out behind a Redis adapter later (SPEC Q12). */
export interface InterServerEvents {
  "room:sync": (payload: { code: RoomCode }) => void;
}

export interface SocketData {
  role: Role | null;
  roomCode: RoomCode | null;
  playerId: PlayerId | null;
  /** Token presented on join/resume, kept so re-emits can re-authenticate. */
  token: SessionToken | null;
}

// ---------------------------------------------------------------------------
// Ack payloads
// ---------------------------------------------------------------------------

export type ErrorCode =
  | "ROOM_NOT_FOUND"
  | "ROOM_FULL"
  | "NAME_INVALID"
  | "GAME_ALREADY_STARTED"
  | "UNAUTHORIZED"
  | "ILLEGAL_PHASE"
  | "CLUE_UNAVAILABLE"
  | "BAD_REQUEST";

export type CreateResult =
  | { ok: true; code: RoomCode; hostToken: HostToken; state: HostState }
  | { ok: false; code: ErrorCode; message: string };

export type JoinResult =
  | { ok: true; playerId: PlayerId; playerToken: PlayerToken; state: PlayerState }
  | { ok: false; code: ErrorCode; message: string };

export type BuzzResult =
  | { ok: true; won: boolean; seq: number }
  | { ok: false; code: ErrorCode; reason: BuzzRejectReason; message: string };

export type ResumeResult =
  | { ok: true; state: RoomState }
  | { ok: false; code: ErrorCode; message: string };

/** Non-fatal outcomes shown neutrally on the phone ("too slow"). */
export type BuzzRejectReason = "too_late" | "locked_out" | "buzzers_closed";
