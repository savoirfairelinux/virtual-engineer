import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "crypto";
import { makeTaskId } from "../../src/interfaces.js";
import type { TaskContext, ReviewWorkspaceInput } from "../../src/interfaces.js";
import { ClaudeAdapter } from "../../src/agents/claudeAdapter.js";
import { encryptToken } from "../../src/utils/encryption.js";

function makeContext(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    taskId: makeTaskId(randomUUID()),
    ticketTitle: "Add structured logging",
    ticketDescription: "Add JSON-format logs to the user service",
    acceptanceCriteria: ["Logs must be in JSON format"],
    baseBranch: "main",
    workspacePath: "/workspace",
    volumeName: "ve-ws-test",
    homeVolumeName: "ve-home-test",
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
      githubToken: "sk-ant-key",
    },
    ...overrides,
  };
}

function makeReviewInput(overrides: Partial<ReviewWorkspaceInput> = {}): ReviewWorkspaceInput {
  return {
    changeId: "Iabc" as ReviewWorkspaceInput["changeId"],
    revisionNumber: 1,
    patchset: 1,
    repositoryName: "demo",
    prompt: "diff…",
    systemPrompt: "review sys",
    agentToken: "sk-ant-key",
    ...overrides,
  };
}

function agentResultJson(overrides: object = {}): string {
  return JSON.stringify({
    status: "success",
    modifiedFiles: ["src/index.ts"],
    summary: "done",
    agentLogs: "",
    metadata: { adapter: "claude" },
    ...overrides,
  });
}

