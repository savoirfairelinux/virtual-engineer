/**
 * Admin API client — HTTP helpers + auth + SSE.
 *
 * Auth: HMAC-SHA256. The user stores an ADMIN_AUTH_SECRET in sessionStorage.
 * On each request we compute HMAC-SHA256(secret, canonical-string) and pass it
 * as a Bearer token, exactly matching the server's isAuthorized() check.
 */

const TOKEN_KEY  = "ve-admin-token";
const SECRET_KEY = "ve-admin-secret";

/* ─── Auth token management ───────────────────────────────────────────── */

export function getStoredToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function clearStoredToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(SECRET_KEY);
}

/** Store a pre-computed token (used after successful unlock). */
export function storeToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

/**
 * Derive a Bearer token from a raw ADMIN_AUTH_SECRET via Web Crypto HMAC-SHA256.
 * Matches the server-side computation in adminServer.ts isAuthorized().
 */
export async function deriveToken(secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(secret));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
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

/* ─── SSH key management helpers ─────────────────────────────────────── */

export interface AgentKey { publicKey: string; keyType: string; comment: string }

export function generateSshKey(integrationId: string): Promise<{ publicKey: string }> {
  return request<{ publicKey: string }>("POST", `/api/admin/integrations/${integrationId}/ssh-key/generate`);
}

export function getSshPublicKey(integrationId: string): Promise<{ publicKey: string | null }> {
  return request<{ publicKey: string | null }>("GET", `/api/admin/integrations/${integrationId}/ssh-key/public`);
}

export function listAgentKeys(): Promise<{ keys: AgentKey[]; agentAvailable: boolean }> {
  return request<{ keys: AgentKey[]; agentAvailable: boolean }>("GET", "/api/admin/ssh-agent/keys");
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
