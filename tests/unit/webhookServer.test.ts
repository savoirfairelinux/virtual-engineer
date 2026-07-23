import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { handleWebhookRequest, generateWebhookSecret } from "../../src/webhooks/webhookServer.js";
import type {
  WebhookCapableOrchestrator,
  ProjectLookupStore,
  WebhookServerDependencies,
} from "../../src/webhooks/webhookServer.js";
import type { Integration, IntegrationStore, ProjectRecord, ProjectId, AgentId } from "../../src/interfaces.js";

const INTEGRATION_ID = "redmine-1";
const SECRET = "s".repeat(64);

function makeIntegration(overrides: Partial<Integration> = {}): Integration {
  return {
    id: INTEGRATION_ID,
    provider: "redmine",
    name: "Redmine 1",
    configJson: JSON.stringify({ webhookSecret: SECRET, baseUrl: "http://r/", apiKey: "x", virtualEngineerUserLogin: "ve" }),
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeIntegrationStore(initial: Integration[] = [makeIntegration()]): IntegrationStore {
  const data = new Map<string, Integration>();
  for (const i of initial) data.set(i.id, i);
  return {
    getIntegrations: vi.fn(async () => [...data.values()]),
    getIntegration: vi.fn(async (id: string) => data.get(id) ?? null),
    upsertIntegration: vi.fn(async (i) => {
      const r = { ...i, createdAt: new Date(), updatedAt: new Date() } as Integration;
      data.set(i.id, r);
      return r;
    }),
    deleteIntegration: vi.fn(async (id: string) => { data.delete(id); }),
    countIntegrationReferences: vi.fn(async (_id: string) => 0),
    setIntegrationEnabled: vi.fn(async (id: string, enabled: boolean) => {
      const e = data.get(id)!;
      e.enabled = enabled;
      return e;
    }),
  };
}

function makeProjectRecord(): ProjectRecord {
  return {
    id: "project-1" as ProjectId,
    name: "Sample",
    type: "coding",
    agentId: "agent-1" as AgentId,
    agentOverrideJson: null,
    postCloneScript: "",
    skillDiscoveryEnabled: false,
    localSkillsPath: ".github/skills",
    skillSourcesJson: "[]",
    gerritTopicOverride: null,
    useFullTicketUrlInCommits: false,
    postReviewLinkToTicket: false,
    reactToCiFailures: false,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeProjectStore(opts: { project?: ProjectRecord | null } = {}): ProjectLookupStore {
  return {
    findProjectByTicketSource: vi.fn(async () => opts.project ?? null),
  };
}

function makeOrchestrator(): WebhookCapableOrchestrator {
  return {
    startTaskForProject: vi.fn(async () => {}),
    triggerFeedbackForChange: vi.fn(async () => {}),
    markChangeMerged: vi.fn(async () => {}),
    markChangeAbandoned: vi.fn(async () => {}),
  };
}

interface RequestHelpers {
  url: string;
  closeServer: () => Promise<void>;
}

async function startTestServer(deps: WebhookServerDependencies): Promise<RequestHelpers & { server: Server }> {
  const server = createServer(async (req, res) => {
    const handled = await handleWebhookRequest(req, res, deps);
    if (!handled) {
      res.statusCode = 404;
      res.end("not webhook");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  return {
    server,
    url: `http://127.0.0.1:${addr.port}`,
    closeServer: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function hmacSig(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

describe("webhookServer", () => {
  describe("HTTP", () => {
    let store: IntegrationStore;
    let orchestrator: WebhookCapableOrchestrator;
    let projectStore: ProjectLookupStore;
    let ctx: Awaited<ReturnType<typeof startTestServer>>;

    beforeEach(async () => {
      store = makeIntegrationStore();
      orchestrator = makeOrchestrator();
      projectStore = makeProjectStore({ project: makeProjectRecord() });
      ctx = await startTestServer({ integrationStore: store, orchestrator, projectStore });
    });

    afterEach(async () => { await ctx.closeServer(); });

    async function call(path: string, opts: { headers?: Record<string, string>; body?: string; method?: string } = {}): Promise<{ status: number; body: unknown }> {
      const init: RequestInit = {
        method: opts.method ?? "POST",
      };
      const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };
      init.headers = headers;
      if (opts.body !== undefined) init.body = opts.body;
      const res = await fetch(`${ctx.url}${path}`, init);
      const text = await res.text();
      let parsed: unknown = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
      return { status: res.status, body: parsed };
    }

    it("returns 401 with no signature header", async () => {
      const body = JSON.stringify({ issue: { id: 1, project: { identifier: "p" } } });
      const res = await call(`/webhooks/${INTEGRATION_ID}/issue.created`, { body });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "Unauthorized" });
    });

    it("returns 401 with wrong signature", async () => {
      const body = JSON.stringify({ issue: { id: 1, project: { identifier: "p" } } });
      const res = await call(`/webhooks/${INTEGRATION_ID}/issue.created`, {
        body,
        headers: { "x-hub-signature-256": hmacSig("other", SECRET) },
      });
      expect(res.status).toBe(401);
    });

    it("returns 202 with valid X-Hub-Signature-256", async () => {
      const body = JSON.stringify({ issue: { id: 42, subject: "hi", project: { identifier: "p" } } });
      const res = await call(`/webhooks/${INTEGRATION_ID}/issue.created`, {
        body,
        headers: { "x-hub-signature-256": hmacSig(body, SECRET) },
      });
      expect(res.status).toBe(202);
      expect(orchestrator.startTaskForProject).toHaveBeenCalledTimes(1);
    });

    it("returns 202 with valid X-Gitlab-Token", async () => {
      const body = JSON.stringify({ issue: { id: 7, project: { identifier: "p" } } });
      const res = await call(`/webhooks/${INTEGRATION_ID}/issue.created`, {
        body,
        headers: { "x-gitlab-token": SECRET },
      });
      expect(res.status).toBe(202);
    });

    it("returns 202 with valid Authorization: Bearer", async () => {
      const body = JSON.stringify({ issue: { id: 7, project: { identifier: "p" } } });
      const res = await call(`/webhooks/${INTEGRATION_ID}/issue.created`, {
        body,
        headers: { authorization: `Bearer ${SECRET}` },
      });
      expect(res.status).toBe(202);
    });

    it("returns 401 (NOT 404) for unknown integration to avoid enumeration", async () => {
      const body = JSON.stringify({ issue: { id: 1, project: { identifier: "p" } } });
      const res = await call(`/webhooks/does-not-exist/issue.created`, {
        body,
        headers: { "x-hub-signature-256": hmacSig(body, SECRET) },
      });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "Unauthorized" });
    });

    it("returns 401 for integration without webhookSecret configured", async () => {
      const noSecret = makeIntegration({
        id: "no-secret",
        configJson: JSON.stringify({ baseUrl: "http://r/", apiKey: "x", virtualEngineerUserLogin: "ve" }),
      });
      store = makeIntegrationStore([makeIntegration(), noSecret]);
      await ctx.closeServer();
      ctx = await startTestServer({ integrationStore: store, orchestrator, projectStore });
      const body = JSON.stringify({ issue: { id: 1, project: { identifier: "p" } } });
      const res = await call(`/webhooks/no-secret/issue.created`, {
        body,
        headers: { "x-hub-signature-256": hmacSig(body, SECRET) },
      });
      expect(res.status).toBe(401);
    });

    it("returns 400 on invalid JSON after a valid signature", async () => {
      const body = "{not-json";
      const res = await call(`/webhooks/${INTEGRATION_ID}/issue.created`, {
        body,
        headers: { "x-hub-signature-256": hmacSig(body, SECRET) },
      });
      expect(res.status).toBe(400);
    });

    it("returns 405 on non-POST", async () => {
      const res = await call(`/webhooks/${INTEGRATION_ID}/issue.created`, { method: "GET" });
      expect(res.status).toBe(405);
    });
  });
});

describe("generateWebhookSecret()", () => {
  it("returns a 64-hex-char secret", () => {
    const s = generateWebhookSecret();
    expect(s).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different secrets each call", () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a).not.toBe(b);
  });

  it("produces a secret usable with timingSafeEqual on the wire", () => {
    const s = generateWebhookSecret();
    const bufA = Buffer.from(s, "hex");
    const bufB = Buffer.from(s, "hex");
    expect(bufA.length).toBe(32);
    expect(timingSafeEqual(bufA, bufB)).toBe(true);
  });
});
