import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BuzzResult,
  CreateResult,
  JoinResult,
  PlayerId,
  RoomState,
  SessionToken,
} from "@buzz/shared";
import { createSocket, type AppSocket } from "./socket";
import { clearSession, loadSession, saveSession, type Session } from "./session";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface GameApi {
  status: ConnectionStatus;
  state: RoomState | null;
  error: string | null;
  notice: string | null;
  createRoom: () => void;
  join: (code: string, name: string) => Promise<JoinResult>;
  leave: () => void;
  dismissError: () => void;
  start: () => void;
  pickClue: (clueId: string) => void;
  openBuzzers: () => void;
  judge: (playerId: PlayerId, correct: boolean) => void;
  closeClue: () => void;
  next: () => void;
  endGame: () => void;
  buzz: () => Promise<BuzzResult | null>;
  /** Transient announcement, e.g. "Ana buzzed!" */
  announcement: string | null;
}

export function useGame(): GameApi {
  const [socket, setSocket] = useState<AppSocket | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [state, setState] = useState<RoomState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);

  const sessionRef = useRef<Session | null>(loadSession());
  const tokenRef = useRef<SessionToken | null>(sessionRef.current?.token ?? null);
  const codeRef = useRef<string | null>(sessionRef.current?.code ?? null);

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------
  useEffect(() => {
    const next = createSocket();
    setSocket(next);

    next.on("connect", () => {
      setStatus("connected");
      // Re-acquire the seat on every (re)connect, including page reloads.
      const session = sessionRef.current;
      if (!session) return;
      next.emit("session:resume", { code: session.code, token: session.token }, (res) => {
        if (res.ok) {
          setState(res.state);
        } else {
          clearSession();
          sessionRef.current = null;
          codeRef.current = null;
          tokenRef.current = null;
          setState(null);
          setNotice(res.message);
        }
      });
    });

    next.on("disconnect", () => setStatus("disconnected"));
    next.on("connect_error", () => setStatus("disconnected"));
    next.on("room:state", (incoming) => setState(incoming));
    next.on("room:error", (payload) => setError(payload.message));
    next.on("judged", (payload) => {
      setAnnouncement(
        payload.correct
          ? `${payload.name} got it! ${payload.delta > 0 ? "+" : ""}${payload.delta}`
          : `${payload.name} missed it`,
      );
    });
    next.on("buzzed", (payload) => setAnnouncement(`${payload.name} buzzed!`));
    next.on("game:over", () => setAnnouncement("Game over!"));
    next.on("buzzers:open", () => {
      setAnnouncement("Buzzers open!");
      if (typeof navigator !== "undefined" && "vibrate" in navigator) {
        navigator.vibrate?.(30);
      }
    });

    return () => {
      next.removeAllListeners();
      next.disconnect();
      setSocket(null);
    };
  }, []);

  // Announcements are transient.
  useEffect(() => {
    if (!announcement) return;
    const timer = setTimeout(() => setAnnouncement(null), 2_500);
    return () => clearTimeout(timer);
  }, [announcement]);

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const createRoom = useCallback(() => {
    socket?.emit("host:create", (res: CreateResult) => {
      if (!res.ok) {
        setError(res.message);
        return;
      }
      const session: Session = { role: "host", code: res.code, token: res.hostToken };
      sessionRef.current = session;
      codeRef.current = res.code;
      tokenRef.current = res.hostToken;
      saveSession(session);
      setState(res.state);
      setNotice(null);
    });
  }, [socket]);

  const join = useCallback<GameApi["join"]>(
    (code, name) =>
      new Promise<JoinResult>((resolve) => {
        if (!socket) {
          resolve({ ok: false, code: "BAD_REQUEST", message: "Not connected yet." });
          return;
        }
        socket.emit("player:join", { code, name }, (res) => {
          if (res.ok) {
            const session: Session = { role: "player", code, token: res.playerToken };
            sessionRef.current = session;
            codeRef.current = code;
            tokenRef.current = res.playerToken;
            saveSession(session);
            setState(res.state);
            setNotice(null);
          }
          resolve(res);
        });
      }),
    [socket],
  );

  const leave = useCallback(() => {
    clearSession();
    sessionRef.current = null;
    codeRef.current = null;
    tokenRef.current = null;
    setState(null);
    setError(null);
  }, []);

  /** Host-only helpers: every host action needs the code + host token. */
  const hostPayload = useCallback(() => ({ code: codeRef.current ?? "", hostToken: tokenRef.current ?? "" }), []);

  const start = useCallback(() => socket?.emit("host:start", hostPayload()), [socket, hostPayload]);
  const openBuzzers = useCallback(() => socket?.emit("host:openBuzzers", hostPayload()), [socket, hostPayload]);
  const closeClue = useCallback(() => socket?.emit("host:closeClue", hostPayload()), [socket, hostPayload]);
  const next = useCallback(() => socket?.emit("host:next", hostPayload()), [socket, hostPayload]);
  const endGame = useCallback(() => socket?.emit("host:endGame", hostPayload()), [socket, hostPayload]);

  const pickClue = useCallback(
    (clueId: string) => socket?.emit("host:pickClue", { ...hostPayload(), clueId }),
    [socket, hostPayload],
  );

  const judge = useCallback(
    (playerId: PlayerId, correct: boolean) =>
      socket?.emit("host:judge", { ...hostPayload(), playerId, correct }),
    [socket, hostPayload],
  );

  const buzz = useCallback<GameApi["buzz"]>(() => {
    return new Promise<BuzzResult | null>((resolve) => {
      const code = codeRef.current;
      if (!socket || !code) {
        resolve(null);
        return;
      }
      if (typeof navigator !== "undefined" && "vibrate" in navigator) {
        navigator.vibrate?.(25);
      }
      socket.emit("player:buzz", { code }, (res) => resolve(res));
    });
  }, [socket]);

  return {
    status,
    state,
    error,
    notice,
    announcement,
    createRoom,
    join,
    leave,
    dismissError: () => setError(null),
    start,
    pickClue,
    openBuzzers,
    judge,
    closeClue,
    next,
    endGame,
    buzz,
  };
}
