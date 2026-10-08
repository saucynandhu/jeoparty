/**
 * Reconnect credentials.
 *
 * The token is the secret; the code is kept alongside it so a reload can
 * re-acquire the seat without the player retyping anything.
 */

export interface Session {
  role: "host" | "player";
  code: string;
  token: string;
}

const KEY = "buzz.session.v1";

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (
      (parsed.role === "host" || parsed.role === "player") &&
      typeof parsed.code === "string" &&
      typeof parsed.token === "string"
    ) {
      return { role: parsed.role, code: parsed.code, token: parsed.token };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveSession(session: Session): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    // Private browsing / disabled storage — the game still works, reconnects won't.
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
