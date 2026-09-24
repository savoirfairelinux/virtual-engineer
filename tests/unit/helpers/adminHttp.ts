import type { AddressInfo } from "node:net";
import { expect } from "vitest";
import { createAdminServer } from "../../../src/admin/adminServer.js";
import type { SqliteStateStore } from "../../../src/state/stateStore.js";

export const TEST_ADMIN_SECRET = "test-admin-secret-with-32-characters!";

export interface AdminHttpServer {
  baseUrl: string;
  close(): Promise<void>;
}

/** Start a production-style admin server (full store, fail-closed auth) on an ephemeral port. */
export async function startAdminHttpServer(
  store: SqliteStateStore,
  adminAuthSecret: string | null = TEST_ADMIN_SECRET
): Promise<AdminHttpServer> {
  const server = createAdminServer({
    stateStore: store,
    config: {
      nodeEnv: "test",
      logLevel: "info",
      maxAgentCycles: 3,
      maxRetryAttempts: 5,
      pollingIntervalMs: 30_000,
      ...(adminAuthSecret !== null ? { adminAuthSecret } : {}),
    },
    polling: { isRunning: () => true, getIntervals: () => ({ intervalMs: 30_000 }) },
    providers: [],
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

/** JSON request helper; `token` adds a Bearer header. */
export async function requestJson(
  baseUrl: string,
  method: string,
  path: string,
  options: { token?: string | undefined; body?: unknown } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(options.token !== undefined ? { authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

/** Create the first admin through the public setup route and return its session token. */
export async function setupAdmin(baseUrl: string, username = "root", password = "Str0ng-Pass-1x"): Promise<string> {
  const result = await requestJson(baseUrl, "POST", "/api/admin/auth/setup", { body: { username, password } });
  expect(result.status).toBe(201);
  return result.body["token"] as string;
}

/** Log in and return the session token (fails the test on a non-200). */
export async function login(baseUrl: string, username: string, password: string): Promise<string> {
  const result = await requestJson(baseUrl, "POST", "/api/admin/auth/login", { body: { username, password } });
  expect(result.status).toBe(200);
  return result.body["token"] as string;
}
