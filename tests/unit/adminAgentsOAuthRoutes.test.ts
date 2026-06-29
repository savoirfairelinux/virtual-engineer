import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { createHmac, randomUUID } from "crypto";
import type { Server } from "node:http";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { createAdminServer, type AdminServerDependencies } from "../../src/admin/adminServer.js";
import { registerBuiltinPlugins } from "../../src/plugins/init.js";
import { registerPlugin } from "../../src/plugins/registry.js";
import { z } from "zod";

function tempDbPath(): string {
  return join(tmpdir(), `ve-admin-agents-oauth-${randomUUID()}.db`);
}

interface FetchResult {
  status: number;
  body: Record<string, unknown> | null;
}

async function rest(server: Server, path: string, opts: { method?: string; body?: unknown } = {}): Promise<FetchResult> {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Server not bound");
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const init: RequestInit = { method: opts.method ?? "GET" };
  init.headers = authHeaders("admin-secret");
  if (opts.body !== undefined) {
    init.headers = {
      ...init.headers,
      "content-type": "application/json",
    };
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let parsed: Record<string, unknown> | null = null;
  if (text) {
    try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* leave null */ }
  }
  return { status: res.status, body: parsed };
}

function authHeaders(secret: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", secret).update(timestamp).digest("hex");
  return {
    authorization: `Bearer ${timestamp}.${signature}`,
  };
}

function makeDeps(store: SqliteStateStore, overrides: Partial<AdminServerDependencies> = {}): AdminServerDependencies {
  return {
    stateStore: {
      getActiveTasks: vi.fn(async () => []),
      getAllTasks: vi.fn(async () => []),
      getTask: vi.fn(async () => null),
      getAgentCycles: vi.fn(async () => []),
      getAgentCycleEvents: vi.fn(async () => []),
      getStateTransitions: vi.fn(async () => []),
      pauseTask: vi.fn(async () => { throw new Error("not impl"); }),
      resumeTask: vi.fn(async () => { throw new Error("not impl"); }),
      retryTask: vi.fn(async () => { throw new Error("not impl"); }),
      abandonTask: vi.fn(async () => { throw new Error("not impl"); }),
      deleteTask: vi.fn(async () => {}),
      getChangesForTask: vi.fn(async () => []),
      getChangesForTasks: vi.fn(async () => []),
      deleteTaskGroup: vi.fn(async () => {}),
    },
    agentStore: store,
    projectStore: store,
    integrationStore: store,
    oAuthAppStore: store,
    config: {
      nodeEnv: "test",
      logLevel: "error",
      maxAgentCycles: 3,
      maxRetryAttempts: 5,
      pollingIntervalMs: 30000,
      adminAuthSecret: "admin-secret",
    },
    polling: { isRunning: () => false, getIntervals: () => ({ intervalMs: 30000 }) },
    providers: [],
    ...overrides,
  };
}

