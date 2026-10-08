# SPEC: Buzz — a Jeopardy-style multiplayer web game

Status: **steps 0–3 implemented** (monorepo, rooms, buzzer core). See §14 for the
roadmap and exactly what is and isn't built.
Companion docs: `README` section at the end (§16).

---

## 1. Concept

A host runs the game on a large screen. Players join from their phones with a 4-letter
code and a display name. The host drives the board and judges answers; phones are buzzers
that light up only when the server unlocks them.

The server is the single source of truth. Clients render state and send intent; the server
accepts or rejects. No client ever decides who buzzed first, who won a clue, or what a score is.

**Non-goals (v1):** accounts, persistence across restarts, matchmaking, public rooms,
audio/video, native apps, offline play.

---

## 2. Roles & clients

| Role | Device | Route | Can do |
|---|---|---|---|
| **Host** | Big screen | `/host` | Create room, start, pick clues, open buzzers, judge, close clue, advance, end game |
| **Player** | Phone | `/play` | Join with code + name, buzz, see own score and standings |
| **Landing** | Any | `/` | Health/connection status, links to both routes |

Routing is client-side (`pushState`); the server is a single HTTP + websocket origin.

---

## 3. Rooms and identity

- **Code:** exactly 4 letters from a confusable-free alphabet (`ABCDEFGHJKLMNPQRSTUVWXYZ`,
  no `I/O/0/1`) → 331,776 rooms. Generated server-side, retried on collision.
- **Normalisation:** player input is upper-cased and stripped of any character that could
  not appear in a code, so `" a-cd "`, `"abcd"` and `"AB0D"` all reduce to valid input.
- **Identity is a token, not a socket.** `host:create` returns a `hostToken`; `player:join`
  returns a `playerId` + `playerToken`. The client stores `{ role, code, token }` in
  `localStorage` and re-acquires its seat with `session:resume` after any reload or
  reconnect. Tokens are UUIDs; the player id is *not* a credential.
- **Names** are trimmed, whitespace-collapsed, capped at 20 chars, and **de-duplicated**
  rather than rejected (`Alex` → `alex (2)` → `Alex (3)`). A party game should not block
  anyone at the door.
- **Capacity:** 16 players per room.
- **Late joining:** refused once the game has started (`GAME_ALREADY_STARTED`). Reconnecting
  is the supported mid-game path. See Q7.

---

## 4. Authoritative state model

All state lives in an in-memory `Map<code, Room>`.

```
Room {
  code, createdAt, lastActivityAt
  phase: LOBBY | BOARD | CLUE_SHOWN | BUZZING_OPEN | ANSWERING | RESOLVED | GAME_OVER
  hostSocketId | null, hostToken
  players: Map<playerId, RoomPlayer>
  board: Category[]
  activeClue: ActiveClue | null
  lockedOut: Set<playerId>       // barred from the CURRENT clue only
  buzzSeq: number                // monotonic; audit counter, not a public tiebreak
}

RoomPlayer { id, token, name, score, connected, joinedAt, socketId | null }
Category   { title, clues: Clue[] }
Clue       { id, value, question, answer, revealed, consumed, answeredBy, answeredCorrectly }
ActiveClue { clueId, shownAt, buzzingOpenedAt, buzzOrder[], currentAnswerer, attempts[] }
```

### Projections — the only thing clients see

Built in `server/src/project.ts`, which is the single place that decides visibility:

- **Host** (`HostState`): the full board *including answers*, the locked-out set, scores.
  The host is the judge, so the host sees answers.
- **Player** (`PlayerState`): category titles and clue values, **never a clue's answer while
  that clue is live** (`answer: null`), own score, roster, standings, `canBuzz`, `lockedOut`.
- The answer reaches phones only once the phase is `RESOLVED`/`GAME_OVER`.
- Enforced by construction *and* by test: `server/src/socket.test.ts` asserts a phone's
  projection contains no `answer` key at all and that `activeClue.answer` is null mid-clue.

---

## 5. Game flow — a server-enforced state machine

```
        create           start (≥1 player)              next / board exhausted
  ∅ ──────────► LOBBY ──────────────────► BOARD ◄──────────────────────┐
                         (lobby: code,     │                            │
                          roster, start)   │ host picks clue            │
                                           ▼                            │
                                     CLUE_SHOWN ──── host closes ───────┤
                                           │ host opens buzzers         │
                                           ▼                            │
                                     BUZZING_OPEN ─┐                    │
                                           │       │ wrong answer,      │
                                           │       │ others eligible    │
                                           │       └────────┐           │
                                     first buzz │          │           │
                                           ▼    │          │           │
                                       ANSWERING ┘          │           │
                                           │ judge          │           │
                                           ├── correct ──► RESOLVED ────┘
                                           └── wrong, nobody left ──► RESOLVED
```

