/**
 * Unit tests for prompt management API routes in adminServer.
 *
 * Covers:
 *  - GET  /api/admin/prompts          → list all prompts
 *  - GET  /api/admin/prompts/:id      → get one prompt
 *  - PUT  /api/admin/prompts/:id      → update prompt content
 *  - POST /api/admin/prompts          → create new prompt
 *  - DELETE /api/admin/prompts/:id    → delete custom prompt
 *
 * Returns 501 when no promptStore is configured.
 * Returns 404 for unknown prompt ids.
 * Returns 400 when content is missing on PUT.
 * Returns 409 when attempting to create duplicate or delete built-in.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createAdminServer } from "../../src/admin/adminServer.js";
import type { AdminServerDependencies } from "../../src/admin/adminServer.js";
import type { PromptStore, Prompt } from "../../src/interfaces.js";
import type { Server } from "node:http";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePrompt(overrides: Partial<Prompt> = {}): Prompt {
  return {
    id: "system",
    label: "System Prompt",
    content: "You are a software engineer.",
    promptType: "user",
    updatedAt: new Date("2026-04-10T12:00:00.000Z"),
    ...overrides,
  };
}

function makePromptStore(initial: Prompt[] = []): PromptStore {
  const data = new Map<string, Prompt>();
  for (const p of initial) data.set(p.id, { ...p });

  return {
    getPrompts: vi.fn(async () => [...data.values()]),
    getPrompt: vi.fn(async (id: string) => data.get(id) ?? null),
    upsertPrompt: vi.fn(async (id: string, content: string) => {
      const existing = data.get(id);
      const updated: Prompt = {
        id,
        label: existing?.label ?? id,
        content,        promptType: existing?.promptType ?? "user",        updatedAt: new Date(),
      };
      data.set(id, updated);
      return updated;
    }),
    createPrompt: vi.fn(async (label: string, content: string) => {
      // Check for duplicates (case-insensitive)
      const normalized = label.toLowerCase().replace(/\s+/g, "-");
      for (const p of data.values()) {
        if (p.label.toLowerCase() === label.toLowerCase()) {
          const err = new Error("Prompt already exists");
          (err as any).code = "DUPLICATE";
          throw err;
        }
      }
      if (!label || label.trim().length === 0) {
        const err = new Error("Invalid prompt label");
        (err as any).code = "INVALID_LABEL";
        throw err;
      }
      const id = normalized;
      const prompt: Prompt = { id, label, content, promptType: "user", updatedAt: new Date() };
      data.set(id, prompt);
      return prompt;
    }),
    deletePrompt: vi.fn(async (id: string) => {
      const BUILT_IN_IDS = new Set([
        'system_gerrit_code', 'system_gitlab_code',
        'system_gerrit_review', 'system_gitlab_review',
        'user_gerrit_review', 'user_gitlab_review',
      ]);
      if (BUILT_IN_IDS.has(id)) {
        const err = new Error("Cannot delete built-in prompt");
        (err as any).code = "BUILT_IN";
        throw err;
      }
      if (!data.has(id)) {
        const err = new Error("Prompt not found");
        (err as any).code = "NOT_FOUND";
        throw err;
      }
      data.delete(id);
    }),
  };
}

function makeMinimalDeps(
  overrides: Partial<AdminServerDependencies> = {}
): AdminServerDependencies {
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
      getCostSummary: vi.fn(async () => ({ totalUsd: 0, totalAiCredits: 0, totalPremiumRequests: 0, totalRuns: 0, perProject: [], sinceEpochSeconds: null })),
    },
    config: {
      nodeEnv: "test",
      logLevel: "error",
      maxAgentCycles: 3,
      maxRetryAttempts: 5,
      pollingIntervalMs: 30_000,
    },
    polling: {
      isRunning: () => false,
      getIntervals: () => ({ intervalMs: 30_000 }),
    },
    providers: [],
    ...overrides,
  };
}

async function fetchFromServer(
  server: Server,
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Server not bound");
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const init: RequestInit = { method: options.method ?? "GET" };
  if (options.body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(options.body);
  }

  const res = await fetch(url, init);
  const text = await res.text();
  let body: Record<string, unknown> = {};
  if (text) {
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* empty body */ }
  }
  return { status: res.status, body };
}