describe("Admin API — Copilot OAuth routes", () => {
  let store: SqliteStateStore;
  let server: Server;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
    if (store) {
      store.close();
    }
  });

  beforeEach(async () => {
    registerBuiltinPlugins();
    store = await SqliteStateStore.create(tempDbPath());
  });

  it("POST /api/admin/plugins/copilot/oauth/device-code delegates to the provider auth service", async () => {
    const providerAuthService = {
      startAuthFlow: vi.fn(async () => ({
        deviceCode: "dc_123",
        userCode: "ABCD-1234",
        verificationUri: "https://github.com/login/device",
        expiresIn: 900,
        interval: 5,
      })),
      completeAuthFlow: vi.fn(),
    };
    server = createAdminServer(makeDeps(store, { providerAuthService }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const result = await rest(server, "/api/admin/plugins/copilot/oauth/device-code", {
      method: "POST",
      body: {},
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      deviceCode: "dc_123",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      expiresIn: 900,
      interval: 5,
    });
    expect(providerAuthService.startAuthFlow).toHaveBeenCalledTimes(1);
  });

  it("POST /api/admin/plugins/copilot/oauth/token delegates token completion to the provider auth service", async () => {
    const providerAuthService = {
      startAuthFlow: vi.fn(),
      completeAuthFlow: vi.fn(async () => ({
        encryptedToken: "enc_token",
        isPlaintext: false,
      })),
    };
    server = createAdminServer(makeDeps(store, { providerAuthService }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const result = await rest(server, "/api/admin/plugins/copilot/oauth/token", {
      method: "POST",
      body: { deviceCode: "dc_123" },
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ encryptedToken: "enc_token", isPlaintext: false });
    expect(providerAuthService.completeAuthFlow).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "device" }),
      { deviceCode: "dc_123" },
      { adminAuthSecret: "admin-secret" }
    );
  });

  it("POST /api/admin/plugins/copilot/oauth/start delegates redirect auth start to the provider auth service", async () => {
    const createOAuthHandler = vi.fn(() => ({
      kind: "redirect" as const,
      start: vi.fn(),
      complete: vi.fn(),
    }));
    registerPlugin({
      provider: "copilot",
      name: "GitHub Copilot",
      capabilities: { agent_execution: {} },
      configSchema: z.object({}),
      requiredFields: [],
      oauth: {
        mode: "redirect",
        tokenField: "sessionToken",
        providerName: "GitLab",
        heading: "GitLab Authentication",
        connectLabel: "Connect with GitLab",
        reconnectLabel: "Re-connect",
        pendingLabel: "Waiting…",
        startPath: "/api/admin/plugins/copilot/oauth/start",
        completePath: "/api/admin/plugins/copilot/oauth/complete",
      },
      createOAuthHandler,
      getSummaryDetails(_config) { return []; },
    });
    const providerAuthService = {
      startAuthFlow: vi.fn(async () => ({
        authorizationUrl: "https://gitlab.example.com/oauth/authorize?state=test",
      })),
      completeAuthFlow: vi.fn(),
    };
    server = createAdminServer(makeDeps(store, { providerAuthService }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const result = await rest(server, "/api/admin/plugins/copilot/oauth/start", {
      method: "POST",
      body: {
        redirectUri: "http://127.0.0.1:3100/admin",
        state: "oauth-state",
        codeChallenge: "pkce-challenge",
        codeChallengeMethod: "S256",
        config: {
          baseUrl: "https://gitlab.example.com",
          oauthClientId: "client-id",
          oauthClientSecret: "client-secret",
        },
      },
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      authorizationUrl: "https://gitlab.example.com/oauth/authorize?state=test",
    });
    expect(createOAuthHandler).toHaveBeenCalledWith({
      baseUrl: "https://gitlab.example.com",
      oauthClientId: "client-id",
      oauthClientSecret: "client-secret",
    });
    expect(providerAuthService.startAuthFlow).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "redirect" }),
      {
        redirectUri: "http://127.0.0.1:3100/admin",
        state: "oauth-state",
        codeChallenge: "pkce-challenge",
        codeChallengeMethod: "S256",
      }
    );
  });

  it("POST /api/admin/plugins/copilot/oauth/complete delegates redirect auth completion to the provider auth service", async () => {
    const createOAuthHandler = vi.fn(() => ({
      kind: "redirect" as const,
      start: vi.fn(),
      complete: vi.fn(),
    }));
    registerPlugin({
      provider: "copilot",
      name: "GitHub Copilot",
      capabilities: { agent_execution: {} },
      configSchema: z.object({}),
      requiredFields: [],
      oauth: {
        mode: "redirect",
        tokenField: "sessionToken",
        providerName: "GitLab",
        heading: "GitLab Authentication",
        connectLabel: "Connect with GitLab",
        reconnectLabel: "Re-connect",
        pendingLabel: "Waiting…",
        startPath: "/api/admin/plugins/copilot/oauth/start",
        completePath: "/api/admin/plugins/copilot/oauth/complete",
      },
      createOAuthHandler,
      getSummaryDetails(_config) { return []; },
    });
    const providerAuthService = {
      startAuthFlow: vi.fn(),
      completeAuthFlow: vi.fn(async () => ({
        encryptedToken: "enc_redirect_token",
        isPlaintext: false,
      })),
    };
    server = createAdminServer(makeDeps(store, { providerAuthService }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const result = await rest(server, "/api/admin/plugins/copilot/oauth/complete", {
      method: "POST",
      body: {
        code: "oauth-code",
        redirectUri: "http://127.0.0.1:3100/admin",
        state: "oauth-state",
        codeVerifier: "pkce-verifier",
        config: {
          baseUrl: "https://gitlab.example.com",
          oauthClientId: "client-id",
          oauthClientSecret: "client-secret",
        },
      },
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ encryptedToken: "enc_redirect_token", isPlaintext: false });
    expect(createOAuthHandler).toHaveBeenCalledWith({
      baseUrl: "https://gitlab.example.com",
      oauthClientId: "client-id",
      oauthClientSecret: "client-secret",
    });
    expect(providerAuthService.completeAuthFlow).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "redirect" }),
      {
        code: "oauth-code",
        redirectUri: "http://127.0.0.1:3100/admin",
        state: "oauth-state",
        codeVerifier: "pkce-verifier",
      },
      { adminAuthSecret: "admin-secret" }
    );
  });

  it("merges masked secrets from the stored integration config before building the OAuth handler", async () => {
    await store.upsertIntegration({
      id: "copilot-oauth",
      provider: "copilot",
      name: "Copilot OAuth",
      configJson: JSON.stringify({
        baseUrl: "https://gitlab.example.com",
        oauthClientId: "stored-client",
        oauthClientSecret: "stored-secret",
      }),
      enabled: true,
    });

    const createOAuthHandler = vi.fn(() => ({
      kind: "redirect" as const,
      start: vi.fn(),
      complete: vi.fn(),
    }));
    registerPlugin({
      provider: "copilot",
      name: "GitHub Copilot",
      capabilities: { agent_execution: {} },
      configSchema: z.object({
        baseUrl: z.string().optional(),
        oauthClientId: z.string().optional(),
        oauthClientSecret: z.string().optional(),
      }),
      requiredFields: [
        { key: "oauthClientSecret", label: "OAuth Client Secret", type: "password", required: false },
      ],
      oauth: {
        mode: "redirect",
        tokenField: "sessionToken",
        providerName: "GitLab",
        heading: "GitLab Authentication",
        connectLabel: "Connect with GitLab",
        reconnectLabel: "Re-connect",
        pendingLabel: "Waiting…",
        startPath: "/api/admin/plugins/copilot/oauth/start",
        completePath: "/api/admin/plugins/copilot/oauth/complete",
      },
      createOAuthHandler,
      getSummaryDetails(_config) { return []; },
    });
    const providerAuthService = {
      startAuthFlow: vi.fn(async () => ({
        authorizationUrl: "https://gitlab.example.com/oauth/authorize?state=test",
      })),
      completeAuthFlow: vi.fn(),
    };
    server = createAdminServer(makeDeps(store, { providerAuthService }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const result = await rest(server, "/api/admin/plugins/copilot/oauth/start", {
      method: "POST",
      body: {
        integrationId: "copilot-oauth",
        redirectUri: "http://127.0.0.1:3100/admin",
        config: {
          oauthClientSecret: "********",
        },
      },
    });

    expect(result.status).toBe(200);
    expect(createOAuthHandler).toHaveBeenCalledWith({
      baseUrl: "https://gitlab.example.com",
      oauthClientId: "stored-client",
      oauthClientSecret: "stored-secret",
    });
  });

  it("resolves the GitLab OAuth client id from the app registry before starting the device flow", async () => {
    await store.upsertOAuthApp({
      provider: "gitlab",
      baseUrl: "https://gitlab.example.com/",
      clientId: "registry-client-id",
    });

    server = createAdminServer(makeDeps(store));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const realFetch = globalThis.fetch;
    const gitlabFetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      device_code: "dc_reg_123",
      user_code: "REGI-CODE",
      verification_uri: "https://gitlab.example.com/oauth/device",
      expires_in: 300,
      interval: 5,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("gitlab.example.com")) {
        return gitlabFetchMock(urlStr, init);
      }
      return realFetch(url as string, init);
    });

    const result = await rest(server, "/api/admin/plugins/gitlab/oauth/device-code", {
      method: "POST",
      body: {
        config: {
          baseUrl: "https://gitlab.example.com",
          authMode: "oauth",
        },
      },
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      deviceCode: "dc_reg_123",
      userCode: "REGI-CODE",
      verificationUri: "https://gitlab.example.com/oauth/device",
    });

    // Verify the fetch was called with the registry-resolved client_id
    expect(gitlabFetchMock).toHaveBeenCalled();
    const firstCall = gitlabFetchMock.mock.calls[0];
    if (!firstCall) throw new Error("Expected gitlabFetchMock to have been called");
    const [fetchUrl, fetchInit] = firstCall as unknown as [string, RequestInit & { body?: URLSearchParams | string }];
    expect(fetchUrl).toContain("/oauth/authorize_device");
    const bodyStr = fetchInit?.body instanceof URLSearchParams ? fetchInit.body.toString() : String(fetchInit?.body ?? "");
    expect(bodyStr).toContain("client_id=registry-client-id");

    vi.unstubAllGlobals();
  });

  it("returns 404 when resolving OAuth config for a missing integration", async () => {
    const createOAuthHandler = vi.fn(() => ({
      kind: "redirect" as const,
      start: vi.fn(),
      complete: vi.fn(),
    }));
    registerPlugin({
      provider: "copilot",
      name: "GitHub Copilot",
      capabilities: { agent_execution: {} },
      configSchema: z.object({}),
      requiredFields: [],
      oauth: {
        mode: "redirect",
        tokenField: "sessionToken",
        providerName: "GitLab",
        heading: "GitLab Authentication",
        connectLabel: "Connect with GitLab",
        reconnectLabel: "Re-connect",
        pendingLabel: "Waiting…",
        startPath: "/api/admin/plugins/copilot/oauth/start",
        completePath: "/api/admin/plugins/copilot/oauth/complete",
      },
      createOAuthHandler,
      getSummaryDetails(_config) { return []; },
    });
    server = createAdminServer(makeDeps(store));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const result = await rest(server, "/api/admin/plugins/copilot/oauth/start", {
      method: "POST",
      body: {
        integrationId: "missing-integration",
        redirectUri: "http://127.0.0.1:3100/admin",
        config: {},
      },
    });

    expect(result.status).toBe(404);
    expect(result.body).toEqual({ error: "Integration not found" });
    expect(createOAuthHandler).not.toHaveBeenCalled();
  });
});