import { useEffect, useState } from "react";
import type { HostState } from "@buzz/shared";
import type { GameApi } from "../useGame";
import { Standing } from "../components/Standing";

export function HostScreen({ game }: { game: GameApi }) {
  const { state } = game;
  // The lobby is a phase, not the absence of a room: a host who has just
  // created one still needs the join code, the roster and the Start button.
  if (state && state.role === "host" && state.phase !== "LOBBY") {
    return <Board game={game} state={state} />;
  }
  return <Lobby game={game} />;
}

// ---------------------------------------------------------------------------

function Lobby({ game }: { game: GameApi }) {
  const { state, createRoom, start, status } = game;
  const players = state?.players ?? [];

  return (
    <main className="shell">
      <header className="hero">
        <p className="eyebrow">Host</p>
        <h1>Buzz<span className="dot">.</span></h1>
      </header>

      {!state ? (
        <section className="card">
          <h2>Start a game</h2>
          <p className="muted">
            Creates a room and gives you a 4-letter code to read out.
          </p>
          <button
            type="button"
            className="btn primary"
            onClick={createRoom}
            disabled={status !== "connected"}
          >
            Create room
          </button>
        </section>
      ) : (
        <>
          <section className="card">
            <h2>Join code</h2>
            <p className="room-code">{state.code}</p>
            <p className="muted">Players enter this at the player link.</p>
          </section>

          <section className="card">
            <h2>Players — {players.length}</h2>
            {players.length === 0 ? (
              <p className="muted">Waiting for players to join…</p>
            ) : (
              <ul className="roster">
                {players.map((player) => (
                  <li key={player.id} className={player.connected ? "" : "offline"}>
                    <span className="dotmark" aria-hidden />
                    {player.name}
                    {!player.connected && <em className="muted"> · offline</em>}
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              className="btn primary"
              onClick={start}
              disabled={players.length === 0}
            >
              {players.length === 0 ? "Need at least one player" : "Start game"}
            </button>
          </section>
        </>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------

function Board({ game, state }: { game: GameApi; state: HostState }) {
  const { pickClue, openBuzzers, judge, closeClue, next, endGame, announcement, error } = game;
  const [showAnswer, setShowAnswer] = useState(false);

  const active = state.activeClue;

  // Hide the answer again whenever a new clue comes up, so it never leaks onto
  // the big screen by accident.
  useEffect(() => {
    setShowAnswer(false);
  }, [active?.clueId]);

  const nameOf = (id: string | null) =>
    state.players.find((player) => player.id === id)?.name ?? "Someone";

  return (
    <main className="shell wide">
      <header className="board-head">
        <div>
          <span className="eyebrow">Room</span>
          <span className="code-inline">{state.code}</span>
        </div>
        <span className={`pill phase-${state.phase}`}>{prettyPhase(state.phase)}</span>
        <button type="button" className="btn tiny ghost" onClick={endGame}>
          End game
        </button>
      </header>

      {(announcement || error) && (
        <div className={`banner ${error ? "banner-bad" : ""}`}>{error ?? announcement}</div>
      )}

      {state.phase === "GAME_OVER" ? (
        <section className="card">
          <h2>Final scores</h2>
          <Standing rows={state.standings} />
        </section>
      ) : (
        <>
          {active && (
            <section className="clue-panel">
              <div className="clue-meta">
                <span>
                  {active.category} · {active.value}
                </span>
                {active.currentAnswerer && (
                  <span className="who-buzzed">{nameOf(active.currentAnswerer)} buzzed</span>
                )}
              </div>
              <p className="clue-question">{active.question}</p>

              <div className="clue-answer">
                {showAnswer ? (
                  <strong>{active.answer}</strong>
                ) : (
                  <button type="button" className="btn tiny ghost" onClick={() => setShowAnswer(true)}>
                    Show answer
                  </button>
                )}
              </div>

              <div className="controls">
                <button
                  type="button"
                  className="btn primary"
                  onClick={openBuzzers}
                  disabled={state.phase !== "CLUE_SHOWN"}
                >
                  Open buzzers
                </button>

                <button
                  type="button"
                  className="btn good"
                  onClick={() => active.currentAnswerer && judge(active.currentAnswerer, true)}
                  disabled={state.phase !== "ANSWERING"}
                >
                  Correct
                </button>
                <button
                  type="button"
                  className="btn bad"
                  onClick={() => active.currentAnswerer && judge(active.currentAnswerer, false)}
                  disabled={state.phase !== "ANSWERING"}
                >
                  Incorrect
                </button>

                <button
                  type="button"
                  className="btn ghost"
                  onClick={closeClue}
                  disabled={
                    state.phase !== "CLUE_SHOWN" &&
                    state.phase !== "BUZZING_OPEN" &&
                    state.phase !== "ANSWERING"
                  }
                >
                  Close clue
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={next}
                  disabled={state.phase !== "RESOLVED"}
                >
                  Next clue
                </button>
              </div>

              <p className="hint">{hintFor(state.phase, nameOf(active.currentAnswerer))}</p>
            </section>
          )}

          <section className="board">
            {state.board.map((category) => (
              <div key={category.title} className="column">
                <h3>{category.title}</h3>
                {category.clues.map((clue) => (
                  <button
                    key={clue.id}
                    type="button"
                    className={`tile ${clue.consumed ? "used" : ""}`}
                    onClick={() => pickClue(clue.id)}
                    disabled={state.phase !== "BOARD" || clue.consumed}
                  >
                    {clue.consumed ? "—" : clue.value}
                  </button>
                ))}
              </div>
            ))}
          </section>
        </>
      )}

      <section className="card">
        <h2>Scores</h2>
        <Standing rows={state.standings} />
      </section>
    </main>
  );
}

function prettyPhase(phase: string): string {
  return phase.replace(/_/g, " ").toLowerCase();
}

function hintFor(phase: string, answerer: string): string {
  switch (phase) {
    case "BOARD":
      return "Pick a clue from the board.";
    case "CLUE_SHOWN":
      return "Read the clue out loud, then open the buzzers.";
    case "BUZZING_OPEN":
      return "Waiting for a buzz…";
    case "ANSWERING":
      return `${answerer} is answering. Judge it.`;
    case "RESOLVED":
      return "Clue finished — pick another.";
    default:
      return "";
  }
}
