import { useState, type FormEvent } from "react";
import type { PlayerState } from "@buzz/shared";
import type { GameApi } from "../useGame";
import { Standing } from "../components/Standing";

const CODE_LENGTH = 4;
const NAME_MAX = 20;

export function PlayerScreen({ game }: { game: GameApi }) {
  const { state } = game;
  if (state && state.role === "player") return <Buzzer game={game} state={state} />;
  return <JoinForm game={game} />;
}

// ---------------------------------------------------------------------------

function JoinForm({ game }: { game: GameApi }) {
  const { join, status, notice, leave } = game;
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setBusy(true);
    const result = await join(code.trim(), name.trim());
    if (!result.ok) setProblem(result.message);
    setBusy(false);
  }

  return (
    <main className="shell">
      <header className="hero">
        <p className="eyebrow">Player</p>
        <h1>Buzz<span className="dot">.</span></h1>
      </header>

      <form className="card" onSubmit={submit}>
        <h2>Join a game</h2>

        <label className="field">
          <span>Room code</span>
          <input
            className="code-input"
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase().slice(0, CODE_LENGTH))}
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            placeholder="ABCD"
            maxLength={CODE_LENGTH}
            required
          />
        </label>

        <label className="field">
          <span>Your name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value.slice(0, NAME_MAX))}
            autoComplete="off"
            placeholder="Alex"
            maxLength={NAME_MAX}
            required
          />
        </label>

        {(problem ?? notice) && <p className="bad-text">{problem ?? notice}</p>}

        <button
          type="submit"
          className="btn primary"
          disabled={busy || status !== "connected" || code.length !== CODE_LENGTH || !name.trim()}
        >
          {busy ? "Joining…" : status === "connected" ? "Join" : "Connecting…"}
        </button>

        {notice && (
          <button type="button" className="btn tiny ghost" onClick={leave}>
            Clear saved session
          </button>
        )}
      </form>
    </main>
  );
}

// ---------------------------------------------------------------------------

type BuzzerMode = "waiting" | "locked" | "armed" | "you-buzzed" | "too-slow" | "locked-out" | "done";

function modeFor(state: PlayerState): BuzzerMode {
  const active = state.activeClue;
  switch (state.phase) {
    case "LOBBY":
    case "BOARD":
      return "waiting";
    case "CLUE_SHOWN":
      return "locked";
    case "BUZZING_OPEN":
      return state.canBuzz ? "armed" : "locked-out";
    case "ANSWERING":
      return active?.currentAnswerer === state.playerId ? "you-buzzed" : "too-slow";
    case "RESOLVED":
    case "GAME_OVER":
      return "done";
    default:
      return "waiting";
  }
}

const MODE_LABEL: Record<BuzzerMode, string> = {
  waiting: "Waiting for the host…",
  locked: "Get ready…",
  armed: "TAP!",
  "you-buzzed": "You buzzed!",
  "too-slow": "Too slow",
  "locked-out": "Locked out this clue",
  done: "",
};

function Buzzer({ game, state }: { game: GameApi; state: PlayerState }) {
  const { buzz, leave, announcement } = game;
  const [flash, setFlash] = useState<string | null>(null);

  const mode = modeFor(state);
  const active = state.activeClue;

  async function tap() {
    if (mode !== "armed") return;
    const result = await buzz();
    if (result && !result.ok) {
      setFlash(
        result.reason === "too_late"
          ? "Too slow!"
          : result.reason === "locked_out"
            ? "You're locked out"
            : "Buzzers are closed",
      );
      setTimeout(() => setFlash(null), 1_200);
    }
  }

  const showQuestion =
    active && (state.phase === "CLUE_SHOWN" || state.phase === "BUZZING_OPEN" || state.phase === "ANSWERING");

  return (
    <main className="phone">
      <header className="phone-head">
        <span className="who">{state.name}</span>
        <span className="phone-score">{state.score}</span>
      </header>

      {active && (
        <div className="phone-clue">
          <span className="clue-meta">
            {active.category} · {active.value}
          </span>
          {showQuestion && <p className="phone-question">{active.question}</p>}
          {state.phase === "RESOLVED" && active.answer && (
            <p className="phone-answer">Answer: {active.answer}</p>
          )}
        </div>
      )}

      {state.phase === "GAME_OVER" ? (
        <section className="card">
          <h2>Final scores</h2>
          <Standing rows={state.standings} />
        </section>
      ) : (
        <button
          type="button"
          className={`buzzer buzzer-${mode}`}
          onPointerDown={(event) => {
            // Fire on pointerdown: a tap should not wait for a click to settle.
            event.preventDefault();
            void tap();
          }}
          disabled={mode !== "armed"}
          aria-live="polite"
        >
          <span className="buzzer-label">
            {flash ?? MODE_LABEL[mode] ?? ""}
          </span>
          {mode === "locked-out" && <span className="buzzer-sub">Someone else gets first try</span>}
        </button>
      )}

      {(announcement || flash) && <div className="banner">{announcement ?? flash}</div>}

      <button type="button" className="btn tiny ghost" onClick={leave}>
        Leave
      </button>
    </main>
  );
}
