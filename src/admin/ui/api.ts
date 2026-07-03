/**
 * Admin API client — HTTP helpers + auth + SSE.
 *
 * Auth: DB-backed session tokens. `login()` exchanges username/password for an
 * opaque session token that is sent as a Bearer token on every request.
 *
 * Token storage trade-off: the token is kept in sessionStorage (tab-scoped,
 * cleared on tab close) rather than an httpOnly cookie, so it is readable by
 * any script running on this origin (XSS risk). This is offset by:
 *   - a strict, nonce-based CSP with no unsafe-inline/unsafe-eval and
 *     connect-src 'self' (see applySecurityHeaders in adminServer.ts), which
 *     blocks injected <script> tags and stops exfiltration to other origins
 *     even if a script did run;
 *   - server-side session revocation (logout(), password change) that
 *     invalidates the token immediately regardless of client-side storage;
 *   - a short, sliding session TTL (SESSION_TTL_MS = 12h in adminAuthService.ts)
 *     that bounds how long an exfiltrated token stays usable.
 * Moving to httpOnly cookies would remove the injected-script read risk but
 * requires CSRF defenses (SameSite alone is not sufficient for state-changing
 * cross-origin requests) and is left as follow-up work.
 */

import type { ApiMe, SetupStatus } from "./types.ts";

const TOKEN_KEY  = "ve-admin-token";

/* ─── Auth token management ───────────────────────────────────────────── */

export function getStoredToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function clearStoredToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

/** Store a session token (used after successful login/setup). */
export function storeToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

/* ─── Central 401 handling ────────────────────────────────────────────── */

let unauthorizedHandler: (() => void) | null = null;

/** Register a callback invoked whenever any API call returns 401 (session expired/revoked). */
export function onUnauthorized(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

function notifyUnauthorized(): void {
  clearStoredToken();
  unauthorizedHandler?.();
}

function authHeaders(): Record<string, string> {
  const token = getStoredToken();
  if (!token) return {};
  return { authorization: `Bearer ${token}` };
}

/* ─── HTTP fetch helpers ──────────────────────────────────────────────── */

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const headers: Record<string, string> = {
    ...authHeaders(),
    ...(body !== undefined ? { "content-type": "application/json" } : {}),
  };
  const res = await fetch(path, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch { /* ignore */ }
    // 401 = session expired/revoked → drop to login. 403 (insufficient role)
    // must NOT log out — it surfaces as a normal error message.
    if (res.status === 401) notifyUnauthorized();
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get:    <T>(path: string) => request<T>("GET", path),
  post:   <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  put:    <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  patch:  <T>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}),
  delete: <T>(path: string, body?: unknown) => request<T>("DELETE", path, body),
};

/* ─── Auth flow ───────────────────────────────────────────────────────── */

interface LoginResponse {
  token: string;
  user: ApiMe;
}

async function parseAuthError(res: Response): Promise<string> {
  let msg = res.statusText;
  try {
    const j = (await res.json()) as { error?: string };
    if (j.error) msg = j.error;
  } catch { /* ignore */ }
  return msg;
}

/** Whether the first-admin setup screen should be shown (public endpoint). */
export async function fetchSetupStatus(): Promise<SetupStatus> {
  const res = await fetch("/api/admin/auth/setup-status");
  if (!res.ok) throw new ApiError(res.status, await parseAuthError(res));
  return res.json() as Promise<SetupStatus>;
}

/**
 * Username/password login. Stores the returned session token on success.
 * Uses a raw fetch (not request()) so a 401 here does NOT trigger the global
 * unauthorized handler — it just means "invalid credentials".
 */
export async function login(username: string, password: string): Promise<ApiMe> {
  const res = await fetch("/api/admin/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new ApiError(res.status, await parseAuthError(res));
  const data = (await res.json()) as LoginResponse;
  storeToken(data.token);
  return data.user;
}

/**
 * First-run setup: creates the first admin user and stores the returned session token.
 */
export async function setup(username: string, password: string): Promise<ApiMe> {
  const res = await fetch("/api/admin/auth/setup", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new ApiError(res.status, await parseAuthError(res));
  const data = (await res.json()) as LoginResponse;
  storeToken(data.token);
  return data.user;
}

/** Revoke the current session server-side and clear the stored token. */
export async function logout(): Promise<void> {
  try {
    await fetch("/api/admin/auth/logout", { method: "POST", headers: authHeaders() });
  } catch { /* best-effort */ }
  clearStoredToken();
}

/** Current authenticated identity. */
export function getMe(): Promise<ApiMe> {
  return api.get<ApiMe>("/api/admin/auth/me");
}

/* ─── SSE stream helpers ──────────────────────────────────────────────── */

type SseHandler = (eventType: string, data: string) => void;

/**
 * Connect to an SSE stream using fetch (to pass auth headers).
 * Auto-reconnects with exponential backoff. Returns a cleanup function.
 */
export function connectSse(
  path: string,
  onEvent: SseHandler,
  onError?: (err: unknown) => void
): () => void {
  let abort: AbortController | null = null;
  let stopped = false;
  let backoffMs = 1000;

  async function connect(): Promise<void> {
    if (stopped) return;
    abort = new AbortController();
    try {
      const res = await fetch(path, {
        headers: authHeaders(),
        signal: abort.signal,
      });
      if (res.status === 401) {
        stopped = true;
        notifyUnauthorized();
        return;
      }
      if (!res.ok || !res.body) throw new Error(`SSE error ${res.status}`);
      backoffMs = 1000; // reset on success

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const chunk of parts) {
          const lines = chunk.split("\n");
          let eventType = "message";
          let dataLines: string[] = [];
          for (const line of lines) {
            if (line.startsWith("event: ")) eventType = line.slice(7).trim();
            else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
          }
          if (dataLines.length > 0) onEvent(eventType, dataLines.join("\n"));
        }
      }
    } catch (err) {
      if (stopped) return;
      onError?.(err);
    }
    // reconnect with backoff
    if (!stopped) {
      setTimeout(() => void connect(), Math.min(backoffMs, 30_000));
      backoffMs = Math.min(backoffMs * 2, 30_000);
    }
  }

  void connect();
  return () => {
    stopped = true;
    abort?.abort();
  };
}

/* ─── Relative time helper ────────────────────────────────────────────── */
export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 10_000) return "now";
  if (diff < 60_000) return `${Math.round(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h`;
  return `${Math.round(diff / 86_400_000)}d`;
}
