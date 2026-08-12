import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "crypto";
import { makeTaskId } from "../../src/interfaces.js";
import type { TaskContext, ReviewWorkspaceInput } from "../../src/interfaces.js";
import { CursorAdapter } from "../../src/agents/cursorAdapter.js";

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
      githubToken: "cursor-api-key",
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
    agentToken: "cursor-api-key",
    ...overrides,
  };
}

describe("CursorAdapter", () => {
  describe("buildContainerSpec", () => {
    it("injects cursor provider + model", () => {
      const adapter = new CursorAdapter({ model: "gpt-5" });
      const spec = adapter.buildContainerSpec(makeContext(), { CURSOR_API_KEY: "cursor-api-key" });

      expect(spec.command).toEqual(["node", "/app/agent-worker/dist/index.js"]);
      expect(spec.env).toMatchObject({
        AGENT_PROVIDER: "cursor",
        CURSOR_MODEL: "gpt-5",
        CURSOR_API_KEY: "cursor-api-key",
        GIT_AUTHOR_NAME: "Virtual Engineer",
      });
    });

    it("prefers the per-agent model from the session", () => {
      const adapter = new CursorAdapter({ model: "gpt-5" });
      const ctx = makeContext();
      ctx.agentSession.copilotModel = "claude-sonnet-5";
      const spec = adapter.buildContainerSpec(ctx);
      expect(spec.env["CURSOR_MODEL"]).toBe("claude-sonnet-5");
    });

    it("omits CURSOR_MODEL when no model is configured (CLI default applies)", () => {
      const adapter = new CursorAdapter();
      const spec = adapter.buildContainerSpec(makeContext());
      expect(spec.env["AGENT_PROVIDER"]).toBe("cursor");
      expect(spec.env["CURSOR_MODEL"]).toBeUndefined();
    });

    it("declares the cursor egress hosts and binaries", () => {
      const adapter = new CursorAdapter();
      const spec = adapter.buildContainerSpec(makeContext());
      expect(spec.egress).toEqual({
        hosts: ["api2.cursor.sh", "api5.cursor.sh", "agent.api5.cursor.sh", "agentn.api5.cursor.sh", "repo42.cursor.sh"],
        binaries: ["/usr/local/bin/node", "/usr/local/bin/cursor-agent"],
      });
    });
  });

  describe("buildReviewContainerSpec", () => {
    it("sets review mode and prompt", () => {
      const adapter = new CursorAdapter();
      const spec = adapter.buildReviewContainerSpec(
        makeReviewInput({ model: "gpt-5" }),
        { CURSOR_API_KEY: "cursor-api-key" }
      );
      expect(spec.env).toMatchObject({
        AGENT_PROVIDER: "cursor",
        REVIEW_MODE: "1",
        SYSTEM_PROMPT: "review sys",
        CURSOR_MODEL: "gpt-5",
      });
    });

    it("maps the agentToken to CURSOR_API_KEY when no explicit authEnv is given", () => {
      const adapter = new CursorAdapter();
      const spec = adapter.buildReviewContainerSpec(makeReviewInput({ agentToken: "cursor-review-token" }));
      expect(spec.env["CURSOR_API_KEY"]).toBe("cursor-review-token");
    });

    it("prefers an explicit authEnv over the agentToken", () => {
      const adapter = new CursorAdapter();
      const spec = adapter.buildReviewContainerSpec(
        makeReviewInput({ agentToken: "ignored-token" }),
        { CURSOR_API_KEY: "explicit-key" }
      );
      expect(spec.env["CURSOR_API_KEY"]).toBe("explicit-key");
    });
  });

  describe("execute auth resolution", () => {
    it("uses CURSOR_API_KEY when a plaintext key is present", async () => {
      const adapter = new CursorAdapter();
      const invoker = vi.fn().mockImplementation(async (_ctx, authEnv) => {
        expect(authEnv).toMatchObject({ CURSOR_API_KEY: "cursor-api-key" });
        return { stdout: JSON.stringify({ status: "success", modifiedFiles: [], summary: "done", agentLogs: "" }), stderr: "" };
      });
      adapter.setDockerInvoker(invoker);
      await adapter.execute(makeContext());
      expect(invoker).toHaveBeenCalled();
    });

    it("throws when no credentials are configured", async () => {
      const adapter = new CursorAdapter();
      const ctx = makeContext();
      ctx.agentSession.githubToken = undefined;
      await expect(adapter.execute(ctx)).rejects.toThrow("No Cursor credentials available");
    });
  });
});
