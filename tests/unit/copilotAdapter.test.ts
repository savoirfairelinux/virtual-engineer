/**
 * Deterministic unit tests for CopilotAdapter.
 *
 * Docker is never actually invoked: child_process.execFile is mocked at
 * module load time so every test is purely in-process and reproducible.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeTaskId, makeExternalChangeId } from "../../src/interfaces.js";
import type { TaskContext, AgentLogEvent, Prompt, PromptStore, RepositoryMap } from "../../src/interfaces.js";
import { randomUUID } from "crypto";

// ── Mock child_process BEFORE importing CopilotAdapter ────────────────────────
// vi.mock is hoisted so execFile is the mock when CopilotAdapter loads and calls
// promisify(execFile). The promisified version then calls our mock with a
// standard node callback — we resolve with { stdout, stderr } so destructuring
// inside invokeAgentContainer works correctly.
//
// NOTE: util.promisify(execFile) uses the [util.promisify.custom] symbol on the
// real execFile to resolve { stdout, stderr }. A plain vi.fn() lacks that symbol,
// so we register it manually so promisify resolves with the expected object shape.
import { promisify } from "util";
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

import { execFile } from "child_process";
import { CopilotAdapter as BaseCopilotAdapter, agentLogBus } from "../../src/agents/copilotAdapter.js";
import { buildCodegenUserPrompt } from "../../src/agents/copilotAdapter.js";

const mockExecFile = vi.mocked(execFile);

const testPromptStore: PromptStore = {
  getPrompts: vi.fn(async () => []),
  getPrompt: vi.fn(async (id: string): Promise<Prompt> => ({
    id,
    label: id,
    content: id === "test-system" ? "You are a test engineer." : "Follow the test instructions.",
    promptType: "system",
    updatedAt: new Date(),
  })),
  upsertPrompt: vi.fn(async (id: string, content: string): Promise<Prompt> => ({ id, label: id, content, promptType: "system", updatedAt: new Date() })),
  createPrompt: vi.fn(async (label: string, content: string): Promise<Prompt> => ({ id: label, label, content, promptType: "user", updatedAt: new Date() })),
  deletePrompt: vi.fn(async () => {}),
};

class CopilotAdapter extends BaseCopilotAdapter {
  constructor(...args: ConstructorParameters<typeof BaseCopilotAdapter>) {
    super(...args);
    this.setPromptStore(testPromptStore);
  }
}

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeContext(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    taskId: makeTaskId(randomUUID()),
    ticketTitle: "Add structured logging",
    ticketDescription: "Add JSON-format logs to the user service",
    acceptanceCriteria: ["Logs must be in JSON format"],
    baseBranch: "main",
    workspacePath: "/workspace",
    volumeName: "ve-ws-test-1234",
    homeVolumeName: "ve-home-test-1234",
    constraints: [],
    priorFeedback: [],
    cycleNumber: 1,
    commitMessage: "Add structured logging to user service",
    ticketUrl: "http://localhost:3000/issues/1",
    systemPromptId: "test-system",
    instructionsPromptId: "test-instructions",
    agentSession: {
      agentContainerImage: "virtual-engineer-workspace:latest",
      repoCloneUrl: "ssh://localhost:29418/demo-project",
      pushRef: "refs/for/main",
      gitAuthorName: "Virtual Engineer",
      gitAuthorEmail: "virtual-engineer@localhost",
      githubToken: "ghp_test-token-deterministic",
    },
    ...overrides,
  };
}

/** Minimal valid AgentResult JSON the worker writes to stdout. */
function agentResultJson(overrides: object = {}): string {
  return JSON.stringify({
    status: "success",
    modifiedFiles: ["src/index.ts"],
    summary: "Added logging",
    agentLogs: "info: done",
    gerritChangeId: "I1234567890abcdef1234567890abcdef12345678",
    commitSha: "deadbeef",
    metadata: { adapter: "copilot-sdk", model: "gpt-4o" },
    ...overrides,
  });
}

function makeDockerInvoker(stdout: string, stderr = "") {
  return vi.fn().mockImplementation(async (_context, _authEnv, callbacks) => {
    if (stderr) {
      callbacks?.onStderrChunk?.(stderr);
    }
    return { stdout, stderr };
  });
}