### Rules, precisely

- **Two host actions, not one.** `CLUE_SHOWN` reveals the clue with buzzers **locked**;
  the host then presses **Open buzzers**. This exists because the host reads the clue aloud.
- **The race.** `game.buzz()` is fully **synchronous**. It checks the phase, claims the
  winner, flips the phase to `ANSWERING` and bumps `buzzSeq` in one indivisible block. Any
  later buzz — including one handled microseconds later in the same event-loop tick —
  observes a non-`BUZZING_OPEN` phase and is rejected. *This is the entire correctness
  argument for "first buzz wins", and it is why these functions must never become async.*
- **Arrival order is the truth.** Client clocks are never used for ordering. Socket.IO
  preserves order per-connection; across connections, server handling order decides.
- **Losing is not an error.** A rejected buzz returns a neutral `reason`:
  `too_late` (someone already won), `locked_out` (barred from this clue), or
  `buzzers_closed` (wrong phase). Phones render "Too slow", not a failure.
- **Wrong answers:** *no score deduction* (decided — see Q4). The player is added to
  `lockedOut` for that clue only, and buzzing **reopens** for everyone still eligible.
  If nobody is eligible, the phase goes to `RESOLVED` and the host moves on; the clue is
  burned with no winner.
- **Correct answers:** `score += clue.value`, clue consumed, phase `RESOLVED`.
- **Attempts are unbounded** per clue (everyone can try once, in effect, because each wrong
  answer locks that player out).
- **Board exhaustion:** `next` from the last clue lands on `GAME_OVER`.
- **Consumed clues** cannot be picked again, and consumed tiles are disabled on the host grid.

---

## 6. Wire protocol (Socket.IO)

Typed end-to-end by `shared/types.ts`. That module is deliberately **type-only** (no runtime
exports) so both tsx and Vite erase it — do not add runtime values without giving it a build step.

### Client → Server

| Event | Payload | Ack | Legal phase |
|---|---|---|---|
| `host:create` | — | `CreateResult` | — |
| `session:resume` | `{ code, token }` | `ResumeResult` | any |
| `player:join` | `{ code, name }` | `JoinResult` | LOBBY |
| `host:start` | `{ code, hostToken }` | — | LOBBY |
| `host:pickClue` | `{ code, hostToken, clueId }` | — | BOARD |
| `host:openBuzzers` | `{ code, hostToken }` | — | CLUE_SHOWN |
| `host:judge` | `{ code, hostToken, playerId, correct }` | — | ANSWERING |
| `host:closeClue` | `{ code, hostToken }` | — | CLUE_SHOWN / BUZZING_OPEN / ANSWERING |
| `host:next` | `{ code, hostToken }` | — | RESOLVED |
| `host:endGame` | `{ code, hostToken }` | — | any |
| `player:buzz` | `{ code }` | `BuzzResult` | BUZZING_OPEN |

`player:buzz` carries **no secret** — the socket is already authenticated by join/resume,
and a buzz is on the hot path. The socket's own seat is what counts, not the payload.

### Server → Client

| Event | Payload | Audience |
|---|---|---|
| `room:state` | role-filtered `HostState` \| `PlayerState` | on join/resume + **every** accepted transition |
| `room:error` | `{ code, message }` | the offending socket only |
| `buzzed` | `{ playerId, name }` | all (banner/flash/haptic) |
| `buzzers:open` | `{ clueId }` | all (arms phones, vibrates) |
| `judged` | `{ playerId, name, correct, delta, newScore }` | all (score animation, sound) |
| `game:over` | `{ standings }` | all |

State is pushed as a **whole role-filtered snapshot** on every transition rather than as
deltas: clients never compute game state, and there is no drift to reconcile.

### Recovery

A reconnecting client presents its stored token via `session:resume` and receives a full
snapshot. Seats survive disconnection — only `connected` flips false, so score, lockout
state and phase are all restored. Host reconnect re-attaches `hostSocketId`.

---

## 7. Anti-cheat / fairness properties

- Only the server decides the buzz winner; client timestamps are discarded.
- Answers never reach player clients while a clue is live (enforced in `project.ts`, asserted in tests).
- Host actions validate `hostToken`; players cannot call host events.
- A buzz is validated against the socket's own authenticated seat, so a player cannot buzz as someone else.
- **Not yet built:** per-socket rate limiting; a code blocklist (Q16); ping-based latency compensation (Q11).

---

## 8. UI requirements

### Host
- **Lobby** (phase `LOBBY`): giant join code, live roster (offline players dimmed), Start
  disabled until ≥1 player. *Note: the lobby is a phase, not the absence of a room — a host
  who just created a room must still see the code.*
