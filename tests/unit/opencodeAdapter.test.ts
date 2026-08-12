import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "crypto";
import { makeTaskId } from "../../src/interfaces.js";
import type { TaskContext, ReviewWorkspaceInput } from "../../src/interfaces.js";
import { OpenCodeAdapter } from "../../src/agents/opencodeAdapter.js";

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
      openCodeProvider: "anthropic",
      openCodeApiKey: "sk-ant-key",
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
    openCodeProvider: "anthropic",
    ...overrides,
  };
}

describe("OpenCodeAdapter", () => {
  describe("buildContainerSpec", () => {
    it("injects opencode provider + model + backend auth env", () => {
      const adapter = new OpenCodeAdapter({ model: "claude-sonnet-4-5" });
      const spec = adapter.buildContainerSpec(makeContext());

      expect(spec.command).toEqual(["node", "/app/agent-worker/dist/index.js"]);
      expect(spec.env).toMatchObject({
        AGENT_PROVIDER: "opencode",
        OPENCODE_PROVIDER: "anthropic",
        OPENCODE_MODEL: "claude-sonnet-4-5",
        ANTHROPIC_API_KEY: "sk-ant-key",
        GIT_AUTHOR_NAME: "Virtual Engineer",
      });
    });

    it("prefers the per-agent model from the session", () => {
      const adapter = new OpenCodeAdapter({ model: "claude-sonnet-4-5" });
      const ctx = makeContext();
      ctx.agentSession.copilotModel = "claude-opus-4-6";
      const spec = adapter.buildContainerSpec(ctx);
      expect(spec.env["OPENCODE_MODEL"]).toBe("claude-opus-4-6");
    });

    it("omits OPENCODE_MODEL when no model is configured (CLI default applies)", () => {
      const adapter = new OpenCodeAdapter();
      const spec = adapter.buildContainerSpec(makeContext());
      expect(spec.env["AGENT_PROVIDER"]).toBe("opencode");
      expect(spec.env["OPENCODE_MODEL"]).toBeUndefined();
    });

    it("injects OPENCODE_VARIANT from providerOptions", () => {
      const adapter = new OpenCodeAdapter();
      const ctx = makeContext();
      ctx.agentSession.providerOptions = { variant: "high" };
      expect(adapter.buildContainerSpec(ctx).env).toMatchObject({ OPENCODE_VARIANT: "high" });
    });

    it("maps the ollama provider to OLLAMA_API_BASE and declares no egress hosts", () => {
      const adapter = new OpenCodeAdapter();
      const ctx = makeContext();
      ctx.agentSession.openCodeProvider = "ollama";
      ctx.agentSession.openCodeApiKey = undefined;
      const spec = adapter.buildContainerSpec(ctx);
      expect(spec.env["OLLAMA_API_BASE"]).toBe("http://127.0.0.1:11434");
      expect(spec.egress).toBeUndefined();
    });

    it("declares egress hosts for the selected provider", () => {
      const adapter = new OpenCodeAdapter();
      const spec = adapter.buildContainerSpec(makeContext());
      expect(spec.egress).toEqual({
        hosts: ["api.anthropic.com"],
        binaries: ["/usr/local/bin/opencode"],
      });
    });

    it("declares regional Bedrock egress from the host AWS region", () => {
      process.env["AWS_ACCESS_KEY_ID"] = "aws-access-key";
      process.env["AWS_SECRET_ACCESS_KEY"] = "aws-secret-key";
      process.env["AWS_REGION"] = "ca-central-1";
      try {
        const adapter = new OpenCodeAdapter();
        const ctx = makeContext();
        ctx.agentSession.openCodeProvider = "bedrock";
        ctx.agentSession.openCodeApiKey = undefined;
        const spec = adapter.buildContainerSpec(ctx);

        expect(spec.egress?.hosts).toEqual([
          "bedrock-runtime.ca-central-1.amazonaws.com",
          "sts.ca-central-1.amazonaws.com",
          "sts.amazonaws.com",
        ]);
      } finally {
        delete process.env["AWS_ACCESS_KEY_ID"];
        delete process.env["AWS_SECRET_ACCESS_KEY"];
        delete process.env["AWS_REGION"];
      }
    });
  });

  describe("buildReviewContainerSpec", () => {
    it("sets review mode and prompt", () => {
      const adapter = new OpenCodeAdapter();
      const spec = adapter.buildReviewContainerSpec(makeReviewInput({ model: "claude-sonnet-4-5" }));
      expect(spec.env).toMatchObject({
        AGENT_PROVIDER: "opencode",
        REVIEW_MODE: "1",
        SYSTEM_PROMPT: "review sys",
        OPENCODE_MODEL: "claude-sonnet-4-5",
        ANTHROPIC_API_KEY: "sk-ant-key",
      });
    });

    it("maps a review agentToken to the selected provider's auth env when no explicit authEnv is given", () => {
      const adapter = new OpenCodeAdapter();
      const spec = adapter.buildReviewContainerSpec(
        makeReviewInput({ openCodeProvider: "openai", agentToken: "sk-openai-abc" })
      );
      expect(spec.env["OPENAI_API_KEY"]).toBe("sk-openai-abc");
    });

    it("forwards host AWS temporary credentials for Bedrock review without an agent token", () => {
      process.env["AWS_ACCESS_KEY_ID"] = "aws-access-key";
      process.env["AWS_SECRET_ACCESS_KEY"] = "aws-secret-key";
      process.env["AWS_SESSION_TOKEN"] = "aws-session-token";
      try {
        const adapter = new OpenCodeAdapter();
        const spec = adapter.buildReviewContainerSpec(
          makeReviewInput({ openCodeProvider: "bedrock", agentToken: "" })
        );

        expect(spec.env).toMatchObject({
          AWS_ACCESS_KEY_ID: "aws-access-key",
          AWS_SECRET_ACCESS_KEY: "aws-secret-key",
          AWS_SESSION_TOKEN: "aws-session-token",
        });
      } finally {
        delete process.env["AWS_ACCESS_KEY_ID"];
        delete process.env["AWS_SECRET_ACCESS_KEY"];
        delete process.env["AWS_SESSION_TOKEN"];
      }
    });

    it("omits OPENCODE_MODEL for opencode_native review (CLI-managed)", () => {
      const adapter = new OpenCodeAdapter();
      const spec = adapter.buildReviewContainerSpec(makeReviewInput({
        reviewStrategy: "opencode_native",
        model: "claude-sonnet-4-5",
      }));
      expect(spec.env["OPENCODE_MODEL"]).toBeUndefined();
    });
  });

  describe("execute auth resolution", () => {
    it("uses the configured provider's auth env when an API key is present", async () => {
      const adapter = new OpenCodeAdapter();
      const invoker = vi.fn().mockImplementation(async (_ctx, authEnv) => {
        expect(authEnv).toMatchObject({ ANTHROPIC_API_KEY: "sk-ant-key" });
        return { stdout: JSON.stringify({ status: "success", modifiedFiles: [], summary: "done", agentLogs: "" }), stderr: "" };
      });
      adapter.setDockerInvoker(invoker);
      await adapter.execute(makeContext());
      expect(invoker).toHaveBeenCalled();
    });

    it("throws when no credentials are configured for a key-requiring provider", async () => {
      const adapter = new OpenCodeAdapter();
      const ctx = makeContext();
      ctx.agentSession.openCodeApiKey = undefined;
      await expect(adapter.execute(ctx)).rejects.toThrow("No OpenCode credentials available");
    });

    it("does not require a key for ollama", async () => {
      const adapter = new OpenCodeAdapter();
      const ctx = makeContext();
      ctx.agentSession.openCodeProvider = "ollama";
      ctx.agentSession.openCodeApiKey = undefined;
      const invoker = vi.fn().mockResolvedValue({
        stdout: JSON.stringify({ status: "success", modifiedFiles: [], summary: "done", agentLogs: "" }),
        stderr: "",
      });
      adapter.setDockerInvoker(invoker);
      await expect(adapter.execute(ctx)).resolves.toBeDefined();
    });

    it("rejects profile-only Bedrock auth because profile files are not uploaded", async () => {
      process.env["AWS_PROFILE"] = "developer";
      delete process.env["AWS_ACCESS_KEY_ID"];
      delete process.env["AWS_SECRET_ACCESS_KEY"];
      delete process.env["AWS_BEARER_TOKEN_BEDROCK"];
      try {
        const adapter = new OpenCodeAdapter();
        const ctx = makeContext();
        ctx.agentSession.openCodeProvider = "bedrock";
        ctx.agentSession.openCodeApiKey = undefined;

        await expect(adapter.execute(ctx)).rejects.toThrow(/environment credentials.*AWS_PROFILE.*not uploaded/i);
      } finally {
        delete process.env["AWS_PROFILE"];
      }
    });
  });
});