function makeAdapterWithInvoker(stdout: string, stderr = "") {
  const adapter = new CopilotAdapter();
  const dockerInvoker = makeDockerInvoker(stdout, stderr);
  adapter.setDockerInvoker(dockerInvoker);
  return { adapter, dockerInvoker };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("CopilotAdapter", () => {
  beforeEach(() => {
    process.env["GITHUB_TOKEN"] = "ghp_test-token-deterministic";
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env["GITHUB_TOKEN"];
  });

  describe("buildContainerSpec", () => {
    it("builds a hardened container recipe from task context and adapter auth", () => {
      const adapter = new CopilotAdapter({ model: "gpt-4o-mini" });
      const context = makeContext();

      const spec = adapter.buildContainerSpec(context, {
        GITHUB_TOKEN: "ghp_spec_token",
      });

      expect(spec.image).toBe("virtual-engineer-workspace:latest");
      expect(spec.command).toEqual(["node", "/agent-worker/dist/index.js"]);
      expect(spec.networkMode).toBe("virtual-engineer_ve-agent-net");
      expect(spec.env).toMatchObject({
        GITHUB_TOKEN: "ghp_spec_token",
        COPILOT_MODEL: "gpt-4o-mini",
        GIT_AUTHOR_NAME: "Virtual Engineer",
        GIT_AUTHOR_EMAIL: "virtual-engineer@localhost",
      });
      expect(spec.additionalDockerArgs).toContain("--read-only");
      expect(spec.additionalDockerArgs).toContain("no-new-privileges:true");
      expect(spec.additionalDockerArgs).toContain("/tmp:rw,nosuid,size=256m");
      expect(spec.env["GH_CONFIG_DIR"]).toBeUndefined();
      expect(spec.additionalDockerArgs?.some((arg) => arg.includes(":/ve-gh:ro,Z"))).toBe(false);
    });

    it("defaults COPILOT_MODEL to auto", () => {
      const adapter = new CopilotAdapter();

      const spec = adapter.buildContainerSpec(makeContext(), {
        GITHUB_TOKEN: "ghp_spec_token",
      });

      expect(spec.env["COPILOT_MODEL"]).toBe("auto");
    });

    it("prefers a per-task model override from agentSession", () => {
      const adapter = new CopilotAdapter({
        model: "gpt-5.4",
      });
      const context = makeContext();
      context.agentSession.copilotModel = "gpt-4.1";

      const spec = adapter.buildContainerSpec(context, {
        GITHUB_TOKEN: "ghp_spec_token",
      });

      expect(spec.env["COPILOT_MODEL"]).toBe("gpt-4.1");
    });

    it("injects COPILOT_REASONING_EFFORT into container env when set", () => {
      const adapter = new CopilotAdapter({ model: "o3" });
      const context = makeContext();
      context.agentSession.copilotReasoningEffort = "medium";

      const spec = adapter.buildContainerSpec(context, { GITHUB_TOKEN: "ghp_tok" });

      expect(spec.env["COPILOT_REASONING_EFFORT"]).toBe("medium");
    });

    it("does not inject COPILOT_REASONING_EFFORT when not set", () => {
      const adapter = new CopilotAdapter({ model: "gpt-4o" });
      const context = makeContext();

      const spec = adapter.buildContainerSpec(context, { GITHUB_TOKEN: "ghp_tok" });

      expect(spec.env["COPILOT_REASONING_EFFORT"]).toBeUndefined();
    });

    it("injects SKILL_DISCOVERY=1 when the project enabled skill discovery", () => {
      const adapter = new CopilotAdapter();
      const context = makeContext();
      context.agentSession.skillDiscoveryEnabled = true;
      const spec = adapter.buildContainerSpec(context, { GITHUB_TOKEN: "ghp_tok" });

      expect(spec.env["SKILL_DISCOVERY"]).toBe("1");
    });

    it("injects LOCAL_SKILLS_PATH only when skill discovery is enabled", () => {
      const adapter = new CopilotAdapter();
      const context = makeContext();
      context.agentSession.localSkillsPath = "team/skills";
      expect(adapter.buildContainerSpec(context, { GITHUB_TOKEN: "ghp_tok" }).env["LOCAL_SKILLS_PATH"]).toBeUndefined();

      context.agentSession.skillDiscoveryEnabled = true;
      const spec = adapter.buildContainerSpec(context, { GITHUB_TOKEN: "ghp_tok" });
      expect(spec.env["LOCAL_SKILLS_PATH"]).toBe("team/skills");
    });

    it("does not expose SKILL_SOURCES_JSON to the agent container", () => {
      const adapter = new CopilotAdapter();
      const context = makeContext();
      context.agentSession.skillSourcesJson = "[{\"source\":\"ssh://skills.example.com/org/agent-skills\",\"skills\":[\"skill-a\"]}]";
      expect(adapter.buildContainerSpec(context, { GITHUB_TOKEN: "ghp_tok" }).env["SKILL_SOURCES_JSON"]).toBeUndefined();

      context.agentSession.skillDiscoveryEnabled = true;
      const spec = adapter.buildContainerSpec(context, { GITHUB_TOKEN: "ghp_tok" });
      expect(spec.env["SKILL_SOURCES_JSON"]).toBeUndefined();
    });

    it("omits SKILL_DISCOVERY when the project did not enable skill discovery", () => {
      const adapter = new CopilotAdapter();
      const spec = adapter.buildContainerSpec(makeContext(), { GITHUB_TOKEN: "ghp_tok" });

      expect(spec.env["SKILL_DISCOVERY"]).toBeUndefined();
    });

    it("injects TICKET_FOOTER_LINE when the project enabled full-URL ticket footers", () => {
      const adapter = new CopilotAdapter();
      const context = makeContext();
      context.agentSession.ticketFooterLine = "GitLab: https://gitlab.example.com/issues/123";
      const spec = adapter.buildContainerSpec(context, { GITHUB_TOKEN: "ghp_tok" });

      expect(spec.env["TICKET_FOOTER_LINE"]).toBe("GitLab: https://gitlab.example.com/issues/123");
    });

    it("omits TICKET_FOOTER_LINE when not set", () => {
      const adapter = new CopilotAdapter();
      const spec = adapter.buildContainerSpec(makeContext(), { GITHUB_TOKEN: "ghp_tok" });

      expect(spec.env["TICKET_FOOTER_LINE"]).toBeUndefined();
    });
  });

  describe("buildReviewContainerSpec", () => {
    function makeReviewInput() {
      return {
        changeId: makeExternalChangeId("I1234567890abcdef1234567890abcdef12345678"),
        revisionNumber: 42,
        patchset: 1,
        repositoryName: "demo-project",
        prompt: "Review this diff",
        systemPrompt: "You are a reviewer",
        agentToken: "ghp_review_token",
      };
    }

    it("omits SKILL_DISCOVERY when skillDiscoveryEnabled is not set", () => {
      const adapter = new CopilotAdapter();
      const spec = adapter.buildReviewContainerSpec(makeReviewInput(), {
        GITHUB_TOKEN: "ghp_tok",
      });

      expect(spec.env["SKILL_DISCOVERY"]).toBeUndefined();
    });

    it("injects SKILL_DISCOVERY=1 when skillDiscoveryEnabled is true", () => {
      const adapter = new CopilotAdapter();
      const input = { ...makeReviewInput(), skillDiscoveryEnabled: true };
      const spec = adapter.buildReviewContainerSpec(input, { GITHUB_TOKEN: "ghp_tok" });

      expect(spec.env["SKILL_DISCOVERY"]).toBe("1");
    });

    it("injects LOCAL_SKILLS_PATH in review specs only when skill discovery is enabled", () => {
      const adapter = new CopilotAdapter();
      expect(adapter.buildReviewContainerSpec({ ...makeReviewInput(), localSkillsPath: "team/skills" }, {
        GITHUB_TOKEN: "ghp_tok",
      }).env["LOCAL_SKILLS_PATH"]).toBeUndefined();

      const spec = adapter.buildReviewContainerSpec({
        ...makeReviewInput(),
        skillDiscoveryEnabled: true,
        localSkillsPath: "team/skills",
      }, { GITHUB_TOKEN: "ghp_tok" });
      expect(spec.env["LOCAL_SKILLS_PATH"]).toBe("team/skills");
    });

    it("does not expose SKILL_SOURCES_JSON in review specs", () => {
      const adapter = new CopilotAdapter();
      const skillSourcesJson = "[{\"source\":\"ssh://skills.example.com/org/agent-skills\",\"skills\":[\"skill-a\"]}]";
      const input = { ...makeReviewInput(), skillDiscoveryEnabled: true, skillSourcesJson };
      const spec = adapter.buildReviewContainerSpec(input, { GITHUB_TOKEN: "ghp_tok" });

      expect(spec.env["SKILL_SOURCES_JSON"]).toBeUndefined();
    });
  });

  // ── native PTY failure detection ───────────────────────────────────────────

  describe("isNativePtyLoadFailure", () => {
    const adapter = new CopilotAdapter();

    it("detects ERR_DLOPEN_FAILED", () => {
      expect(
        (adapter as any).isNativePtyLoadFailure("ERR_DLOPEN_FAILED: something went wrong")
      ).toBe(true);
    });

    it("detects mprotect permission denied message", () => {
      expect(
        (adapter as any).isNativePtyLoadFailure(
          "cannot apply additional memory protection after relocation: Permission denied"
        )
      ).toBe(true);
    });

    it("detects 'Failed to load native module: pty.node'", () => {
      expect(
        (adapter as any).isNativePtyLoadFailure("Failed to load native module: pty.node")
      ).toBe(true);
    });

    it("returns false for unrelated error messages", () => {
      expect((adapter as any).isNativePtyLoadFailure("ENOENT: file not found")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect((adapter as any).isNativePtyLoadFailure("")).toBe(false);
    });
  });

  // ── execute wiring ─────────────────────────────────────────────────────────

  describe("execute — docker command", () => {
    it("delegates docker execution to an injected invoker when configured", async () => {
      const { adapter, dockerInvoker } = makeAdapterWithInvoker(
        agentResultJson({ summary: "via workspace runner" })
      );

      const result = await adapter.execute(makeContext());

      expect(dockerInvoker).toHaveBeenCalledWith(
        expect.objectContaining({ workspacePath: "/workspace" }),
        { GITHUB_TOKEN: "ghp_test-token-deterministic" },
        expect.objectContaining({ onStderrChunk: expect.any(Function) })
      );
      expect(result.status).toBe("success");
      expect(result.summary).toBe("via workspace runner");
    });

    it("does not shell out to docker directly when an invoker is injected", async () => {
      const { adapter, dockerInvoker } = makeAdapterWithInvoker(agentResultJson());

      await adapter.execute(makeContext());

      expect(dockerInvoker).toHaveBeenCalledOnce();
      expect(mockExecFile).not.toHaveBeenCalledWith(
        "docker",
        expect.any(Array),
        expect.any(Function)
      );
    });

    it("fails fast when no docker invoker is configured", async () => {
      const adapter = new CopilotAdapter();

      await expect(adapter.execute(makeContext())).rejects.toThrow(
        /requires a docker invoker/
      );
    });
  });

  // ── result parsing ─────────────────────────────────────────────────────────

  describe("execute — result parsing", () => {
    it("parses valid JSON from the last stdout line (preceding lines ignored)", async () => {
      // Worker emits [info] lines, then a single JSON result line
      const multiLineStdout = [
        "[info] working directory set to /workspace",
        "[info] session started",
        agentResultJson({ summary: "Logging added in 2 files" }),
      ].join("\n");

      const { adapter } = makeAdapterWithInvoker(multiLineStdout);
      const result = await adapter.execute(makeContext());

      expect(result.status).toBe("success");
      expect(result.summary).toBe("Logging added in 2 files");
      expect(result.modifiedFiles).toEqual(["src/index.ts"]);
    });

    it("returns failed with parseError when stdout is not valid JSON", async () => {
      const { adapter } = makeAdapterWithInvoker("not json at all");
      const result = await adapter.execute(makeContext());

      expect(result.status).toBe("failed");
      expect((result.metadata as Record<string, unknown>)["parseError"]).toBe(true);
    });

    it("returns failed with nativePtyLoadFailure flag on mprotect error", async () => {
      const { adapter } = makeAdapterWithInvoker(
        "",
        "cannot apply additional memory protection after relocation: Permission denied"
      );
      const result = await adapter.execute(makeContext());

      expect(result.status).toBe("failed");
      expect((result.metadata as Record<string, unknown>)["nativePtyLoadFailure"]).toBe(true);
    });

    it("returns failed with nativePtyLoadFailure flag on ERR_DLOPEN_FAILED", async () => {
      const { adapter } = makeAdapterWithInvoker(
        "",
        "Error: ERR_DLOPEN_FAILED — unable to load pty.node shared library"
      );
      const result = await adapter.execute(makeContext());

      expect(result.status).toBe("failed");
      expect((result.metadata as Record<string, unknown>)["nativePtyLoadFailure"]).toBe(true);
    });

    it("returns generic crash failure when stdout is empty without pty error", async () => {
      const { adapter } = makeAdapterWithInvoker("", "Killed: out of memory");
      const result = await adapter.execute(makeContext());

      expect(result.status).toBe("failed");
      expect(result.summary).toMatch(/crash/i);
      expect((result.metadata as Record<string, unknown>)["nativePtyLoadFailure"]).toBeUndefined();
    });

    it("returns no_change result correctly", async () => {
      const { adapter } = makeAdapterWithInvoker(
        agentResultJson({ status: "no_change", modifiedFiles: [], gerritChangeId: undefined })
      );
      const result = await adapter.execute(makeContext());

      expect(result.status).toBe("no_change");
      expect(result.modifiedFiles).toHaveLength(0);
    });

    // ── Phase 3: simplified agent-worker output ──────────────────────────────

    it("injects host-generated Change-Id when container omits gerritChangeId (Phase 3 agent-worker)", async () => {
      // Phase 3 agent-worker returns simplified output — no gerritChangeId field.
      // The adapter must inject the host-generated (or reused) changeId.
      const { adapter } = makeAdapterWithInvoker(agentResultJson({ gerritChangeId: undefined }));
      const result = await adapter.execute(
        makeContext({
          agentSession: {
            ...makeContext().agentSession,
            existingChangeId: makeExternalChangeId("Iexisting1234567890abcdef1234567890abcdef01"),
          },
        })
      );

      expect(result.status).toBe("success");
      expect(result.externalChangeId).toBe("Iexisting1234567890abcdef1234567890abcdef01");
    });

    it("generates and injects a fresh Change-Id when container omits gerritChangeId and no existing one", async () => {
      // No existingChangeId — adapter generates a new one on the host.
      const { adapter } = makeAdapterWithInvoker(agentResultJson({ gerritChangeId: undefined }));
      const result = await adapter.execute(makeContext());

      expect(result.status).toBe("success");
      expect(result.externalChangeId).toBeDefined();
      expect(result.externalChangeId).toMatch(/^I[0-9a-f]{40,}/);
    });
  });

  describe("getGitHubOAuthToken", () => {
    it("prefers the token provided in the agent session", async () => {
      const adapter = new CopilotAdapter();
      const context = makeContext({
        agentSession: {
          ...makeContext().agentSession,
          githubToken: "ghp_session_token",
        },
      });

      const token = await (adapter as any).getGitHubOAuthToken(context);

      expect(token).toBe("ghp_session_token");
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("throws when no explicit token is available in the agent session", async () => {
      process.env["GITHUB_TOKEN"] = "ambient-token";
      const adapter = new CopilotAdapter();
      const context = makeContext({
        agentSession: {
          ...makeContext().agentSession,
          githubToken: undefined,
        },
      });

      await expect((adapter as any).getGitHubOAuthToken(context)).rejects.toThrow(
        /No Copilot session token or GitHub token available/
      );
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("throws when neither apiKey nor githubToken is available", async () => {
      delete process.env["GITHUB_TOKEN"];
      const adapter = new CopilotAdapter();
      const context = makeContext({
        agentSession: {
          ...makeContext().agentSession,
          githubToken: undefined,
        },
      });

      await expect((adapter as any).getGitHubOAuthToken(context)).rejects.toThrow(
        /No Copilot session token or GitHub token available/
      );
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("decodes a plain:-prefixed encryptedSessionToken without ADMIN_AUTH_SECRET", async () => {
      const { resetConfig } = await import("../../src/config.js");
      delete process.env["ADMIN_AUTH_SECRET"];
      resetConfig();
      const raw = "ghu_plain_oauth_token";
      const plainEncoded = "plain:" + Buffer.from(raw, "utf8").toString("base64");

      const adapter = new CopilotAdapter();
      const context = makeContext({
        agentSession: {
          ...makeContext().agentSession,
          githubToken: undefined,
          encryptedSessionToken: plainEncoded,
        },
      });

      const token = await (adapter as any).getGitHubOAuthToken(context);

      expect(token).toBe(raw);
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("decrypts an AES-encrypted encryptedSessionToken using ADMIN_AUTH_SECRET", async () => {
      const { resetConfig } = await import("../../src/config.js");
      const { encryptToken } = await import("../../src/utils/encryption.js");
      process.env["ADMIN_AUTH_SECRET"] = "test-secret-32-bytes-min-padding!";
      resetConfig();
      const raw = "ghu_encrypted_oauth_token";
      const encrypted = encryptToken(raw, process.env["ADMIN_AUTH_SECRET"]);

      const adapter = new CopilotAdapter();
      const context = makeContext({
        agentSession: {
          ...makeContext().agentSession,
          githubToken: undefined,
          encryptedSessionToken: encrypted,
        },
      });

      const token = await (adapter as any).getGitHubOAuthToken(context);

      expect(token).toBe(raw);
      delete process.env["ADMIN_AUTH_SECRET"];
      resetConfig();
    });

    it("throws a clear error when an AES-encrypted token is present but ADMIN_AUTH_SECRET is missing", async () => {
      const { resetConfig } = await import("../../src/config.js");
      const { encryptToken } = await import("../../src/utils/encryption.js");
      const encrypted = encryptToken("ghu_secret", "previous-secret-value-32+ chars!!");
      delete process.env["ADMIN_AUTH_SECRET"];
      resetConfig();

      const adapter = new CopilotAdapter();
      const context = makeContext({
        agentSession: {
          ...makeContext().agentSession,
          githubToken: undefined,
          encryptedSessionToken: encrypted,
        },
      });

      await expect((adapter as any).getGitHubOAuthToken(context)).rejects.toThrow(
        /ADMIN_AUTH_SECRET is required/
      );
    });
  });

  describe("parseAgentResult and helpers", () => {
    it("logs successful results even when modifiedFiles is omitted", async () => {
      const { adapter } = makeAdapterWithInvoker(agentResultJson({ modifiedFiles: undefined }));
      const result = await adapter.execute(makeContext());

      expect(result.status).toBe("success");
    });

    it("returns a success result even when stderr contains logs", async () => {
      const { adapter } = makeAdapterWithInvoker(
        agentResultJson({ summary: "ok with stderr" }),
        "debug noise\n"
      );
      const result = await adapter.execute(makeContext());

      expect(result.status).toBe("success");
      expect(result.summary).toBe("ok with stderr");
    });

    it("returns parseError when docker exits non-zero with stdout that is not JSON", async () => {
      const { adapter } = makeAdapterWithInvoker("not-json", "warning");
      const result = await adapter.execute(makeContext());

      expect(result.status).toBe("failed");
      expect((result.metadata as Record<string, unknown>)["parseError"]).toBe(true);
      expect(result.summary).toMatch(/parse/i);
    });

    it("preserves stdout and falls back to the error message when stderr is missing", async () => {
      const { adapter } = makeAdapterWithInvoker("not-json", "");
      const result = await adapter.execute(makeContext());

      expect(result.status).toBe("failed");
      expect(result.agentLogs).toBe("not-json");
      expect(result.summary).toMatch(/parse/i);
    });

    it("invokeAgentContainer requires an injected docker invoker", async () => {
      const adapter = new CopilotAdapter();
      const context = makeContext();

      await expect((adapter as any).invokeAgentContainer(context, "ghp_token")).rejects.toThrow(
        /requires a docker invoker/
      );
    });

    it("parseAgentResult reads the last stdout line when called directly", () => {
      const adapter = new CopilotAdapter();
      const result = (adapter as any).parseAgentResult(
        makeContext(),
        ["log line", agentResultJson({ summary: "direct parse" })].join("\n"),
        ""
      );

      expect(result).toEqual(
        expect.objectContaining({
          status: "success",
          summary: "direct parse",
        })
      );
    });

    it("does not fall back to the environment token when the session token is blank", async () => {
      process.env["GITHUB_TOKEN"] = "  env-token  ";
      const adapter = new CopilotAdapter();
      const context = makeContext({
        agentSession: {
          ...makeContext().agentSession,
          githubToken: undefined,
        },
      });

      await expect((adapter as any).getGitHubOAuthToken(context)).rejects.toThrow(
        /No Copilot session token or GitHub token available/
      );
    });

    it("marks parse failures as native PTY issues when stderr indicates that condition", async () => {
      const { adapter } = makeAdapterWithInvoker(
        "not-json",
        "Failed to load native module: pty.node"
      );
      const result = await adapter.execute(makeContext());

      expect(result.status).toBe("failed");
      expect(result.summary).toMatch(/native modules cannot load/i);
      expect((result.metadata as Record<string, unknown>)["nativePtyLoadFailure"]).toBe(true);
    });

    it("does not include TICKET_URL in the container env (moved to user prompt file)", () => {
      const adapter = new CopilotAdapter();
      const spec = adapter.buildContainerSpec(makeContext({ ticketUrl: undefined }), {
        GITHUB_TOKEN: "ghp_spec_token",
      });

      expect(spec.env).not.toHaveProperty("TICKET_URL");
    });
  });

  describe("AgentLogEvent — types", () => {
    it("AgentLogEvent has the required shape", () => {
      const event: AgentLogEvent = {
        type: "tool.execution_start",
        timestamp: new Date().toISOString(),
        data: { tool: "readFile" },
        taskId: "task-abc",
        cycleNumber: 1,
      };
      expect(event.type).toBe("tool.execution_start");
      expect(typeof event.timestamp).toBe("string");
      expect(event.taskId).toBe("task-abc");
      expect(event.cycleNumber).toBe(1);
    });
  });

  describe("stderr parsing — structured events", () => {
    it("plain stderr lines go to agentLogs, not agentEvents", async () => {
      const stderr = "some plain log line\nanother plain line";
      const { adapter } = makeAdapterWithInvoker(agentResultJson(), stderr);
      const result = await adapter.execute(makeContext());
      expect(result.agentLogs).toContain("some plain log line");
      expect(result.agentLogs).toContain("another plain line");
      expect(result.agentEvents ?? []).toHaveLength(0);
    });

    it("plain stderr lines are emitted live on agentLogBus", async () => {
      const received: unknown[] = [];
      const listener = (e: unknown) => received.push(e);
      agentLogBus.on("event", listener);

      const { adapter } = makeAdapterWithInvoker(agentResultJson(), "some plain log line");
      await adapter.execute(makeContext({ taskId: makeTaskId("plain-log-bus-task") }));

      agentLogBus.off("event", listener);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        type: "stderr.line",
        taskId: "plain-log-bus-task",
        data: { line: "some plain log line" },
      });
    });

    it("__ve_event JSON lines go to agentEvents and not agentLogs", async () => {
      const veEvent = JSON.stringify({
        __ve_event: true,
        type: "tool.execution_start",
        data: { tool: "readFile" },
        ts: "2026-01-01T00:00:00.000Z",
      });
      const { adapter } = makeAdapterWithInvoker(agentResultJson(), veEvent);
      const ctx = makeContext({ cycleNumber: 2 });
      const result = await adapter.execute(ctx);
      expect(result.agentEvents).toHaveLength(1);
      const evt = result.agentEvents![0];
      expect(evt?.type).toBe("tool.execution_start");
      expect(evt?.taskId).toBe(ctx.taskId);
      expect(evt?.cycleNumber).toBe(2);
      expect(result.agentLogs).not.toContain("__ve_event");
    });

    it("returns a failed result with setup events when docker setup throws after stderr", async () => {
      const adapter = new CopilotAdapter();
      const veEvent = JSON.stringify({
        __ve_event: true,
        type: "skills.fetch_failed",
        data: { source: "example-org/agent-skills", message: "network failed" },
        ts: "2026-01-01T00:00:00.000Z",
      });
      adapter.setDockerInvoker(vi.fn().mockImplementation(async (_context, _authEnv, callbacks) => {
        callbacks?.onStderrChunk?.(`${veEvent}\n`);
        throw new Error("failed to fetch skills from example-org/agent-skills: network failed");
      }));

      const result = await adapter.execute(makeContext());

      expect(result.status).toBe("failed");
      expect(result.summary).toBe("Agent setup failed before container output");
      expect(result.agentEvents).toHaveLength(1);
      expect(result.agentEvents?.[0]?.type).toBe("skills.fetch_failed");
      expect(result.metadata).toMatchObject({ adapter: "copilot", setupError: true });
    });

    it("mixed stderr lines are correctly split", async () => {
      const veEvent = JSON.stringify({
        __ve_event: true,
        type: "assistant.message",
        data: { content: "hello" },
        ts: "2026-01-01T00:00:00.000Z",
      });
      const stderr = ["plain line one", veEvent, "plain line two"].join("\n");
      const { adapter } = makeAdapterWithInvoker(agentResultJson(), stderr);
      const result = await adapter.execute(makeContext());
      expect(result.agentLogs).toContain("plain line one");
      expect(result.agentLogs).toContain("plain line two");
      expect(result.agentLogs).not.toContain("__ve_event");
      expect(result.agentEvents).toHaveLength(1);
      expect(result.agentEvents![0]?.type).toBe("assistant.message");
    });

    it("emits events on agentLogBus for matching __ve_event lines", async () => {
      const received: unknown[] = [];
      const listener = (e: unknown) => received.push(e);
      agentLogBus.on("event", listener);

      const veEvent = JSON.stringify({
        __ve_event: true,
        type: "session.usage_info",
        data: { tokens: 100 },
        ts: "2026-01-01T00:00:00.000Z",
      });
      const { adapter } = makeAdapterWithInvoker(agentResultJson(), veEvent);
      await adapter.execute(makeContext({ taskId: makeTaskId("bus-test-task") }));

      agentLogBus.off("event", listener);
      expect(received).toHaveLength(1);
      expect((received[0] as AgentLogEvent).type).toBe("session.usage_info");
      expect((received[0] as AgentLogEvent).taskId).toBe("bus-test-task");
    });
  });

  describe("execute — commits[] handling (Phase 2 multi-commit)", () => {
    it("passes through commits[] when present and skips host commit message processing", async () => {
      const commits = [
        { repoKey: "superproject", sha: "aaa111", subject: "feat(api): add endpoint", body: "", changeId: "", files: ["src/api.ts"] },
        { repoKey: "superproject", sha: "bbb222", subject: "test(api): add endpoint tests", body: "", changeId: "", files: ["tests/api.test.ts"] },
      ];
      const { adapter } = makeAdapterWithInvoker(
        agentResultJson({ commits, commitMessage: undefined })
      );
      const result = await adapter.execute(makeContext());

      expect(result.status).toBe("success");
      expect(result.commits).toHaveLength(2);
      expect(result.commits![0]!.subject).toBe("feat(api): add endpoint");
      expect(result.commits![1]!.subject).toBe("test(api): add endpoint tests");
    });

    it("injects gerritChangeId when commits[] is present but gerritChangeId is missing", async () => {
      const commits = [
        { repoKey: "superproject", sha: "aaa111", subject: "feat: init", body: "", changeId: "", files: ["src/index.ts"] },
      ];
      const { adapter } = makeAdapterWithInvoker(
        agentResultJson({ commits, gerritChangeId: undefined })
      );
      const result = await adapter.execute(makeContext());

      expect(result.status).toBe("success");
      expect(result.externalChangeId).toBeDefined();
      expect(result.externalChangeId).toMatch(/^I[0-9a-f]{40}$/);
    });

    it("falls back to legacy path when commits[] is empty", async () => {
      const { adapter } = makeAdapterWithInvoker(
        agentResultJson({ commits: [] })
      );
      const result = await adapter.execute(
        makeContext({ commitMessage: "feat: fallback" })
      );

      expect(result.status).toBe("success");
      expect(result.commits).toEqual([]);
    });
  });

  describe("buildContainerSpec — GIT_COMMITTER env vars and MAX_COMMITS_PER_CYCLE", () => {
    it("includes GIT_COMMITTER_NAME and GIT_COMMITTER_EMAIL", () => {
      const adapter = new CopilotAdapter();
      const spec = adapter.buildContainerSpec(makeContext(), { GITHUB_TOKEN: "ghp_test" });

      expect(spec.env["GIT_COMMITTER_NAME"]).toBe("Virtual Engineer");
      expect(spec.env["GIT_COMMITTER_EMAIL"]).toBe("virtual-engineer@localhost");
    });

    it("includes MAX_COMMITS_PER_CYCLE from adapter config", () => {
      const adapter = new CopilotAdapter({ maxCommitsPerCycle: 5 });
      const spec = adapter.buildContainerSpec(makeContext(), { GITHUB_TOKEN: "ghp_test" });

      expect(spec.env["MAX_COMMITS_PER_CYCLE"]).toBe("5");
    });

    it("defaults MAX_COMMITS_PER_CYCLE to 10", () => {
      const adapter = new CopilotAdapter();
      const spec = adapter.buildContainerSpec(makeContext(), { GITHUB_TOKEN: "ghp_test" });

      expect(spec.env["MAX_COMMITS_PER_CYCLE"]).toBe("10");
    });

    it("includes REPOSITORY_MAP_JSON when repositoryMap is set", () => {
      const repoMap: RepositoryMap = {
        superproject: { repoKey: "jami-client-qt", localPath: "." },
        submodules: [{ repoKey: "daemon", localPath: "daemon" }],
      };
      const adapter = new CopilotAdapter();
      const ctx = makeContext({
        agentSession: {
          ...makeContext().agentSession,
          repositoryMap: repoMap,
        },
      });
      const spec = adapter.buildContainerSpec(ctx, { GITHUB_TOKEN: "ghp_test" });

      expect(spec.env["REPOSITORY_MAP_JSON"]).toBe(JSON.stringify(repoMap));
    });

    it("omits REPOSITORY_MAP_JSON when repositoryMap is undefined", () => {
      const adapter = new CopilotAdapter();
      const spec = adapter.buildContainerSpec(makeContext(), { GITHUB_TOKEN: "ghp_test" });

      expect(spec.env["REPOSITORY_MAP_JSON"]).toBeUndefined();
    });
  });

  describe("buildCodegenUserPrompt", () => {
    it("includes workspace layout section when repositoryMap has submodules", () => {
      const repoMap: RepositoryMap = {
        superproject: { repoKey: "jami-client-qt", localPath: "." },
        submodules: [{ repoKey: "daemon", localPath: "daemon" }],
      };
      const ctx = makeContext({
        agentSession: { ...makeContext().agentSession, repositoryMap: repoMap },
      });

      const prompt = buildCodegenUserPrompt(ctx, "Do the work.");

      expect(prompt).toContain("### Workspace Layout (multi-repository)");
      expect(prompt).toContain("**jami-client-qt** (root)");
      expect(prompt).toContain("**daemon**");
      expect(prompt).toContain("`/workspace/daemon/`");
      expect(prompt).toContain("cannot reach them");
      expect(prompt).toContain("find /workspace/daemon/");
      expect(prompt).toContain("MUST `git add -A && git commit` **separately in each repository");
      expect(prompt).toContain("cd /workspace/daemon && git add -A && git commit");
      expect(prompt).toContain("Focus on implementation, not exploration");
    });

    it("omits workspace layout section for single-repo projects", () => {
      const prompt = buildCodegenUserPrompt(makeContext(), "Do the work.");

      expect(prompt).not.toContain("Workspace Layout");
    });

    it("omits workspace layout section when repositoryMap has empty submodules", () => {
      const repoMap: RepositoryMap = {
        superproject: { repoKey: "my-project", localPath: "." },
        submodules: [],
      };
      const ctx = makeContext({
        agentSession: { ...makeContext().agentSession, repositoryMap: repoMap },
      });

      const prompt = buildCodegenUserPrompt(ctx, "Do the work.");

      expect(prompt).not.toContain("Workspace Layout");
    });

    it("lists multiple submodules", () => {
      const repoMap: RepositoryMap = {
        superproject: { repoKey: "monorepo", localPath: "." },
        submodules: [
          { repoKey: "core-lib", localPath: "libs/core" },
          { repoKey: "utils", localPath: "libs/utils" },
        ],
      };
      const ctx = makeContext({
        agentSession: { ...makeContext().agentSession, repositoryMap: repoMap },
      });

      const prompt = buildCodegenUserPrompt(ctx, "Do the work.");

      expect(prompt).toContain("**core-lib**");
      expect(prompt).toContain("`/workspace/libs/core/`");
      expect(prompt).toContain("**utils**");
      expect(prompt).toContain("`/workspace/libs/utils/`");
      expect(prompt).toContain("cd /workspace/libs/core && git add -A && git commit");
      expect(prompt).toContain("cd /workspace/libs/utils && git add -A && git commit");
    });
  });
});