- **Board:** category columns, value tiles, consumed tiles dimmed/disabled.
- **Clue panel:** question, value, who buzzed, phase-gated controls
  (Open buzzers / Correct / Incorrect / Close clue / Next clue), and a hint line.
  The answer sits behind a **Show answer** toggle that resets on every new clue, so it can't
  leak onto the big screen by accident.
- Scoreboard always visible; final standings on `GAME_OVER`.

### Player (phone)
- **Join form:** 4-char code input (auto-uppercase, letter-spaced), name field, disabled
  until connected.
- **Buzzer:** full-height, huge tap target, `touch-action: manipulation` (no double-tap zoom),
  fires on `pointerdown` rather than `click`. States: `waiting`, `locked` ("Get ready…"),
  `armed` ("TAP!", pulsing), `you-buzzed`, `too-slow`, `locked-out`, plus the clue question
  and, at `RESOLVED`, the answer. Vibration on arming and on tap where supported.
- Own score and live standings.

---

## 9. Tech stack

- **Node.js** (≥20; developed on 25) + **Express 4** + **Socket.IO 4**.
- **Client:** **Vite 7 + React 19** (decided — Q13), TypeScript everywhere, strict mode with
  `noUncheckedIndexedAccess` and `verbatimModuleSyntax`.
- **Monorepo:** npm workspaces — `shared/`, `server/`, `client/`.
- **State:** in-memory only, single process (Q12, Q15).
- **Tests:** `node:test` via tsx. Server tests hit the real state machine and real
  websockets; client tests render every screen/phase to markup.
- **Dev:** one `npm run dev` starts the server on `:3001` and Vite on `:5173`, with Vite
  proxying `/socket.io` and `/health` so the browser sees a single origin.

```
shared/types.ts        socket contract + domain types (type-only)
server/src/rooms.ts    room store: codes, players, tokens, board helpers, sweeper
server/src/game.ts     pure synchronous state machine
server/src/project.ts  role-filtered projections (answer visibility)
server/src/server.ts   socket handlers
server/src/index.ts    boot: env parsing, sweeper, graceful shutdown
server/src/board.ts    PLACEHOLDER clue set (step 5 replaces it)
client/src/useGame.ts  socket lifecycle, session resume, actions
client/src/session.ts  localStorage credentials
client/src/screens/*   HostScreen, PlayerScreen
```

---

## 10. Edge cases handled

1. Two buzzes in the same tick → server arrival order decides; loser gets `too_late`.
2. Player buzzes then disconnects before answering → **not yet handled** (Q8).
3. Host refreshes → reconnects with `hostToken`, full state re-emitted.
4. Player refreshes mid-clue → token restores score, lockout and phase.
5. Buzz racing a phase change → rejected with `buzzers_closed`, no state change.
6. Duplicate buzz from the winner → phase is `ANSWERING`, so `too_late`.
7. Name collision → auto-suffixed, never rejected.
8. Disconnected players are excluded from `eligibleBuzzers`, so a room full of offline
   phones can't leave buzzing open forever.
9. Long names / messy codes → normalised and capped server-side.
10. Sprinting host double-clicks → every transition is phase-gated and rejected if illegal.
11. Client clocks are ignored for all ordering.
12. Port env vars: `PORT=0` or `PORT=` are **ignored**, not honoured — naive `??` handling
    silently binds an ephemeral port (this bit us once).

---

## 11. Room lifecycle / cleanup

