import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "crypto";
import { makeTaskId } from "../../src/interfaces.js";
import type { TaskContext, ReviewWorkspaceInput } from "../../src/interfaces.js";
import { AiderAdapter } from "../../src/agents/aiderAdapter.js";

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
      aiderBackend: "openai",
      aiderApiKey: "sk-key",
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
    agentToken: "sk-key",
    ...overrides,
  };
}

function agentResultJson(overrides: object = {}): string {
  return JSON.stringify({
    status: "success",
    modifiedFiles: ["src/index.ts"],
    summary: "done",
    agentLogs: "",
    metadata: { adapter: "aider" },
    ...overrides,
  });
}

describe("AiderAdapter", () => {
  describe("buildContainerSpec", () => {
    it("injects aider provider + model and hardened docker args", () => {
      const adapter = new AiderAdapter({ model: "gpt-4o" });
      const spec = adapter.buildContainerSpec(makeContext());

      expect(spec.command).toEqual(["node", "/agent-worker/dist/index.js"]);
      expect(spec.networkMode).toBe("virtual-engineer_ve-agent-net");
      expect(spec.env).toMatchObject({
        AGENT_PROVIDER: "aider",
        AIDER_MODEL: "gpt-4o",
        OPENAI_API_KEY: "sk-key",
        GIT_AUTHOR_NAME: "Virtual Engineer",
      });
      expect(spec.additionalDockerArgs).toContain("--read-only");
      expect(spec.additionalDockerArgs).toContain("ALL");
    });

    it("prefers the per-agent model from the session", () => {
      const adapter = new AiderAdapter({ model: "gpt-4o" });
      const ctx = makeContext();
      ctx.agentSession.copilotModel = "sonnet";
      const spec = adapter.buildContainerSpec(ctx);
      expect(spec.env["AIDER_MODEL"]).toBe("sonnet");
    });

    it("omits AIDER_MODEL when no model is configured (Aider default applies)", () => {
      const adapter = new AiderAdapter();
      const spec = adapter.buildContainerSpec(makeContext());
      expect(spec.env["AGENT_PROVIDER"]).toBe("aider");
      expect(spec.env["AIDER_MODEL"]).toBeUndefined();
    });

    it("maps anthropic backend to ANTHROPIC_API_KEY", () => {
      const adapter = new AiderAdapter();
      const ctx = makeContext();
      ctx.agentSession.aiderBackend = "anthropic";
      ctx.agentSession.aiderApiKey = "sk-ant-key";
      const spec = adapter.buildContainerSpec(ctx);
      expect(spec.env["ANTHROPIC_API_KEY"]).toBe("sk-ant-key");
      expect(spec.env["OPENAI_API_KEY"]).toBeUndefined();
    });

    it("maps ollama backend to OLLAMA_API_BASE", () => {
      const adapter = new AiderAdapter();
      const ctx = makeContext();
      ctx.agentSession.aiderBackend = "ollama";
      ctx.agentSession.aiderApiBase = "http://host.docker.internal:11434";
      delete ctx.agentSession.aiderApiKey;
      const spec = adapter.buildContainerSpec(ctx);
      expect(spec.env["OLLAMA_API_BASE"]).toBe("http://host.docker.internal:11434");
      expect(spec.env["OPENAI_API_KEY"]).toBeUndefined();
    });

    it("maps openrouter backend to OPENROUTER_API_KEY", () => {
      const adapter = new AiderAdapter();
      const ctx = makeContext();
      ctx.agentSession.aiderBackend = "openrouter";
      ctx.agentSession.aiderApiKey = "or-key";
      const spec = adapter.buildContainerSpec(ctx);
      expect(spec.env["OPENROUTER_API_KEY"]).toBe("or-key");
    });

    it("maps deepseek backend to DEEPSEEK_API_KEY", () => {
      const adapter = new AiderAdapter();
      const ctx = makeContext();
      ctx.agentSession.aiderBackend = "deepseek";
      ctx.agentSession.aiderApiKey = "ds-key";
      const spec = adapter.buildContainerSpec(ctx);
      expect(spec.env["DEEPSEEK_API_KEY"]).toBe("ds-key");
    });

    it("maps openai_compat backend to OPENAI_API_KEY + OPENAI_API_BASE", () => {
      const adapter = new AiderAdapter();
      const ctx = makeContext();
      ctx.agentSession.aiderBackend = "openai_compat";
      ctx.agentSession.aiderApiKey = "key";
      ctx.agentSession.aiderApiBase = "https://custom.example.com";
      const spec = adapter.buildContainerSpec(ctx);
      expect(spec.env["OPENAI_API_KEY"]).toBe("key");
      expect(spec.env["OPENAI_API_BASE"]).toBe("https://custom.example.com");
    });

    it("throws when openai_compat backend is missing an API base URL", () => {
      const adapter = new AiderAdapter();
      const ctx = makeContext();
      ctx.agentSession.aiderBackend = "openai_compat";
      ctx.agentSession.aiderApiKey = "key";
      ctx.agentSession.aiderApiBase = "";
      expect(() => adapter.buildContainerSpec(ctx)).toThrow(/requires an API base URL/);
    });

    it("injects LOCAL_SKILLS_PATH only when skill discovery is enabled", () => {
      const adapter = new AiderAdapter();
      const ctx = makeContext();
      ctx.agentSession.localSkillsPath = "team/skills";
      expect(adapter.buildContainerSpec(ctx).env["LOCAL_SKILLS_PATH"]).toBeUndefined();

      ctx.agentSession.skillDiscoveryEnabled = true;
      const spec = adapter.buildContainerSpec(ctx);
      expect(spec.env["SKILL_DISCOVERY"]).toBe("1");
      expect(spec.env["LOCAL_SKILLS_PATH"]).toBe("team/skills");
    });

    it("injects Aider native execution options", () => {
      const adapter = new AiderAdapter();
      const ctx = makeContext();
      ctx.agentSession.providerOptions = {
        chatMode: "architect",
        reasoningEffort: "high",
        thinkingTokens: 16000,
        mapTokens: 4096,
        autoLint: true,
        autoTest: true,
      };

      expect(adapter.buildContainerSpec(ctx).env).toMatchObject({
        AIDER_CHAT_MODE: "architect",
        AIDER_REASONING_EFFORT: "high",
        AIDER_THINKING_TOKENS: "16000",
        AIDER_MAP_TOKENS: "4096",
        AIDER_AUTO_LINT: "1",
        AIDER_AUTO_TEST: "1",
      });
    });

    it("throws when no backend credentials are available", () => {
      const adapter = new AiderAdapter();
      const ctx = makeContext();
      delete ctx.agentSession.aiderBackend;
      delete ctx.agentSession.aiderApiKey;
      expect(() => adapter.buildContainerSpec(ctx)).toThrow(/No Aider credentials/);
    });
  });

  describe("buildReviewContainerSpec", () => {
    it("sets review mode and prompt file", () => {
      const adapter = new AiderAdapter();
      const input: ReviewWorkspaceInput = {
        changeId: "Iabc" as ReviewWorkspaceInput["changeId"],
        revisionNumber: 1,
        patchset: 1,
        repositoryName: "demo",
        prompt: "diff…",
        systemPrompt: "review sys",
        agentToken: "sk-key",
        model: "gpt-4o",
        aiderBackend: "openai",
      };
      const spec = adapter.buildReviewContainerSpec(input);
      expect(spec.env).toMatchObject({
        AGENT_PROVIDER: "aider",
        REVIEW_MODE: "1",
        USER_PROMPT_FILE: "/ve-home/user-prompt.txt",
        SYSTEM_PROMPT: "review sys",
        AIDER_MODEL: "gpt-4o",
        OPENAI_API_KEY: "sk-key",
      });
    });

    it("maps the review agentToken per the backend selector", () => {
      const adapter = new AiderAdapter();
      const spec = adapter.buildReviewContainerSpec(
        makeReviewInput({ agentToken: "sk-ant-key", aiderBackend: "anthropic" })
      );
      expect(spec.env["ANTHROPIC_API_KEY"]).toBe("sk-ant-key");
      expect(spec.env["OPENAI_API_KEY"]).toBeUndefined();
    });

    it("omits AIDER_MODEL in review mode when no model is configured", () => {
      const adapter = new AiderAdapter();
      const spec = adapter.buildReviewContainerSpec(
        makeReviewInput({ agentToken: "sk-key", aiderBackend: "openai" })
      );
      expect(spec.env["AIDER_MODEL"]).toBeUndefined();
    });

    it("injects LOCAL_SKILLS_PATH in review specs only when skill discovery is enabled", () => {
      const adapter = new AiderAdapter();
      expect(
        adapter.buildReviewContainerSpec(
          makeReviewInput({ agentToken: "sk-key", aiderBackend: "openai", localSkillsPath: "team/skills" })
        ).env["LOCAL_SKILLS_PATH"]
      ).toBeUndefined();

      const spec = adapter.buildReviewContainerSpec(
        makeReviewInput({ agentToken: "sk-key", aiderBackend: "openai", skillDiscoveryEnabled: true, localSkillsPath: "team/skills" })
      );
      expect(spec.env["SKILL_DISCOVERY"]).toBe("1");
      expect(spec.env["LOCAL_SKILLS_PATH"]).toBe("team/skills");
    });
  });

  describe("execute auth resolution", () => {
    it("resolves OpenAI auth env from the session and runs the container", async () => {
      const adapter = new AiderAdapter();
      const invoker = vi.fn().mockImplementation(async (_ctx, authEnv) => {
        expect(authEnv).toMatchObject({ OPENAI_API_KEY: "sk-key" });
        return { stdout: agentResultJson(), stderr: "" };
      });
      adapter.setDockerInvoker(invoker);
      const result = await adapter.execute(makeContext());
      expect(result.status).toBe("success");
      expect(invoker).toHaveBeenCalledOnce();
    });

    it("throws when no credentials are available", async () => {
      const adapter = new AiderAdapter();
      const ctx = makeContext();
      delete ctx.agentSession.aiderBackend;
      delete ctx.agentSession.aiderApiKey;
      adapter.setDockerInvoker(vi.fn());
      await expect(adapter.execute(ctx)).rejects.toThrow(/No Aider credentials/);
    });
  });
});