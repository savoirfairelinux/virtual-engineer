import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "crypto";
import { makeTaskId } from "../../src/interfaces.js";
import type { TaskContext, ReviewWorkspaceInput } from "../../src/interfaces.js";
import { GeminiAdapter } from "../../src/agents/geminiAdapter.js";

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
      githubToken: "gemini-api-key",
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
    agentToken: "gemini-api-key",
    ...overrides,
  };
}

describe("GeminiAdapter", () => {
  describe("buildContainerSpec", () => {
    it("injects gemini provider + model", () => {
      const adapter = new GeminiAdapter({ model: "gemini-2.5-pro" });
      const spec = adapter.buildContainerSpec(makeContext(), { GEMINI_API_KEY: "gemini-api-key" });

      expect(spec.command).toEqual(["node", "/app/agent-worker/dist/index.js"]);
      expect(spec.env).toMatchObject({
        AGENT_PROVIDER: "gemini",
        GEMINI_MODEL: "gemini-2.5-pro",
        GEMINI_API_KEY: "gemini-api-key",
        GIT_AUTHOR_NAME: "Virtual Engineer",
      });
    });

    it("prefers the per-agent model from the session", () => {
      const adapter = new GeminiAdapter({ model: "gemini-2.5-pro" });
      const ctx = makeContext();
      ctx.agentSession.copilotModel = "gemini-3-pro-preview";
      const spec = adapter.buildContainerSpec(ctx);
      expect(spec.env["GEMINI_MODEL"]).toBe("gemini-3-pro-preview");
    });

    it("omits GEMINI_MODEL when no model is configured (CLI default applies)", () => {
      const adapter = new GeminiAdapter();
      const spec = adapter.buildContainerSpec(makeContext());
      expect(spec.env["AGENT_PROVIDER"]).toBe("gemini");
      expect(spec.env["GEMINI_MODEL"]).toBeUndefined();
    });

    it("declares the gemini egress hosts and binaries", () => {
      const adapter = new GeminiAdapter();
      const spec = adapter.buildContainerSpec(makeContext());
      expect(spec.egress).toEqual({
        hosts: ["generativelanguage.googleapis.com", "aiplatform.googleapis.com", "oauth2.googleapis.com"],
        binaries: ["/usr/local/bin/node", "/usr/local/bin/gemini"],
      });
    });
  });

  describe("execute auth resolution", () => {
    it("uses GEMINI_API_KEY for api_key mode", async () => {
      const adapter = new GeminiAdapter();
      const invoker = vi.fn().mockImplementation(async (_ctx, authEnv) => {
        expect(authEnv).toMatchObject({ GEMINI_API_KEY: "gemini-api-key" });
        return { stdout: JSON.stringify({ status: "success", modifiedFiles: [], summary: "done", agentLogs: "" }), stderr: "" };
      });
      adapter.setDockerInvoker(invoker);
      await adapter.execute(makeContext());
      expect(invoker).toHaveBeenCalled();
    });

    it("maps vertex_ai mode to GOOGLE_API_KEY + GOOGLE_GENAI_USE_VERTEXAI plus project/location", async () => {
      const adapter = new GeminiAdapter();
      const ctx = makeContext();
      ctx.agentSession.geminiAuthMode = "vertex_ai";
      ctx.agentSession.geminiGoogleCloudProject = "my-project";
      ctx.agentSession.geminiGoogleCloudLocation = "us-central1";
      const invoker = vi.fn().mockImplementation(async (_ctx, authEnv) => {
        expect(authEnv).toMatchObject({
          GOOGLE_API_KEY: "gemini-api-key",
          GOOGLE_GENAI_USE_VERTEXAI: "true",
          GOOGLE_CLOUD_PROJECT: "my-project",
          GOOGLE_CLOUD_LOCATION: "us-central1",
        });
        expect(authEnv["GEMINI_API_KEY"]).toBeUndefined();
        return { stdout: JSON.stringify({ status: "success", modifiedFiles: [], summary: "done", agentLogs: "" }), stderr: "" };
      });
      adapter.setDockerInvoker(invoker);
      await adapter.execute(ctx);
      expect(invoker).toHaveBeenCalled();
    });

    it("throws when no credentials are configured", async () => {
      const adapter = new GeminiAdapter();
      const ctx = makeContext();
      ctx.agentSession.githubToken = undefined;
      await expect(adapter.execute(ctx)).rejects.toThrow("No Gemini credentials available");
    });
  });

  describe("buildReviewContainerSpec", () => {
    it("sets review mode and prompt", () => {
      const adapter = new GeminiAdapter();
      const spec = adapter.buildReviewContainerSpec(
        makeReviewInput({ model: "gemini-2.5-pro" }),
        { GEMINI_API_KEY: "gemini-api-key" }
      );
      expect(spec.env).toMatchObject({
        AGENT_PROVIDER: "gemini",
        REVIEW_MODE: "1",
        SYSTEM_PROMPT: "review sys",
        GEMINI_MODEL: "gemini-2.5-pro",
      });
    });

    it("maps the agentToken to GEMINI_API_KEY when no explicit authEnv is given", () => {
      const adapter = new GeminiAdapter();
      const spec = adapter.buildReviewContainerSpec(makeReviewInput({ agentToken: "gemini-abc" }));
      expect(spec.env["GEMINI_API_KEY"]).toBe("gemini-abc");
    });
  });
});
