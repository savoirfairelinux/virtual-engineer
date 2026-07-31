import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "crypto";
import { makeTaskId } from "../../src/interfaces.js";
import type { TaskContext, ReviewWorkspaceInput } from "../../src/interfaces.js";
import { GooseAdapter } from "../../src/agents/gooseAdapter.js";

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
      gooseProvider: "anthropic",
      gooseApiKey: "sk-ant-key",
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
    metadata: { adapter: "goose" },
    ...overrides,
  });
}

describe("GooseAdapter", () => {
  describe("buildContainerSpec", () => {
    it("injects goose provider + model and hardened docker args", () => {
      const adapter = new GooseAdapter({ model: "claude-sonnet-4-5" });
      const spec = adapter.buildContainerSpec(makeContext());

      expect(spec.command).toEqual(["node", "/agent-worker/dist/index.js"]);
      expect(spec.networkMode).toBe("virtual-engineer_ve-agent-net");
      expect(spec.env).toMatchObject({
        AGENT_PROVIDER: "goose",
        GOOSE_MODEL: "claude-sonnet-4-5",
        ANTHROPIC_API_KEY: "sk-ant-key",
        GIT_AUTHOR_NAME: "Virtual Engineer",
      });
      expect(spec.additionalDockerArgs).toContain("--read-only");
      expect(spec.additionalDockerArgs).toContain("ALL");
    });

    it("prefers the per-agent model from the session", () => {
      const adapter = new GooseAdapter({ model: "claude-sonnet-4-5" });
      const ctx = makeContext();
      ctx.agentSession.copilotModel = "gpt-4o";
      const spec = adapter.buildContainerSpec(ctx);
      expect(spec.env["GOOSE_MODEL"]).toBe("gpt-4o");
    });

    it("omits GOOSE_MODEL when no model is configured (Goose default applies)", () => {
      const adapter = new GooseAdapter();
      const spec = adapter.buildContainerSpec(makeContext());
      expect(spec.env["AGENT_PROVIDER"]).toBe("goose");
      expect(spec.env["GOOSE_MODEL"]).toBeUndefined();
    });

    it("maps anthropic provider to ANTHROPIC_API_KEY", () => {
      const adapter = new GooseAdapter();
      const ctx = makeContext();
      ctx.agentSession.gooseProvider = "anthropic";
      ctx.agentSession.gooseApiKey = "sk-ant-key";
      const spec = adapter.buildContainerSpec(ctx);
      expect(spec.env["ANTHROPIC_API_KEY"]).toBe("sk-ant-key");
      expect(spec.env["OPENAI_API_KEY"]).toBeUndefined();
    });

    it("maps openai provider to OPENAI_API_KEY", () => {
      const adapter = new GooseAdapter();
      const ctx = makeContext();
      ctx.agentSession.gooseProvider = "openai";
      ctx.agentSession.gooseApiKey = "sk-key";
      const spec = adapter.buildContainerSpec(ctx);
      expect(spec.env["OPENAI_API_KEY"]).toBe("sk-key");
    });

    it("maps ollama provider to OLLAMA_HOST", () => {
      const adapter = new GooseAdapter();
      const ctx = makeContext();
      ctx.agentSession.gooseProvider = "ollama";
      ctx.agentSession.gooseApiBase = "http://host.docker.internal:11434";
      delete ctx.agentSession.gooseApiKey;
      const spec = adapter.buildContainerSpec(ctx);
      expect(spec.env["OLLAMA_HOST"]).toBe("http://host.docker.internal:11434");
      expect(spec.env["OPENAI_API_KEY"]).toBeUndefined();
    });

    it("maps openrouter provider to OPENROUTER_API_KEY", () => {
      const adapter = new GooseAdapter();
      const ctx = makeContext();
      ctx.agentSession.gooseProvider = "openrouter";
      ctx.agentSession.gooseApiKey = "or-key";
      const spec = adapter.buildContainerSpec(ctx);
      expect(spec.env["OPENROUTER_API_KEY"]).toBe("or-key");
    });

    it("maps groq provider to GROQ_API_KEY", () => {
      const adapter = new GooseAdapter();
      const ctx = makeContext();
      ctx.agentSession.gooseProvider = "groq";
      ctx.agentSession.gooseApiKey = "groq-key";
      const spec = adapter.buildContainerSpec(ctx);
      expect(spec.env["GROQ_API_KEY"]).toBe("groq-key");
    });

    it("maps gemini provider to GOOGLE_API_KEY", () => {
      const adapter = new GooseAdapter();
      const ctx = makeContext();
      ctx.agentSession.gooseProvider = "gemini";
      ctx.agentSession.gooseApiKey = "google-key";
      const spec = adapter.buildContainerSpec(ctx);
      expect(spec.env["GOOGLE_API_KEY"]).toBe("google-key");
    });

    it("maps bedrock provider to no key (AWS env chain)", () => {
      const adapter = new GooseAdapter();
      const ctx = makeContext();
      ctx.agentSession.gooseProvider = "bedrock";
      delete ctx.agentSession.gooseApiKey;
      const spec = adapter.buildContainerSpec(ctx);
      expect(spec.env["ANTHROPIC_API_KEY"]).toBeUndefined();
      expect(spec.env["OPENAI_API_KEY"]).toBeUndefined();
    });

    it("maps openai_compat provider to OPENAI_API_KEY + OPENAI_API_BASE", () => {
      const adapter = new GooseAdapter();
      const ctx = makeContext();
      ctx.agentSession.gooseProvider = "openai_compat";
      ctx.agentSession.gooseApiKey = "key";
      ctx.agentSession.gooseApiBase = "https://custom.example.com";
      const spec = adapter.buildContainerSpec(ctx);
      expect(spec.env["OPENAI_API_KEY"]).toBe("key");
      expect(spec.env["OPENAI_API_BASE"]).toBe("https://custom.example.com");
    });

    it("throws when openai_compat provider is missing an API base URL", () => {
      const adapter = new GooseAdapter();
      const ctx = makeContext();
      ctx.agentSession.gooseProvider = "openai_compat";
      ctx.agentSession.gooseApiKey = "key";
      ctx.agentSession.gooseApiBase = "";
      expect(() => adapter.buildContainerSpec(ctx)).toThrow(/requires an API base URL/);
    });

    it("injects Goose native execution options", () => {
      const adapter = new GooseAdapter();
      const ctx = makeContext();
      ctx.agentSession.providerOptions = {
        gooseMode: "smart_approve",
        gooseMaxTurns: 50,
        gooseMaxTokens: 8192,
        gooseTemperature: 0.7,
        gooseAutoCompactThreshold: 0.8,
      };

      expect(adapter.buildContainerSpec(ctx).env).toMatchObject({
        GOOSE_MODE: "smart_approve",
        GOOSE_MAX_TURNS: "50",
        GOOSE_MAX_TOKENS: "8192",
        GOOSE_TEMPERATURE: "0.7",
        GOOSE_AUTO_COMPACT_THRESHOLD: "0.8",
      });
    });

    it("throws when no provider credentials are available", () => {
      const adapter = new GooseAdapter();
      const ctx = makeContext();
      delete ctx.agentSession.gooseProvider;
      delete ctx.agentSession.gooseApiKey;
      expect(() => adapter.buildContainerSpec(ctx)).toThrow(/No Goose credentials/);
    });
  });

  describe("buildReviewContainerSpec", () => {
    it("sets review mode and prompt file", () => {
      const adapter = new GooseAdapter();
      const input: ReviewWorkspaceInput = {
        reviewStrategy: "ve_direct",
        changeId: "Iabc" as ReviewWorkspaceInput["changeId"],
        revisionNumber: 1,
        patchset: 1,
        repositoryName: "demo",
        prompt: "diff…",
        systemPrompt: "review sys",
        agentToken: "sk-ant-key",
        model: "claude-sonnet-4-5",
        gooseProvider: "anthropic",
      };
      const spec = adapter.buildReviewContainerSpec(input);
      expect(spec.env).toMatchObject({
        AGENT_PROVIDER: "goose",
        REVIEW_MODE: "1",
        USER_PROMPT_FILE: "/ve-home/user-prompt.txt",
        SYSTEM_PROMPT: "review sys",
        GOOSE_MODEL: "claude-sonnet-4-5",
        ANTHROPIC_API_KEY: "sk-ant-key",
      });
    });

    it("omits GOOSE_MODEL for goose_native review strategy (CLI-managed)", () => {
      const adapter = new GooseAdapter();
      const spec = adapter.buildReviewContainerSpec(
        makeReviewInput({ reviewStrategy: "goose_native", model: "claude-sonnet-4-5", gooseProvider: "anthropic" })
      );
      expect(spec.env["GOOSE_MODEL"]).toBeUndefined();
      expect(spec.env["AGENT_PROVIDER"]).toBe("goose");
    });

    it("maps the review agentToken per the provider selector", () => {
      const adapter = new GooseAdapter();
      const spec = adapter.buildReviewContainerSpec(
        makeReviewInput({ agentToken: "sk-key", gooseProvider: "openai" })
      );
      expect(spec.env["OPENAI_API_KEY"]).toBe("sk-key");
      expect(spec.env["ANTHROPIC_API_KEY"]).toBeUndefined();
    });

    it("omits GOOSE_MODEL in review mode when no model is configured", () => {
      const adapter = new GooseAdapter();
      const spec = adapter.buildReviewContainerSpec(
        makeReviewInput({ agentToken: "sk-ant-key", gooseProvider: "anthropic" })
      );
      expect(spec.env["GOOSE_MODEL"]).toBeUndefined();
    });
  });

  describe("execute auth resolution", () => {
    it("resolves Anthropic auth env from the session and runs the container", async () => {
      const adapter = new GooseAdapter();
      const invoker = vi.fn().mockImplementation(async (_ctx, authEnv) => {
        expect(authEnv).toMatchObject({ ANTHROPIC_API_KEY: "sk-ant-key" });
        return { stdout: agentResultJson(), stderr: "" };
      });
      adapter.setDockerInvoker(invoker);
      const result = await adapter.execute(makeContext());
      expect(result.status).toBe("success");
      expect(invoker).toHaveBeenCalledOnce();
    });

    it("throws when no credentials are available", async () => {
      const adapter = new GooseAdapter();
      const ctx = makeContext();
      delete ctx.agentSession.gooseProvider;
      delete ctx.agentSession.gooseApiKey;
      adapter.setDockerInvoker(vi.fn());
      await expect(adapter.execute(ctx)).rejects.toThrow(/No Goose credentials/);
    });
  });
});