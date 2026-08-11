import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "crypto";
import { makeTaskId } from "../../src/interfaces.js";
import type { TaskContext, ReviewWorkspaceInput } from "../../src/interfaces.js";
import { CodexAdapter } from "../../src/agents/codexAdapter.js";

function makeContext(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    taskId: makeTaskId(randomUUID()),
    ticketTitle: "Add structured logging",
    ticketDescription: "Add JSON-format logs to the user service",
    acceptanceCriteria: ["Logs must be in JSON format"],
    baseBranch: "main",
    workspacePath: "/workspace",
    constraints: [],
    priorFeedback: [],
    cycleNumber: 1,
    commitMessage: "Add structured logging",
    ticketUrl: "http://localhost:3000/issues/1",
    agentSession: {
      agentContainerImage: "virtual-engineer-workspace:latest",
      repoCloneUrl: "ssh://localhost:29418/demo",
      pushRef: "refs/for/main",
      gitAuthorName: "Virtual Engineer",
      gitAuthorEmail: "virtual-engineer@localhost",
      githubToken: "sk-openai-key",
    },
    ...overrides,
  };
}

function makeReviewInput(overrides: Partial<ReviewWorkspaceInput> = {}): ReviewWorkspaceInput {
  return {
    reviewStrategy: "ve_direct",
    changeId: "Iabc" as ReviewWorkspaceInput["changeId"],
    revisionNumber: 1,
    patchset: 1,
    repositoryName: "demo",
    prompt: "diff…",
    systemPrompt: "review sys",
    agentToken: "sk-openai-key",
    ...overrides,
  };
}

describe("CodexAdapter", () => {
  describe("buildContainerSpec", () => {
    it("injects codex provider + model", () => {
      const adapter = new CodexAdapter({ model: "gpt-5.5" });
      const spec = adapter.buildContainerSpec(makeContext(), { CODEX_API_KEY: "sk-openai-key" });

      expect(spec.command).toEqual(["node", "/app/agent-worker/dist/index.js"]);
      expect(spec.env).toMatchObject({
        AGENT_PROVIDER: "codex",
        CODEX_MODEL: "gpt-5.5",
        CODEX_API_KEY: "sk-openai-key",
        GIT_AUTHOR_NAME: "Virtual Engineer",
      });
    });

    it("prefers the per-agent model from the session", () => {
      const adapter = new CodexAdapter({ model: "gpt-5.5" });
      const ctx = makeContext();
      ctx.agentSession.copilotModel = "gpt-5.1-codex-max";
      const spec = adapter.buildContainerSpec(ctx);
      expect(spec.env["CODEX_MODEL"]).toBe("gpt-5.1-codex-max");
    });

    it("omits CODEX_MODEL when no model is configured (CLI default applies)", () => {
      const adapter = new CodexAdapter();
      const spec = adapter.buildContainerSpec(makeContext());
      expect(spec.env["AGENT_PROVIDER"]).toBe("codex");
      expect(spec.env["CODEX_MODEL"]).toBeUndefined();
    });

    it("injects CODEX_REASONING_EFFORT from providerOptions", () => {
      const adapter = new CodexAdapter();
      const ctx = makeContext();
      ctx.agentSession.providerOptions = { reasoningEffort: "high" };
      expect(adapter.buildContainerSpec(ctx).env).toMatchObject({ CODEX_REASONING_EFFORT: "high" });
    });

    it("declares the codex egress hosts and binaries", () => {
      const adapter = new CodexAdapter();
      const spec = adapter.buildContainerSpec(makeContext());
      expect(spec.egress).toEqual({
        hosts: ["api.openai.com", "chatgpt.com"],
        binaries: ["/usr/local/bin/node", "/usr/local/bin/codex"],
      });
    });
  });

  describe("buildReviewContainerSpec", () => {
    it("sets review mode and prompt", () => {
      const adapter = new CodexAdapter();
      const spec = adapter.buildReviewContainerSpec(
        makeReviewInput({ model: "gpt-5.5" }),
        { CODEX_API_KEY: "sk-openai-key" }
      );
      expect(spec.env).toMatchObject({
        AGENT_PROVIDER: "codex",
        REVIEW_MODE: "1",
        SYSTEM_PROMPT: "review sys",
        CODEX_MODEL: "gpt-5.5",
      });
    });

    it("maps an API-key agentToken to CODEX_API_KEY when no explicit authEnv is given", () => {
      const adapter = new CodexAdapter();
      const spec = adapter.buildReviewContainerSpec(makeReviewInput({ agentToken: "sk-openai-abc" }));
      expect(spec.env["CODEX_API_KEY"]).toBe("sk-openai-abc");
      expect(spec.env["CODEX_ACCESS_TOKEN"]).toBeUndefined();
    });

    it("maps a non-sk- agentToken to CODEX_ACCESS_TOKEN", () => {
      const adapter = new CodexAdapter();
      const spec = adapter.buildReviewContainerSpec(makeReviewInput({ agentToken: "codex-access-xyz" }));
      expect(spec.env["CODEX_ACCESS_TOKEN"]).toBe("codex-access-xyz");
      expect(spec.env["CODEX_API_KEY"]).toBeUndefined();
    });

    it("omits CODEX_MODEL and reasoning effort for codex_native review (CLI-managed)", () => {
      const adapter = new CodexAdapter();
      const spec = adapter.buildReviewContainerSpec(makeReviewInput({
        reviewStrategy: "codex_native",
        model: "gpt-5.5",
        providerOptions: { reasoningEffort: "high" },
      }));
      expect(spec.env["CODEX_MODEL"]).toBeUndefined();
      expect(spec.env["CODEX_REASONING_EFFORT"]).toBeUndefined();
    });
  });

  describe("execute auth resolution", () => {
    it("uses CODEX_API_KEY when a plaintext key is present", async () => {
      const adapter = new CodexAdapter();
      const invoker = vi.fn().mockImplementation(async (_ctx, authEnv) => {
        expect(authEnv).toMatchObject({ CODEX_API_KEY: "sk-openai-key" });
        return { stdout: JSON.stringify({ status: "success", modifiedFiles: [], summary: "done", agentLogs: "" }), stderr: "" };
      });
      adapter.setDockerInvoker(invoker);
      await adapter.execute(makeContext());
      expect(invoker).toHaveBeenCalled();
    });

    it("throws when no credentials are configured", async () => {
      const adapter = new CodexAdapter();
      const ctx = makeContext();
      ctx.agentSession.githubToken = undefined;
      await expect(adapter.execute(ctx)).rejects.toThrow("No Codex credentials available");
    });
  });
});
