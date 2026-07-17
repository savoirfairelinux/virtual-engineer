/**
 * Unit tests for CopilotAdapter prompt injection.
 *
 * Verifies that when a PromptStore is provided, the adapter injects
 * SYSTEM_PROMPT and INSTRUCTIONS_PROMPT into the container env vars
 * (picked up by agent-worker/src/index.ts at runtime).
 *
 * When no store is provided (or prompts are not found), the adapter
 * must NOT set these env vars — agent-worker falls back to hardcoded defaults.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promisify } from "util";
import { makeTaskId } from "../../src/interfaces.js";
import type { TaskContext, PromptStore, Prompt } from "../../src/interfaces.js";
import { randomUUID } from "crypto";

// ── Mock child_process BEFORE importing CopilotAdapter ───────────────────────
vi.mock("child_process", () => {
  const fn = vi.fn();
  const promisifiedFn = fn as unknown as typeof fn & Record<symbol, unknown>;
  promisifiedFn[promisify.custom] = (...args: unknown[]) =>
    new Promise((resolve, reject) => {
      fn(...args, (err: Error | null, stdout: string, stderr: string) => {
        if (err) return reject(Object.assign(err, { stdout, stderr }));
        resolve({ stdout, stderr });
      });
    });
  return { execFile: fn };
});

import { CopilotAdapter } from "../../src/agents/copilotAdapter.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePrompt(id: string, content: string): Prompt {
  return {
    id,
    label: id === "system_generic_code"
      ? "System Prompt"
      : id === "instructions_generic_code"
        ? "Instructions Prompt"
        : id,
    content,
    promptType: "user",
    updatedAt: new Date(),
  };
}

function makePromptStore(overrides: Record<string, string> = {}): PromptStore {
  const prompts: Record<string, Prompt> = {
    system_generic_code: makePrompt("system_generic_code", overrides["system_generic_code"] ?? "Default system prompt"),
    instructions_generic_code: makePrompt("instructions_generic_code", overrides["instructions_generic_code"] ?? "Default instructions prompt"),
  };
  for (const [id, content] of Object.entries(overrides)) {
    prompts[id] = makePrompt(id, content);
  }
  return {
    getPrompts: vi.fn(async () => Object.values(prompts)),
    getPrompt: vi.fn(async (id: string) => prompts[id] ?? null),
    upsertPrompt: vi.fn(async (id: string, content: string) => {
      const existing = prompts[id];
      prompts[id] = { id, label: existing?.label ?? id, content, promptType: existing?.promptType ?? "user", updatedAt: new Date() };
      return prompts[id]!;
    }),
    createPrompt: vi.fn(async (label: string, content: string) => {
      const id = label;
      prompts[id] = { id, label, content, promptType: "user", updatedAt: new Date() };
      return prompts[id]!;
    }),
    deletePrompt: vi.fn(async (id: string) => {
      delete prompts[id];
    }),
  };
}

function makeContext(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    taskId: makeTaskId(randomUUID()),
    ticketTitle: "Implement feature X",
    ticketDescription: "Feature X description",
    acceptanceCriteria: ["Works correctly"],
    baseBranch: "main",
    workspacePath: "/workspace",
    volumeName: "ve-ws-test-1234",
    homeVolumeName: "ve-home-test-1234",
    constraints: [],
    priorFeedback: [],
    cycleNumber: 1,
    commitMessage: "feat: implement feature X",
    agentSession: {
      agentContainerImage: "virtual-engineer-workspace:latest",
      repoCloneUrl: "ssh://localhost:29418/demo-project",
      pushRef: "refs/for/main",
      gitAuthorName: "Virtual Engineer",
      gitAuthorEmail: "virtual-engineer@localhost",
      githubToken: "ghp_test-token",
    },
    ...overrides,
  };
}

function makeDockerInvoker(stdout: string, stderr = "") {
  return vi.fn().mockResolvedValue({ stdout, stderr });
}

function agentResultJson(overrides: object = {}): string {
  return JSON.stringify({
    status: "success",
    modifiedFiles: ["src/index.ts"],
    summary: "Done",
    agentLogs: "info: done",
    gerritChangeId: "I1234567890abcdef1234567890abcdef12345678",
    metadata: { adapter: "copilot-sdk", model: "gpt-4o" },
    ...overrides,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("CopilotAdapter — prompt injection", () => {
  beforeEach(() => {
    process.env["GITHUB_TOKEN"] = "ghp_test-token";
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env["GITHUB_TOKEN"];
  });

  describe("buildContainerSpec — with promptStore", () => {
    it("injects SYSTEM_PROMPT env var from the store", async () => {
      const store = makePromptStore({ system_generic_code: "You are a strict TypeScript engineer." });
      const adapter = new CopilotAdapter({});
      adapter.setPromptStore(store);

      const spec = await adapter.buildContainerSpecWithPrompts(makeContext(), {});

      expect(spec.env["SYSTEM_PROMPT"]).toBe("You are a strict TypeScript engineer.");
    });

    it("encodes multiline system prompts from the store", async () => {
      const content = "You are a strict engineer.\nReturn one focused change.";
      const store = makePromptStore({ system_generic_code: content });
      const adapter = new CopilotAdapter({});
      adapter.setPromptStore(store);

      const spec = await adapter.buildContainerSpecWithPrompts(makeContext(), {});

      expect(spec.env["SYSTEM_PROMPT"]).toBeUndefined();
      expect(spec.env["SYSTEM_PROMPT_BASE64"]).toBe(
        Buffer.from(content, "utf8").toString("base64")
      );
    });

    it("sets userPromptContent on the spec from the store", async () => {
      const store = makePromptStore({ instructions_generic_code: "Follow these instructions carefully." });
      const adapter = new CopilotAdapter({});
      adapter.setPromptStore(store);

      const spec = await adapter.buildContainerSpecWithPrompts(makeContext(), {});

      expect(spec.userPromptContent).toBeDefined();
      expect(spec.userPromptContent).toContain("Follow these instructions carefully.");
    });

    it("sets SYSTEM_PROMPT env and userPromptContent in one call", async () => {
      const store = makePromptStore({
        system_generic_code: "Custom system",
        instructions_generic_code: "Custom instructions",
      });
      const adapter = new CopilotAdapter({});
      adapter.setPromptStore(store);

      const spec = await adapter.buildContainerSpecWithPrompts(makeContext(), {});

      expect(spec.env["SYSTEM_PROMPT"]).toBe("Custom system");
      expect(spec.userPromptContent).toContain("Custom instructions");
    });

    it("does not override other env vars when injecting prompts", async () => {
      const store = makePromptStore({ system: "sys", instructions: "ins" });
      const adapter = new CopilotAdapter({ model: "gpt-4o-mini" });
      adapter.setPromptStore(store);

      const spec = await adapter.buildContainerSpecWithPrompts(makeContext(), {
        GITHUB_TOKEN: "ghp_token",
      });

      expect(spec.env["COPILOT_MODEL"]).toBe("gpt-4o-mini");
      expect(spec.env["GITHUB_TOKEN"]).toBe("ghp_token");
      expect(spec.env["GIT_AUTHOR_NAME"]).toBe("Virtual Engineer");
    });

    it("calls promptStore.getPrompt for 'system_generic_code' and 'instructions_generic_code'", async () => {
      const store = makePromptStore();
      const adapter = new CopilotAdapter({});
      adapter.setPromptStore(store);

      await adapter.buildContainerSpecWithPrompts(makeContext(), {});

      expect(vi.mocked(store.getPrompt)).toHaveBeenCalledWith("system_generic_code");
      expect(vi.mocked(store.getPrompt)).toHaveBeenCalledWith("instructions_generic_code");
    });

    it("uses task-specific prompt ids when provided", async () => {
      const store = makePromptStore({
        "project-system": "Project system prompt",
        "project-instructions": "Project instructions prompt",
      });
      const adapter = new CopilotAdapter({});
      adapter.setPromptStore(store);

      const spec = await adapter.buildContainerSpecWithPrompts(makeContext({
        systemPromptId: "project-system",
        instructionsPromptId: "project-instructions",
      }), {});

      expect(spec.env["SYSTEM_PROMPT"]).toBe("Project system prompt");
      expect(spec.userPromptContent).toContain("Project instructions prompt");
      expect(vi.mocked(store.getPrompt)).toHaveBeenCalledWith("project-system");
      expect(vi.mocked(store.getPrompt)).toHaveBeenCalledWith("project-instructions");
    });
  });

  describe("buildContainerSpec — without promptStore", () => {
    it("does NOT include SYSTEM_PROMPT in env when no store is set", () => {
      const adapter = new CopilotAdapter({});
      const spec = adapter.buildContainerSpec(makeContext(), {});

      expect(spec.env["SYSTEM_PROMPT"]).toBeUndefined();
    });

    it("does NOT include userPromptContent when no store is set", () => {
      const adapter = new CopilotAdapter({});
      const spec = adapter.buildContainerSpec(makeContext(), {});

      expect(spec.userPromptContent).toBeUndefined();
    });
  });

  describe("buildContainerSpec — with promptStore, missing prompts", () => {
    it("omits SYSTEM_PROMPT when the store returns null for 'system'", async () => {
      const store: PromptStore = {
        getPrompts: vi.fn(async () => []),
        getPrompt: vi.fn(async () => null),
        upsertPrompt: vi.fn(async (id, content) =>
          makePrompt(id, content)
        ),
        createPrompt: vi.fn(async (label, content) => makePrompt(label, content)),
        deletePrompt: vi.fn(async () => {}),
      };
      const adapter = new CopilotAdapter({});
      adapter.setPromptStore(store);

      const spec = await adapter.buildContainerSpecWithPrompts(makeContext(), {});

      expect(spec.env["SYSTEM_PROMPT"]).toBeUndefined();
      expect(spec.userPromptContent).toBeUndefined();
    });

    it("omits userPromptContent when task context explicitly disables prompt ids", async () => {
      const store = makePromptStore();
      const adapter = new CopilotAdapter({});
      adapter.setPromptStore(store);

      const spec = await adapter.buildContainerSpecWithPrompts(makeContext({
        systemPromptId: null,
        instructionsPromptId: null,
      }), {});

      expect(spec.env["SYSTEM_PROMPT"]).toBeUndefined();
      expect(spec.userPromptContent).toBeUndefined();
      expect(vi.mocked(store.getPrompt)).not.toHaveBeenCalled();
    });
  });

  describe("setPromptStore", () => {
    it("can be called multiple times — last store wins", async () => {
      const store1 = makePromptStore({ system_generic_code: "Store 1 system" });
      const store2 = makePromptStore({ system_generic_code: "Store 2 system" });
      const adapter = new CopilotAdapter({});

      adapter.setPromptStore(store1);
      adapter.setPromptStore(store2);

      const spec = await adapter.buildContainerSpecWithPrompts(makeContext(), {});

      expect(spec.env["SYSTEM_PROMPT"]).toBe("Store 2 system");
      expect(vi.mocked(store1.getPrompt)).not.toHaveBeenCalled();
    });
  });

  describe("execute — prompt env vars are passed to docker invoker", () => {
    it("passes SYSTEM_PROMPT env and userPromptContent to the docker invoker via container spec", async () => {
      const capturedSpecs: Array<{ env: Record<string, unknown>; userPromptContent?: string }> = [];
      const store = makePromptStore({
        system_generic_code: "Injected system prompt",
        instructions_generic_code: "Injected instructions",
      });

      const adapter = new CopilotAdapter({});
      adapter.setPromptStore(store);

      // Capture the spec used during execution by intercepting buildContainerSpecWithPrompts
      const originalBuild = adapter.buildContainerSpecWithPrompts.bind(adapter);
      vi.spyOn(adapter, "buildContainerSpecWithPrompts").mockImplementation(
        async (ctx, authEnv) => {
          const spec = await originalBuild(ctx, authEnv);
          capturedSpecs.push({
            env: spec.env as Record<string, unknown>,
            ...(spec.userPromptContent !== undefined ? { userPromptContent: spec.userPromptContent } : {}),
          });
          return spec;
        }
      );

      const invoker = makeDockerInvoker(agentResultJson());
      adapter.setDockerInvoker(invoker);

      await adapter.execute(makeContext());

      expect(capturedSpecs).toHaveLength(1);
      expect(capturedSpecs[0]!.env["SYSTEM_PROMPT"]).toBe("Injected system prompt");
      expect(capturedSpecs[0]!.userPromptContent).toContain("Injected instructions");
    });
  });
});