describe("ClaudeAdapter", () => {
  describe("buildContainerSpec", () => {
    it("injects claude provider + model and hardened docker args", () => {
      const adapter = new ClaudeAdapter({ model: "sonnet" });
      const spec = adapter.buildContainerSpec(makeContext(), { ANTHROPIC_API_KEY: "sk-ant-key" });

      expect(spec.command).toEqual(["node", "/agent-worker/dist/index.js"]);
      expect(spec.env).toMatchObject({
        AGENT_PROVIDER: "claude",
        CLAUDE_MODEL: "sonnet",
        ANTHROPIC_API_KEY: "sk-ant-key",
        IS_SANDBOX: "1",
        GIT_AUTHOR_NAME: "Virtual Engineer",
      });
      expect(spec.additionalDockerArgs).toContain("--read-only");
      expect(spec.additionalDockerArgs).toContain("ALL");
    });

    it("prefers the per-agent model from the session", () => {
      const adapter = new ClaudeAdapter({ model: "sonnet" });
      const ctx = makeContext();
      ctx.agentSession.copilotModel = "opus";
      const spec = adapter.buildContainerSpec(ctx);
      expect(spec.env["CLAUDE_MODEL"]).toBe("opus");
    });

    it("omits CLAUDE_MODEL when no model is configured (CLI default applies)", () => {
      const adapter = new ClaudeAdapter();
      const spec = adapter.buildContainerSpec(makeContext());
      expect(spec.env["AGENT_PROVIDER"]).toBe("claude");
      expect(spec.env["CLAUDE_MODEL"]).toBeUndefined();
    });
  });

  describe("buildReviewContainerSpec", () => {
    it("sets review mode and prompt file", () => {
      const adapter = new ClaudeAdapter();
      const input: ReviewWorkspaceInput = {
        changeId: "Iabc" as ReviewWorkspaceInput["changeId"],
        revisionNumber: 1,
        patchset: 1,
        repositoryName: "demo",
        prompt: "diff…",
        systemPrompt: "review sys",
        agentToken: "sk-ant-key",
        model: "opus",
      };
      const spec = adapter.buildReviewContainerSpec(input, { ANTHROPIC_API_KEY: "sk-ant-key" });
      expect(spec.env).toMatchObject({
        AGENT_PROVIDER: "claude",
        IS_SANDBOX: "1",
        REVIEW_MODE: "1",
        USER_PROMPT_FILE: "/ve-home/user-prompt.txt",
        SYSTEM_PROMPT: "review sys",
        CLAUDE_MODEL: "opus",
      });
    });

    it("maps an API-key agentToken to ANTHROPIC_API_KEY when no explicit authEnv is given", () => {
      const adapter = new ClaudeAdapter();
      const input = makeReviewInput({ agentToken: "sk-ant-api03-abc" });
      const spec = adapter.buildReviewContainerSpec(input);
      expect(spec.env["ANTHROPIC_API_KEY"]).toBe("sk-ant-api03-abc");
      expect(spec.env["CLAUDE_CODE_OAUTH_TOKEN"]).toBeUndefined();
    });

    it("maps a subscription OAuth agentToken to CLAUDE_CODE_OAUTH_TOKEN", () => {
      const adapter = new ClaudeAdapter();
      const input = makeReviewInput({ agentToken: "sk-ant-oat01-xyz" });
      const spec = adapter.buildReviewContainerSpec(input);
      expect(spec.env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("sk-ant-oat01-xyz");
      expect(spec.env["ANTHROPIC_API_KEY"]).toBeUndefined();
    });

    it("omits CLAUDE_MODEL in review mode when no model is configured", () => {
      const adapter = new ClaudeAdapter();
      const spec = adapter.buildReviewContainerSpec(makeReviewInput({ agentToken: "sk-ant-api-1" }));
      expect(spec.env["CLAUDE_MODEL"]).toBeUndefined();
    });
  });

  describe("execute auth resolution", () => {
    it("uses ANTHROPIC_API_KEY when a plaintext key is present", async () => {
      const adapter = new ClaudeAdapter();
      const invoker = vi.fn().mockImplementation(async (_ctx, authEnv) => {
        expect(authEnv).toMatchObject({ ANTHROPIC_API_KEY: "sk-ant-key" });
        return { stdout: agentResultJson(), stderr: "" };
      });
      adapter.setDockerInvoker(invoker);
      const result = await adapter.execute(makeContext());
      expect(result.status).toBe("success");
      expect(invoker).toHaveBeenCalledOnce();
    });

    it("decrypts a session token into CLAUDE_CODE_OAUTH_TOKEN", async () => {
      const adapter = new ClaudeAdapter();
      const ctx = makeContext();
      delete ctx.agentSession.githubToken;
      ctx.agentSession.encryptedSessionToken = encryptToken("sk-ant-oat-tok", undefined);
      const invoker = vi.fn().mockImplementation(async (_ctx, authEnv) => {
        expect(authEnv).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-tok" });
        return { stdout: agentResultJson(), stderr: "" };
      });
      adapter.setDockerInvoker(invoker);
      const result = await adapter.execute(ctx);
      expect(result.status).toBe("success");
    });

    it("throws when no credentials are available", async () => {
      const adapter = new ClaudeAdapter();
      const ctx = makeContext();
      delete ctx.agentSession.githubToken;
      adapter.setDockerInvoker(vi.fn());
      await expect(adapter.execute(ctx)).rejects.toThrow(/No Claude credentials/);
    });
  });

  describe("execute result parsing", () => {
    it("parses the trailing JSON line from stdout", async () => {
      const { adapter } = withInvoker(`info log\n${agentResultJson({ summary: "parsed" })}`);
      const result = await adapter.execute(makeContext());
      expect(result.summary).toBe("parsed");
      expect(result.status).toBe("success");
    });

    it("returns a failed result when stdout is empty", async () => {
      const { adapter } = withInvoker("");
      const result = await adapter.execute(makeContext());
      expect(result.status).toBe("failed");
      expect(result.metadata).toMatchObject({ adapter: "claude" });
    });
  });
});

function withInvoker(stdout: string): { adapter: ClaudeAdapter } {
  const adapter = new ClaudeAdapter();
  adapter.setDockerInvoker(vi.fn().mockResolvedValue({ stdout, stderr: "" }));
  return { adapter };
}