// ── Test setup ─────────────────────────────────────────────────────────────────

describe("Admin API — Prompt routes", () => {
  let server: Server;
  let promptStore: PromptStore;

  const defaultPrompts: Prompt[] = [
    makePrompt({ id: "system_gerrit_code", label: "System Prompt — Gerrit (code)", content: "You are a software engineer." }),
    makePrompt({ id: "user_gerrit_review", label: "User Prompt — Gerrit (review)", content: "Use your file tools to implement the task." }),
  ];

  beforeEach(async () => {
    promptStore = makePromptStore(defaultPrompts);
    const deps = makeMinimalDeps({ promptStore });
    server = createAdminServer(deps);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  });

  // ── GET /api/admin/prompts ─────────────────────────────────────────────────

  describe("GET /api/admin/prompts", () => {
    it("returns 200 with a list of all prompts", async () => {
      const { status, body } = await fetchFromServer(server, "/api/admin/prompts");

      expect(status).toBe(200);
      const prompts = body["prompts"] as Array<Record<string, unknown>>;
      expect(Array.isArray(prompts)).toBe(true);
      expect(prompts).toHaveLength(2);
    });

    it("includes id, label, content, and updatedAt for each prompt", async () => {
      const { body } = await fetchFromServer(server, "/api/admin/prompts");

      const prompts = body["prompts"] as Array<Record<string, unknown>>;
      const system = prompts.find((p) => p["id"] === "system_gerrit_code");

      expect(system).toMatchObject({
        id: "system_gerrit_code",
        label: "System Prompt — Gerrit (code)",
        content: "You are a software engineer.",
      });
      expect(typeof system!["updatedAt"]).toBe("string");
    });

    it("returns 501 when promptStore is not configured", async () => {
      const serverWithout = createAdminServer(makeMinimalDeps({ promptStore: undefined }));
      await new Promise<void>((resolve) => serverWithout.listen(0, "127.0.0.1", resolve));

      try {
        const addr = serverWithout.address();
        const url = `http://127.0.0.1:${(addr as { port: number }).port}/api/admin/prompts`;
        const res = await fetch(url);
        expect(res.status).toBe(501);
        const body = await res.json() as Record<string, unknown>;
        expect(body["error"]).toMatch(/not available/i);
      } finally {
        await new Promise<void>((resolve, reject) =>
          serverWithout.close((err) => (err ? reject(err) : resolve()))
        );
      }
    });

    it("calls promptStore.getPrompts once per request", async () => {
      await fetchFromServer(server, "/api/admin/prompts");
      expect(vi.mocked(promptStore.getPrompts)).toHaveBeenCalledOnce();
    });

    it("returns 405 for non-GET methods on the collection endpoint", async () => {
      const { status } = await fetchFromServer(server, "/api/admin/prompts", {
        method: "PATCH",
        body: { content: "x" },
      });
      expect(status).toBe(405);
    });
  });

  // ── GET /api/admin/prompts/:id ────────────────────────────────────────────

  describe("GET /api/admin/prompts/:id", () => {
    it("returns 200 with the prompt when found", async () => {
      const { status, body } = await fetchFromServer(server, "/api/admin/prompts/system_gerrit_code");

      expect(status).toBe(200);
      const prompt = body["prompt"] as Record<string, unknown>;
      expect(prompt["id"]).toBe("system_gerrit_code");
      expect(prompt["content"]).toBe("You are a software engineer.");
    });

    it("returns 200 for the user_gerrit_review prompt", async () => {
      const { status, body } = await fetchFromServer(server, "/api/admin/prompts/user_gerrit_review");

      expect(status).toBe(200);
      const prompt = body["prompt"] as Record<string, unknown>;
      expect(prompt["id"]).toBe("user_gerrit_review");
    });

    it("returns 404 for an unknown prompt id", async () => {
      const { status, body } = await fetchFromServer(server, "/api/admin/prompts/nonexistent");

      expect(status).toBe(404);
      expect(body["error"]).toMatch(/not found/i);
    });

    it("returns 501 when promptStore is not configured", async () => {
      const serverWithout = createAdminServer(makeMinimalDeps({ promptStore: undefined }));
      await new Promise<void>((resolve) => serverWithout.listen(0, "127.0.0.1", resolve));

      try {
        const addr = serverWithout.address();
        const url = `http://127.0.0.1:${(addr as { port: number }).port}/api/admin/prompts/system`;
        const res = await fetch(url);
        expect(res.status).toBe(501);
      } finally {
        await new Promise<void>((resolve, reject) =>
          serverWithout.close((err) => (err ? reject(err) : resolve()))
        );
      }
    });

    it("returns 405 for non-GET methods except PUT", async () => {
      const { status } = await fetchFromServer(server, "/api/admin/prompts/system", {
        method: "POST",
        body: {},
      });
      expect(status).toBe(405);
    });
  });

  // ── PUT /api/admin/prompts/:id ────────────────────────────────────────────

  describe("PUT /api/admin/prompts/:id", () => {
    it("returns 200 with the updated prompt on success", async () => {
      const { status, body } = await fetchFromServer(server, "/api/admin/prompts/system_gerrit_code", {
        method: "PUT",
        body: { content: "You are an expert TypeScript engineer." },
      });

      expect(status).toBe(200);
      const prompt = body["prompt"] as Record<string, unknown>;
      expect(prompt["id"]).toBe("system_gerrit_code");
      expect(prompt["content"]).toBe("You are an expert TypeScript engineer.");
    });

    it("persists the new content (subsequent GET returns updated value)", async () => {
      await fetchFromServer(server, "/api/admin/prompts/user_gerrit_review", {
        method: "PUT",
        body: { content: "Only write tests, never implementation." },
      });

      const { body } = await fetchFromServer(server, "/api/admin/prompts/user_gerrit_review");
      const prompt = body["prompt"] as Record<string, unknown>;
      expect(prompt["content"]).toBe("Only write tests, never implementation.");
    });

    it("returns 400 when content field is missing", async () => {
      const { status, body } = await fetchFromServer(server, "/api/admin/prompts/system_gerrit_code", {
        method: "PUT",
        body: {},
      });

      expect(status).toBe(400);
      expect(body["error"]).toMatch(/content/i);
    });

    it("returns 400 when content is not a string", async () => {
      const { status, body } = await fetchFromServer(server, "/api/admin/prompts/system_gerrit_code", {
        method: "PUT",
        body: { content: 42 },
      });

      expect(status).toBe(400);
      expect(body["error"]).toMatch(/content/i);
    });

    it("returns 400 when body is missing entirely", async () => {
      const addr = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/admin/prompts/system_gerrit_code`, {
        method: "PUT",
      });

      expect(res.status).toBe(400);
    });

    it("returns 404 for an unknown prompt id", async () => {
      const { status, body } = await fetchFromServer(server, "/api/admin/prompts/does-not-exist", {
        method: "PUT",
        body: { content: "some content" },
      });

      expect(status).toBe(404);
      expect(body["error"]).toMatch(/not found/i);
    });

    it("returns 501 when promptStore is not configured", async () => {
      const serverWithout = createAdminServer(makeMinimalDeps({ promptStore: undefined }));
      await new Promise<void>((resolve) => serverWithout.listen(0, "127.0.0.1", resolve));

      try {
        const addr = serverWithout.address() as { port: number };
        const res = await fetch(`http://127.0.0.1:${addr.port}/api/admin/prompts/system`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: "updated" }),
        });
        expect(res.status).toBe(501);
      } finally {
        await new Promise<void>((resolve, reject) =>
          serverWithout.close((err) => (err ? reject(err) : resolve()))
        );
      }
    });

    it("accepts multi-line content with newlines preserved in the response", async () => {
      const multiline = "Line 1\nLine 2\n\nLine 4";
      const { status, body } = await fetchFromServer(server, "/api/admin/prompts/system_gerrit_code", {
        method: "PUT",
        body: { content: multiline },
      });

      expect(status).toBe(200);
      const prompt = body["prompt"] as Record<string, unknown>;
      expect(prompt["content"]).toBe(multiline);
    });

    it("calls promptStore.upsertPrompt with the correct id and content", async () => {
      await fetchFromServer(server, "/api/admin/prompts/user_gerrit_review", {
        method: "PUT",
        body: { content: "New instructions" },
      });

      expect(vi.mocked(promptStore.upsertPrompt)).toHaveBeenCalledWith(
        "user_gerrit_review",
        "New instructions"
      );
    });
  });

  // ── POST /api/admin/prompts ──────────────────────────────────────────────

  describe("POST /api/admin/prompts", () => {
    it("returns 201 with the created prompt on success", async () => {
      const { status, body } = await fetchFromServer(server, "/api/admin/prompts", {
        method: "POST",
        body: { label: "Test Prompt", content: "Test content" },
      });

      expect(status).toBe(201);
      const prompt = body["prompt"] as Record<string, unknown>;
      expect(prompt["label"]).toBe("Test Prompt");
      expect(prompt["content"]).toBe("Test content");
      expect(typeof prompt["id"]).toBe("string");
    });

    it("calls promptStore.createPrompt with label and content", async () => {
      await fetchFromServer(server, "/api/admin/prompts", {
        method: "POST",
        body: { label: "My New Prompt", content: "My content" },
      });

      expect(vi.mocked(promptStore.createPrompt)).toHaveBeenCalledWith(
        "My New Prompt",
        "My content"
      );
    });

    it("returns 400 when label is missing", async () => {
      const { status, body } = await fetchFromServer(server, "/api/admin/prompts", {
        method: "POST",
        body: { content: "some content" },
      });

      expect(status).toBe(400);
      expect(body["error"]).toMatch(/label/i);
    });

    it("returns 400 when content is missing", async () => {
      const { status, body } = await fetchFromServer(server, "/api/admin/prompts", {
        method: "POST",
        body: { label: "Test Prompt" },
      });

      expect(status).toBe(400);
      expect(body["error"]).toMatch(/content/i);
    });

    it("returns 400 when label is not a string", async () => {
      const { status } = await fetchFromServer(server, "/api/admin/prompts", {
        method: "POST",
        body: { label: 42, content: "content" },
      });

      expect(status).toBe(400);
    });

    it("returns 400 when content is not a string", async () => {
      const { status } = await fetchFromServer(server, "/api/admin/prompts", {
        method: "POST",
        body: { label: "Test", content: ["not", "a", "string"] },
      });

      expect(status).toBe(400);
    });

    it("returns 409 when creating a prompt with a duplicate label", async () => {
      // First create a prompt
      await fetchFromServer(server, "/api/admin/prompts", {
        method: "POST",
        body: { label: "Unique Name", content: "content1" },
      });

      // Try to create with the same label
      const { status, body } = await fetchFromServer(server, "/api/admin/prompts", {
        method: "POST",
        body: { label: "Unique Name", content: "content2" },
      });

      expect(status).toBe(409);
      expect(body["error"]).toMatch(/already exists|duplicate/i);
    });

    it("returns 501 when promptStore is not configured", async () => {
      const serverWithout = createAdminServer(makeMinimalDeps({ promptStore: undefined }));
      await new Promise<void>((resolve) => serverWithout.listen(0, "127.0.0.1", resolve));

      try {
        const addr = serverWithout.address() as { port: number };
        const res = await fetch(`http://127.0.0.1:${addr.port}/api/admin/prompts`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ label: "Test", content: "content" }),
        });
        expect(res.status).toBe(501);
      } finally {
        await new Promise<void>((resolve, reject) =>
          serverWithout.close((err) => (err ? reject(err) : resolve()))
        );
      }
    });

    it("persists the created prompt (subsequent GET returns it)", async () => {
      const createRes = await fetchFromServer(server, "/api/admin/prompts", {
        method: "POST",
        body: { label: "Persistent Prompt", content: "persistent content" },
      });

      const createdPrompt = createRes.body["prompt"] as Record<string, unknown>;
      const id = createdPrompt["id"] as string;

      const { body } = await fetchFromServer(server, `/api/admin/prompts/${id}`);
      const retrieved = body["prompt"] as Record<string, unknown>;
      expect(retrieved["label"]).toBe("Persistent Prompt");
      expect(retrieved["content"]).toBe("persistent content");
    });
  });

  // ── DELETE /api/admin/prompts/:id ────────────────────────────────────────

  describe("DELETE /api/admin/prompts/:id", () => {
    it("returns 204 on successful deletion", async () => {
      const createRes = await fetchFromServer(server, "/api/admin/prompts", {
        method: "POST",
        body: { label: "To Delete", content: "content" },
      });

      const id = (createRes.body["prompt"] as Record<string, unknown>)["id"] as string;

      const { status } = await fetchFromServer(server, `/api/admin/prompts/${id}`, {
        method: "DELETE",
      });

      expect(status).toBe(204);
    });

    it("calls promptStore.deletePrompt with the correct id", async () => {
      const createRes = await fetchFromServer(server, "/api/admin/prompts", {
        method: "POST",
        body: { label: "To Delete", content: "content" },
      });

      const id = (createRes.body["prompt"] as Record<string, unknown>)["id"] as string;

      await fetchFromServer(server, `/api/admin/prompts/${id}`, {
        method: "DELETE",
      });

      expect(vi.mocked(promptStore.deletePrompt)).toHaveBeenCalledWith(id);
    });

    it("removes the prompt from the database", async () => {
      const createRes = await fetchFromServer(server, "/api/admin/prompts", {
        method: "POST",
        body: { label: "Delete Me", content: "content" },
      });

      const id = (createRes.body["prompt"] as Record<string, unknown>)["id"] as string;

      await fetchFromServer(server, `/api/admin/prompts/${id}`, {
        method: "DELETE",
      });

      const { status } = await fetchFromServer(server, `/api/admin/prompts/${id}`);
      expect(status).toBe(404);
    });

    it("returns 409 when deleting the 'system_gerrit_code' built-in prompt", async () => {
      const { status, body } = await fetchFromServer(server, "/api/admin/prompts/system_gerrit_code", {
        method: "DELETE",
      });

      expect(status).toBe(409);
      expect(body["error"]).toMatch(/cannot delete|built-in/i);
    });

    it("returns 409 when deleting the 'user_gerrit_review' built-in prompt", async () => {
      const { status, body } = await fetchFromServer(server, "/api/admin/prompts/user_gerrit_review", {
        method: "DELETE",
      });

      expect(status).toBe(409);
      expect(body["error"]).toMatch(/cannot delete|built-in/i);
    });

    it("returns 404 when deleting a non-existent prompt", async () => {
      const { status, body } = await fetchFromServer(server, "/api/admin/prompts/nonexistent", {
        method: "DELETE",
      });

      expect(status).toBe(404);
      expect(body["error"]).toMatch(/not found/i);
    });

    it("returns 501 when promptStore is not configured", async () => {
      const serverWithout = createAdminServer(makeMinimalDeps({ promptStore: undefined }));
      await new Promise<void>((resolve) => serverWithout.listen(0, "127.0.0.1", resolve));

      try {
        const addr = serverWithout.address() as { port: number };
        const res = await fetch(`http://127.0.0.1:${addr.port}/api/admin/prompts/test`, {
          method: "DELETE",
        });
        expect(res.status).toBe(501);
      } finally {
        await new Promise<void>((resolve, reject) =>
          serverWithout.close((err) => (err ? reject(err) : resolve()))
        );
      }
    });

    it("does not affect other prompts when one is deleted", async () => {
      const p1 = await fetchFromServer(server, "/api/admin/prompts", {
        method: "POST",
        body: { label: "Prompt 1", content: "content1" },
      });
      const p2 = await fetchFromServer(server, "/api/admin/prompts", {
        method: "POST",
        body: { label: "Prompt 2", content: "content2" },
      });

      const id1 = (p1.body["prompt"] as Record<string, unknown>)["id"] as string;
      const id2 = (p2.body["prompt"] as Record<string, unknown>)["id"] as string;

      await fetchFromServer(server, `/api/admin/prompts/${id1}`, {
        method: "DELETE",
      });

      const { body } = await fetchFromServer(server, `/api/admin/prompts/${id2}`);
      const retrieved = body["prompt"] as Record<string, unknown>;
      expect(retrieved["id"]).toBe(id2);
      expect(retrieved["content"]).toBe("content2");
    });
  });
});
