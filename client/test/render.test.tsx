/**
 * Render smoke tests.
 *
 * These render the real components to markup for every phase. They are the
 * cheapest guard against the classic UI failure — a screen that throws or shows
 * the wrong affordance for one particular game state. Hooks that need a browser
 * (`useEffect`) simply do not run under `renderToStaticMarkup`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Category, HostState, PlayerId, PlayerState, RoomPhase } from "@buzz/shared";
import type { GameApi } from "../src/useGame";
import { HostScreen } from "../src/screens/HostScreen";
import { PlayerScreen } from "../src/screens/PlayerScreen";

const ANSWER = "What is @buzz/shared?";
const QUESTION = "This package holds the socket event contract shared by server and client.";

function stubGame(overrides: Partial<GameApi> = {}): GameApi {
  return {
    status: "connected",
    state: null,
    error: null,
    notice: null,
    announcement: null,
    createRoom: () => {},
    join: async () => ({ ok: false, code: "BAD_REQUEST", message: "stub" }),
    leave: () => {},
    dismissError: () => {},
    start: () => {},
    pickClue: () => {},
    openBuzzers: () => {},
    judge: () => {},
    closeClue: () => {},
    next: () => {},
    endGame: () => {},
    buzz: async () => null,
    ...overrides,
  };
}

const BOARD: Category[] = [
  {
    title: "Scaffolding",
    clues: [
      {
        id: "c0-q0",
        value: 200,
        question: QUESTION,
        answer: ANSWER,
        revealed: true,
        consumed: false,
        answeredBy: null,
        answeredCorrectly: null,
      },
      {
        id: "c0-q1",
        value: 400,
        question: "Spent clue",
        answer: "n/a",
        revealed: true,
        consumed: true,
        answeredBy: "p1",
        answeredCorrectly: true,
      },
    ],
  },
];

const PLAYERS = [
  { id: "p1", name: "Ana", score: 200, connected: true },
  { id: "p2", name: "Bo", score: 0, connected: true },
];

function hostState(phase: RoomPhase, extra: Partial<HostState> = {}): HostState {
  return {
    role: "host",
    code: "ABCD",
    phase,
    players: PLAYERS,
    standings: PLAYERS.map((player, index) => ({ ...player, playerId: player.id, rank: index + 1 })),
    remainingClues: 1,
    board: BOARD,
    activeClue: null,
    ...extra,
  };
}

function playerState(phase: RoomPhase, extra: Partial<PlayerState> = {}): PlayerState {
  return {
    role: "player",
    code: "ABCD",
    phase,
    players: PLAYERS,
    standings: PLAYERS.map((player, index) => ({ ...player, playerId: player.id, rank: index + 1 })),
    remainingClues: 1,
    board: BOARD.map((category) => ({
      title: category.title,
      clues: category.clues.map((clue) => ({
        id: clue.id,
        value: clue.value,
        revealed: clue.revealed,
        consumed: clue.consumed,
      })),
    })),
    playerId: "p1",
    name: "Ana",
    score: 200,
    canBuzz: false,
    lockedOut: false,
    activeClue: null,
    ...extra,
  };
}

function liveClue(extra: Partial<NonNullable<PlayerState["activeClue"]>> = {}) {
  return {
    clueId: "c0-q0",
    category: "Scaffolding",
    value: 200,
    question: QUESTION,
    answer: null,
    currentAnswerer: null as PlayerId | null,
    lockedOut: [] as PlayerId[],
    buzzCount: 0,
    ...extra,
  };
}

const render = (node: ReactElement) => renderToStaticMarkup(node);

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

test("host lobby shows the creation button before a room exists", () => {
  const html = render(<HostScreen game={stubGame()} />);
  assert.match(html, /Create room/);
});

test("host lobby shows the join code and live roster", () => {
  const html = render(<HostScreen game={stubGame({ state: hostState("LOBBY") })} />);
  assert.match(html, /ABCD/);
  assert.match(html, /Ana/);
  assert.match(html, /Bo/);
  assert.match(html, /Start game/);
});

test("host lobby blocks starting with an empty roster", () => {
  const state = hostState("LOBBY", { players: [], standings: [] });
  const html = render(<HostScreen game={stubGame({ state })} />);
  assert.match(html, /Need at least one player/);
  assert.match(html, /<button[^>]*disabled/);
});

test("host board renders tiles and disables consumed ones", () => {
  const html = render(<HostScreen game={stubGame({ state: hostState("BOARD") })} />);
  assert.match(html, /Scaffolding/);
  assert.match(html, /200/);
  assert.match(html, /tile used/);
});

test("host clue view keeps the answer hidden until asked for", () => {
  const state = hostState("CLUE_SHOWN", { activeClue: liveClue() });
  const html = render(<HostScreen game={stubGame({ state })} />);
  assert.match(html, /Show answer/);
  assert.ok(!html.includes(ANSWER), "the answer must not be on screen by default");
  assert.ok(html.includes("Open buzzers"));
});

test("host controls unlock per phase", () => {
  const answering = hostState("ANSWERING", {
    activeClue: liveClue({ currentAnswerer: "p1" }),
  });
  const html = render(<HostScreen game={stubGame({ state: answering })} />);
  assert.match(html, /Ana buzzed/);
  // Correct / Incorrect must be live in ANSWERING.
  const correctButton = html.match(/<button[^>]*>Correct<\/button>/)?.[0] ?? "";
  assert.ok(correctButton, "expected a Correct button");
  assert.ok(!correctButton.includes("disabled"), "Correct must be enabled in ANSWERING");
  // Open buzzers must not be.
  const openButton = html.match(/<button[^>]*>Open buzzers<\/button>/)?.[0] ?? "";
  assert.ok(openButton.includes("disabled"), "Open buzzers must be off in ANSWERING");
});

test("host sees final scores when the game is over", () => {
  const html = render(<HostScreen game={stubGame({ state: hostState("GAME_OVER") })} />);
  assert.match(html, /Final scores/);
});

test("host surfaces a room error as a banner", () => {
  const html = render(
    <HostScreen game={stubGame({ state: hostState("BOARD"), error: "Illegal phase" })} />,
  );
  assert.match(html, /Illegal phase/);
});

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

test("player sees the join form with no session", () => {
  const html = render(<PlayerScreen game={stubGame()} />);
  assert.match(html, /Join a game/);
  assert.match(html, /ROOM CODE/i);
});

test("player sees a confirmation screen after joining the lobby", () => {
  const html = render(<PlayerScreen game={stubGame({ state: playerState("LOBBY") })} />);
  assert.match(html, /Ana/);
  assert.match(html, /Waiting for the host/);
});

test("player buzzer is armed and tappable only while BUZZING_OPEN", () => {
  const armed = playerState("BUZZING_OPEN", { canBuzz: true, activeClue: liveClue() });
  const html = render(<PlayerScreen game={stubGame({ state: armed })} />);
  assert.match(html, /TAP!/);
  const button = html.match(/<button[^>]*class="buzzer buzzer-armed"[^>]*>/)?.[0] ?? "";
  assert.ok(button, "expected an armed buzzer");
  assert.ok(!button.includes("disabled"), "the armed buzzer must be tappable");

  // Same phase, but this player is locked out.
  const lockedOut = playerState("BUZZING_OPEN", {
    canBuzz: false,
    lockedOut: true,
    activeClue: liveClue(),
  });
  const locked = render(<PlayerScreen game={stubGame({ state: lockedOut })} />);
  assert.match(locked, /Locked out this clue/);
  assert.match(locked, /<button[^>]*disabled[^>]*>/);
});

test("player buzzing is not force-enabled while the clue is merely shown", () => {
  const state = playerState("CLUE_SHOWN", { canBuzz: false, activeClue: liveClue() });
  const html = render(<PlayerScreen game={stubGame({ state })} />);
  assert.match(html, /Get ready/);
  const button = html.match(/<button[^>]*class="buzzer buzzer-locked"[^>]*>/)?.[0] ?? "";
  assert.ok(button.includes("disabled"), "buzzers must be shut while the host reads");
});

test("player who won sees a distinct state from a player who lost the race", () => {
  const winner = playerState("ANSWERING", {
    activeClue: liveClue({ currentAnswerer: "p1", buzzCount: 1 }),
  });
  const winnerHtml = render(<PlayerScreen game={stubGame({ state: winner })} />);
  assert.match(winnerHtml, /You buzzed/);
  assert.match(winnerHtml, /buzzer-you-buzzed/);

  const loser = playerState("ANSWERING", {
    playerId: "p2",
    name: "Bo",
    activeClue: liveClue({ currentAnswerer: "p1", buzzCount: 1 }),
  });
  const loserHtml = render(<PlayerScreen game={stubGame({ state: loser })} />);
  assert.match(loserHtml, /Too slow/);
  assert.match(loserHtml, /buzzer-too-slow/);
});

test("the answer reaches the phone only once the clue resolves", () => {
  const live = playerState("ANSWERING", {
    activeClue: liveClue({ currentAnswerer: "p1" }),
  });
  const liveHtml = render(<PlayerScreen game={stubGame({ state: live })} />);
  assert.ok(!liveHtml.includes(ANSWER), "the answer must not be on the phone mid-clue");

  const done = playerState("RESOLVED", { activeClue: liveClue({ answer: ANSWER }) });
  const doneHtml = render(<PlayerScreen game={stubGame({ state: done })} />);
  assert.match(doneHtml, /Answer: /);
  assert.ok(doneHtml.includes(ANSWER));
});

test("player sees final scores when the game is over", () => {
  const html = render(<PlayerScreen game={stubGame({ state: playerState("GAME_OVER") })} />);
  assert.match(html, /Final scores/);
});
