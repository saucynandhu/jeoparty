import { useEffect, useState } from "react";
import { useGame } from "./useGame";
import { HostScreen } from "./screens/HostScreen";
import { PlayerScreen } from "./screens/PlayerScreen";

type Route = "landing" | "host" | "player";

function routeFromPath(pathname: string): Route {
  if (pathname.startsWith("/host")) return "host";
  if (pathname.startsWith("/play")) return "player";
  return "landing";
}

export function App() {
  const game = useGame();
  const [route, setRoute] = useState<Route>(() => routeFromPath(window.location.pathname));

  useEffect(() => {
    const onPop = () => setRoute(routeFromPath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  function go(next: Route) {
    window.history.pushState({}, "", next === "host" ? "/host" : next === "player" ? "/play" : "/");
    setRoute(next);
  }

  return (
    <>
      {route === "host" && <HostScreen game={game} />}
      {route === "player" && <PlayerScreen game={game} />}
      {route === "landing" && <Landing go={go} game={game} />}

      {game.error && (
        <div className="toast" role="alert">
          <span>{game.error}</span>
          <button type="button" className="btn tiny ghost" onClick={game.dismissError}>
            Dismiss
          </button>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function Landing({ go, game }: { go: (r: Route) => void; game: ReturnType<typeof useGame> }) {
  const [health, setHealth] = useState<{ status: string; rooms: number; players: number } | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/health");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { status: string; rooms: number; players: number };
        if (!cancelled) setHealth(data);
      } catch {
        if (!cancelled) setHealth(null);
      }
    };
    void load();
    const timer = setInterval(load, 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <main className="shell">
      <header className="hero">
        <p className="eyebrow">Jeopardy-style multiplayer</p>
        <h1>
          Buzz<span className="dot">.</span>
        </h1>
        <p className="sub">
          Put the host screen on a TV. Everyone else opens the player link on their phone and
          buzzes in.
        </p>
      </header>

      <div className="links big">
        <button type="button" className="btn primary" onClick={() => go("host")}>
          Host a game
        </button>
        <button type="button" className="btn" onClick={() => go("player")}>
          Join on this phone
        </button>
      </div>

      <section className="card">
        <h2>Server</h2>
        <dl>
          <div className="row">
            <dt>socket</dt>
            <dd>{game.status}</dd>
          </div>
          <div className="row">
            <dt>health</dt>
            <dd>{health ? health.status : "unreachable"}</dd>
          </div>
          <div className="row">
            <dt>rooms</dt>
            <dd>{health?.rooms ?? "—"}</dd>
          </div>
          <div className="row">
            <dt>players</dt>
            <dd>{health?.players ?? "—"}</dd>
          </div>
        </dl>
      </section>
    </main>
  );
}