- `lastActivityAt` updates on every accepted action and connect/disconnect.
- Sweeper every 60s (unref'd) deletes rooms idle beyond `ROOM_TTL_MS` (default 2h) **that
  have no attached sockets**.
- On `GAME_OVER` the room is kept so the host can restart; it expires normally.
- Server restart drops all rooms (accepted for v1).

---

## 12. Open questions

Decided items are recorded with the decision, not removed.

| # | Question | Status |
|---|---|---|
| Q1 | Answer mode: verbal (host judges by ear) vs. typed with countdown | **Open.** Verbal assumed; typed input is not built. |
| Q2 | Buzzers opened manually by host vs. auto after N seconds | **Decided:** manual (host reads the clue aloud first). |
| Q3 | Minimum players to start | **Decided:** ≥1. |
| Q4 | Wrong-answer penalty | **Decided:** *no score deduction* — lockout only, Jeopardy-style. Clue value is never subtracted. |
| Q5 | Automatic answer matching | **Open.** Not built; every answer is host-judged. |
| Q6 | Stealing / attempt limits / host override | **Decided:** the clue reopens to all non-locked-out players, effectively one attempt each; no host override. |
| Q7 | Late joining after start | **Decided (revisit):** currently *refused*. Originally specced to allow with 0 score. Reconnecting is the supported path. |
| Q8 | Player disconnects while answering | **Open.** No grace timer yet — the clue stays in `ANSWERING` until the host acts. Recommended: brief grace, then treat as incorrect. |
| Q9 | Separate read-only board/display screen | **Open.** Not built. Cheap now, awkward to retrofit. |
| Q10 | Can the host also play? | **Decided:** no. |
| Q11 | Surface latency / "you were N ms late" | **Open.** Phones show only "Too slow". Ping compensation is a later feature, deliberately not first. |
| Q12 | Scaling beyond one process | **Decided for v1:** single process, in-memory. `InterServerEvents` is reserved for a Redis adapter. |
| Q13 | Client framework | **Decided:** Vite + React 19. |
| Q14 | Board authoring | **Open.** A placeholder 2×2 board is hardcoded; step 5 loads a 6×5 JSON board. |
| Q15 | Persistence | **Decided:** in-memory only. |
| Q16 | Code alphabet / blocklist | **Half-decided:** 4 letters from a confusable-free alphabet; no profanity blocklist yet. |
| Q17 | Reconnect identity | **Decided:** opaque token in `localStorage`; name is display only. |
| Q18 | No-buzz timeout | **Open.** Waits for the host indefinitely; no timer. |

---

## 13. Acceptance criteria

Built and covered by tests:

- [x] Host creates a room; a unique 4-letter code is returned.
- [x] Players join by code + name and appear in the live host roster.
- [x] Names de-duplicate rather than collide.
- [x] Host picks a clue; players see the question and **not** the answer; buzzers locked.
- [x] The first buzz **the server receives** wins and locks everyone else out.
- [x] Late buzzers get a neutral "too slow".
- [x] Correct → score rises by the clue value, clue consumed.
- [x] Incorrect → no deduction, that player locked out, buzzing reopens for the rest.
- [x] Nobody eligible → clue resolves with no winner; host advances.
- [x] Reconnect (phone or host) restores seat, score and phase.
- [x] Board exhausted → final standings.
- [x] Automated tests reproduce the buzz race deterministically, both in-process and over
      real websockets with five independent clients.

Not yet:

- [ ] Typed answers, buzz timeouts, pre-read buzz penalty (step 4).
- [ ] JSON 6×5 board, Daily Double, Final Jeopardy (step 5).
- [ ] Rate limiting, deploy artefacts, wake lock, sound (steps 7–8).

---

## 14. Roadmap status

| Step | Scope | Status |
|---|---|---|
| 0 | `SPEC.md` | ✅ done |
| 1 | Monorepo: `server` + `client`, health check, shared types, one `npm run dev` | ✅ done |
| 2 | Rooms: create/join, live lobby, "you're in", reconnect via `localStorage` | ✅ done |
| 3 | Buzzer core: phase machine, first-buzz-wins, 5-simultaneous-buzz test | ✅ done |
| 4 | Fairness: pre-read lockout, buzz timeout, wrong-answer block | ⬜ next (the block already exists; timeout + pre-read penalty do not) |
| 5 | Board + scoring: 6×5 JSON board, then Daily Double / Final Jeopardy | ⬜ placeholder board only |
| 6 | Clue-set editor (paste JSON/CSV) | ⬜ |
| 7 | Polish: TV styling, haptics, sound, Wake Lock | ⬜ partially (haptics + phone styling exist) |
| 8 | Deploy (Docker/Render), env vars, rate limiting, 2h room cleanup | ⬜ cleanup exists; deploy + rate limiting do not |

---

## 15. Testing

`npm test` runs both workspaces (38 tests).

**Server — `server/src/game.test.ts`** (pure state machine): code generation and
normalisation, name de-duplication, phase gating, consumed-clue rejection, the race in both
directions, out-of-phase buzz reasons, scoring, lockout-and-reopen, nobody-eligible
resolution, disconnect eligibility, board exhaustion, standings order.

**Server — `server/src/socket.test.ts`** (real websockets): live roster growth, the
five-simultaneous-buzz race across five independent sockets, buzz refused in the wrong
phase, reconnect restoring score, bad-token refusal, late-join refusal, and answer secrecy.

**Client — `client/test/render.test.tsx`**: every screen rendered in every phase — host
lobby/board/clue/final, answer hidden by default, controls gated per phase, phone join form,
armed vs. locked-out buzzer, winner vs. loser states, and the answer only appearing at
`RESOLVED`.

Two real bugs were caught by these tests rather than by reading the code:
1. `normalizeCode` accepted spaces, so a pasted `"a b"` never matched a room.
2. `HostScreen` treated any host state as "in game", so a freshly created room rendered the
   **board** instead of the lobby — no join code, no roster, no Start button.

---

## 16. Running it

```bash
npm install
npm run dev      # server :3001, client :5173
npm test
npm run typecheck
npm run build
```

Open `/host` on the big screen, `/play` on phones. Health check at `/health`.
`PORT`, `ROOM_TTL_MS`, `SWEEP_INTERVAL_MS` are overridable via env.
