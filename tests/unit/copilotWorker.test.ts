import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "child_process";

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  listModels: vi.fn(),
  clientStart: vi.fn(),
  clientGetAuthStatus: vi.fn(),
  clientStop: vi.fn(),
  createConnection: vi.fn(),
  emitEvent: vi.fn(),
  spawn: vi.fn(),
  statSync: vi.fn(),
}));

vi.mock("../../agent-worker/node_modules/@github/copilot-sdk/dist/index.js", () => ({
  CopilotClient: vi.fn(function CopilotClient() {
    return {
      createSession: mocks.createSession,
      listModels: mocks.listModels,
      start: mocks.clientStart,
      getAuthStatus: mocks.clientGetAuthStatus,
      stop: mocks.clientStop,
    };
  }),
}));

vi.mock("child_process", () => ({
  spawn: (...args: unknown[]) => mocks.spawn(...args),
}));

vi.mock("net", () => ({
  createConnection: (...args: unknown[]) => mocks.createConnection(...args),
}));

vi.mock("fs", () => ({
  statSync: (...args: unknown[]) => mocks.statSync(...args),
}));

vi.mock("../../agent-worker/src/providers/events.js", () => ({
  emitEvent: (...args: unknown[]) => mocks.emitEvent(...args),
}));

vi.mock("../../agent-worker/src/skills.js", () => ({
  copilotGlobalSkillsDir: () => "/home/ve/.copilot/skills",
}));

import {
  buildCopilotSessionConfig,
  buildCopilotSystemMessage,
  buildNativeReviewPrompt,
  runCopilotAgent,
} from "../../agent-worker/src/providers/copilot.js";
import type { AgentRunOptions } from "../../agent-worker/src/providers/types.js";

interface FakeSession {
  disconnect: ReturnType<typeof vi.fn>;
  handlers: Map<string, (event: unknown) => void>;
  on: ReturnType<typeof vi.fn>;
  sendAndWait: ReturnType<typeof vi.fn>;
}

function makeFakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stdout = new PassThrough() as unknown as ChildProcess["stdout"];
  child.stderr = new PassThrough() as unknown as ChildProcess["stderr"];
  child.kill = vi.fn();
  return child;
}

function makeFakeSession(): FakeSession {
  const handlers = new Map<string, (event: unknown) => void>();
  return {
    disconnect: vi.fn().mockResolvedValue(undefined),
    handlers,
    on: vi.fn((name: string, handler: (event: unknown) => void) => {
      handlers.set(name, handler);
    }),
    sendAndWait: vi.fn().mockResolvedValue({ data: { content: "Implemented safely" } }),
  };
}

function makeOptions(overrides: Partial<AgentRunOptions> = {}): AgentRunOptions {
  return {
    model: "gpt-4.1",
    agentInstructions: "Follow the repository instructions",
    cwd: "/workspace",
    timeoutMs: 1_000,
    mode: "codegen",
    ...overrides,
  };
}

describe("runCopilotAgent", () => {
  let child: ChildProcess;
  let session: FakeSession;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSession.mockReset();
    child = makeFakeChild();
    session = makeFakeSession();
    mocks.spawn.mockReturnValue(child);
    mocks.createSession.mockResolvedValue(session);
    mocks.listModels.mockResolvedValue([{ id: "gpt-4.1", supportedReasoningEfforts: ["low", "high"] }]);
    mocks.clientStart.mockResolvedValue(undefined);
    mocks.clientGetAuthStatus.mockResolvedValue({ isAuthenticated: true });
    mocks.clientStop.mockResolvedValue(undefined);
    mocks.statSync.mockReturnValue({ isDirectory: () => true });
    mocks.createConnection.mockImplementation(() => {
      const socket = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
      socket.destroy = vi.fn();
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    });
    process.env["GITHUB_TOKEN"] = "secret-copilot-token";
    process.env["UNRELATED_SECRET"] = "must-not-leak";
    delete process.env["COPILOT_REASONING_EFFORT"];
  });

  it("runs a headless CLI session, maps events, and cleans up", async () => {
    let resolveResponse: ((value: { data: { content: string } }) => void) | undefined;
    session.sendAndWait.mockImplementation(() => new Promise((resolve) => {
      resolveResponse = resolve;
    }));
    process.env["COPILOT_REASONING_EFFORT"] = "high";
    const runPromise = runCopilotAgent("Implement the task", makeOptions());
    await vi.waitFor(() => expect(session.on).toHaveBeenCalled());

    session.handlers.get("tool.execution_start")?.({
      data: {
        toolCallId: "edit-1",
        toolName: "edit",
        arguments: { path: "src/index.ts" },
      },
    });
    session.handlers.get("tool.execution_complete")?.({
      data: {
        toolCallId: "edit-1",
        success: true,
        result: { content: "updated" },
      },
    });
    session.handlers.get("assistant.message")?.({ message: { content: "Working" } });
    session.handlers.get("assistant.usage")?.({
      usage: {
        input_tokens: 12,
        output_tokens: 8,
        cache_read_tokens: 3,
        total_nano_aiu: 42,
        api_call_id: "call-1",
      },
    });
    session.handlers.get("permission.requested")?.({
      data: {
        requestId: "permission-1",
        permissionRequest: {
          kind: "mcp",
          toolCallId: "submit-1",
          serverName: "virtual-engineer-submission",
          toolName: "ve_submit_review",
          args: { privateReviewPayload: "must-not-be-logged" },
        },
      },
    });
    resolveResponse?.({ data: { content: "Implemented safely" } });

    const run = await runPromise;
    expect(run).toMatchObject({
      content: "Implemented safely",
      toolCallCount: 1,
      toolsByKind: { edit: 1 },
      toolCalls: [{
        callId: "edit-1",
        name: "edit",
        input: { path: "src/index.ts" },
        success: true,
      }],
    });
    expect(mocks.spawn).toHaveBeenCalledWith(
      "/app/agent-worker/node_modules/.bin/copilot",
      [
        "--headless",
        "--no-auto-update",
        "--port",
        "3000",
        "--auth-token-env",
        "GITHUB_TOKEN",
        "--no-auto-login",
      ],
      expect.objectContaining({ cwd: "/workspace" })
    );
    const spawnOptions = mocks.spawn.mock.calls[0]?.[2] as { env: Record<string, string> };
    expect(spawnOptions.env["GITHUB_TOKEN"]).toBe("secret-copilot-token");
    expect(spawnOptions.env["UNRELATED_SECRET"]).toBeUndefined();
    expect(mocks.createSession).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-4.1",
      reasoningEffort: "high",
      enableConfigDiscovery: true,
      systemMessage: {
        mode: "append",
        content: expect.stringMatching(
          /Follow the repository instructions[\s\S]*ve_submit_changes/
        ),
      },
      workingDirectory: "/workspace",
    }));
    expect(mocks.createSession.mock.calls[0]?.[0]).not.toHaveProperty("skillDirectories");
    expect(mocks.emitEvent).toHaveBeenCalledWith("tool.execution_start", expect.objectContaining({
      name: "edit",
      input: { path: "src/index.ts" },
    }));
    expect(mocks.emitEvent).toHaveBeenCalledWith("assistant.usage", expect.objectContaining({
      inputTokens: 9,
      outputTokens: 8,
      cacheReadTokens: 3,
      totalNanoAiu: 42,
      apiCallId: "call-1",
    }));
    expect(mocks.emitEvent).toHaveBeenCalledWith("permission.requested", {
      kind: "mcp",
      toolCallId: "submit-1",
      serverName: "virtual-engineer-submission",
      toolName: "ve_submit_review",
    });
    expect(session.disconnect).toHaveBeenCalledOnce();

    await run.cleanup();
    expect(mocks.clientStop).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(JSON.stringify(mocks.emitEvent.mock.calls)).not.toContain("secret-copilot-token");
    expect(JSON.stringify(mocks.emitEvent.mock.calls)).not.toContain("must-not-be-logged");
  });

  it("uses review mode without optional reasoning or injected skill directories", async () => {
    process.env["COPILOT_REASONING_EFFORT"] = "none";
    const run = await runCopilotAgent("Review the patch", makeOptions({
      mode: "review",
    }));

    expect(session.sendAndWait).toHaveBeenCalledWith({ prompt: "Review the patch" }, expect.any(Number));
    expect(session.sendAndWait.mock.calls[0]?.[1]).toBeLessThanOrEqual(1_000);
    const sessionOptions = mocks.createSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sessionOptions["reasoningEffort"]).toBeUndefined();
    expect(mocks.listModels).toHaveBeenCalledOnce();
    expect(sessionOptions["skillDirectories"]).toBeUndefined();
    expect(sessionOptions["enableConfigDiscovery"]).toBe(true);
    expect(mocks.emitEvent).toHaveBeenCalledWith("session.start", expect.objectContaining({
      mode: "review",
    }));
    await run.cleanup();
  });

  it.each(["codegen", "review"] as const)("defaults unsupported reasoning for %s sessions", async (mode) => {
    process.env["COPILOT_REASONING_EFFORT"] = "high";
    mocks.listModels.mockResolvedValue([
      { id: "savoirfairelinux/DeepInfra/deepseek-ai%2FDeepSeek-V4.1-Flash" },
      { id: "other", supportedReasoningEfforts: ["high"] },
    ]);

    const run = await runCopilotAgent("Run the task", makeOptions({
      mode,
      model: "savoirfairelinux/DeepInfra/deepseek-ai%2FDeepSeek-V4.1-Flash",
    }));

    expect(mocks.listModels).toHaveBeenCalledOnce();
    expect(mocks.createSession.mock.calls[0]?.[0]).not.toHaveProperty("reasoningEffort");
    await run.cleanup();
  });

  it.each([
    { models: [] },
    { models: [{ id: "gpt-4.1", supportedReasoningEfforts: [] }] },
    { models: [{ id: "gpt-4.1", supportedReasoningEfforts: ["low"] }] },
  ])("defaults reasoning when the requested level is not advertised: $models", async ({ models }) => {
    process.env["COPILOT_REASONING_EFFORT"] = "high";
    mocks.listModels.mockResolvedValue(models);

    const run = await runCopilotAgent("Run the task", makeOptions());

    expect(mocks.createSession.mock.calls[0]?.[0]).not.toHaveProperty("reasoningEffort");
    await run.cleanup();
  });

  it("uses provider defaults if model capability discovery fails", async () => {
    process.env["COPILOT_REASONING_EFFORT"] = "high";
    mocks.listModels.mockRejectedValue(new Error("Models unavailable"));

    const run = await runCopilotAgent("Run the task", makeOptions());

    expect(mocks.createSession.mock.calls[0]?.[0]).not.toHaveProperty("reasoningEffort");
    expect(mocks.emitEvent).toHaveBeenCalledWith("session.warning", expect.objectContaining({
      message: expect.stringContaining("provider default"),
    }));
    await run.cleanup();
  });

  it("tears down the session and CLI when the SDK request fails", async () => {
    session.sendAndWait.mockRejectedValue(new Error("SDK request failed"));

    await expect(runCopilotAgent("Implement", makeOptions())).rejects.toThrow("SDK request failed");

    expect(session.disconnect).toHaveBeenCalledOnce();
    expect(mocks.clientStop).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it.each(["codegen", "review"] as const)("falls back to auto when the %s model disappears", async (mode) => {
    mocks.listModels.mockResolvedValue([{ id: "another-model" }]);
    process.env["COPILOT_REASONING_EFFORT"] = "high";

    const run = await runCopilotAgent("Run", makeOptions({ mode }));

    expect(mocks.createSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ model: "auto" }));
    expect(mocks.createSession.mock.calls[0]?.[0]).not.toHaveProperty("reasoningEffort");
    expect(run.model).toBe("auto");
    expect(mocks.emitEvent).toHaveBeenCalledWith("session.model_fallback", expect.objectContaining({
      requestedModel: "gpt-4.1", selectedModel: "auto", reason: "not_listed",
    }));
    await run.cleanup();
  });

  it("keeps the explicit model when discovery fails", async () => {
    mocks.listModels.mockRejectedValue(new Error("Network unavailable"));
    const run = await runCopilotAgent("Run", makeOptions());
    expect(mocks.createSession).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-4.1" }));
    expect(mocks.emitEvent).not.toHaveBeenCalledWith("session.model_fallback", expect.anything());
    expect(mocks.emitEvent).toHaveBeenCalledWith("session.warning", expect.objectContaining({
      message: expect.stringContaining("discover"),
    }));
    await run.cleanup();
  });

  it("falls back when policy disables a model that remains listed", async () => {
    mocks.listModels.mockResolvedValue([{ id: "gpt-4.1", policy: { state: "disabled" } }]);
    const run = await runCopilotAgent("Run", makeOptions());
    expect(mocks.createSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ model: "auto" }));
    expect(mocks.emitEvent).toHaveBeenCalledWith("session.model_fallback", expect.objectContaining({
      reason: "disabled",
    }));
    await run.cleanup();
  });

  it("does not discover or retry auto", async () => {
    session.sendAndWait.mockRejectedValue(new Error("Model is not available"));
    await expect(runCopilotAgent("Run", makeOptions({ model: "auto" }))).rejects.toThrow("Model is not available");
    expect(mocks.listModels).not.toHaveBeenCalled();
    expect(mocks.createSession).toHaveBeenCalledOnce();
  });

  it.each([
    "Model 'gpt-4.1' is not available",
    "Model gpt-4.1 is unavailable",
    "The requested model is no longer supported",
    "Unknown model: gpt-4.1",
  ])("falls back once when session creation rejects a listed model: %s", async (message) => {
    mocks.createSession.mockRejectedValueOnce(new Error(message));
    const run = await runCopilotAgent("Run", makeOptions());
    expect(mocks.createSession.mock.calls.map(([config]) => config.model)).toEqual(["gpt-4.1", "auto"]);
    expect(run.model).toBe("auto");
    await run.cleanup();
  });

  it("retries a model rejection before tools using a fresh session", async () => {
    const fallbackSession = makeFakeSession();
    session.sendAndWait.mockImplementation(() => {
      session.handlers.get("session.error")?.({
        data: { errorType: "query", message: "Model 'gpt-4.1' is disabled" },
      });
      return Promise.reject(new Error("Model 'gpt-4.1' is disabled"));
    });
    mocks.createSession.mockResolvedValueOnce(session).mockResolvedValueOnce(fallbackSession);
    const run = await runCopilotAgent("Run", makeOptions());
    expect(session.disconnect).toHaveBeenCalledOnce();
    expect(fallbackSession.sendAndWait).toHaveBeenCalledOnce();
    expect(mocks.emitEvent.mock.calls.filter(([type]) => type === "session.model_fallback")).toHaveLength(1);
    expect(run.model).toBe("auto");
    await run.cleanup();
  });

  it("does not replay a session after any tool execution", async () => {
    session.sendAndWait.mockImplementation(() => {
      session.handlers.get("tool.execution_start")?.({ data: { toolName: "edit", toolCallId: "1" } });
      return Promise.reject(new Error("Model 'gpt-4.1' is not available"));
    });
    await expect(runCopilotAgent("Run", makeOptions())).rejects.toThrow("not available");
    expect(mocks.createSession).toHaveBeenCalledOnce();
  });

  it.each(["codegen", "review"] as const)("continues the %s fallback when disconnect fails", async (mode) => {
    const fallbackSession = makeFakeSession();
    session.sendAndWait.mockRejectedValue(new Error("Model 'gpt-4.1' is not available"));
    session.disconnect.mockRejectedValueOnce(new Error("Disconnect failed"));
    mocks.createSession.mockResolvedValueOnce(session).mockResolvedValueOnce(fallbackSession);

    const run = await runCopilotAgent("Run", makeOptions({ mode }));

    expect(run.model).toBe("auto");
    expect(mocks.createSession.mock.calls.map(([config]) => config.model)).toEqual(["gpt-4.1", "auto"]);
    expect(session.disconnect).toHaveBeenCalledOnce();
    expect(fallbackSession.sendAndWait).toHaveBeenCalledOnce();
    expect(mocks.emitEvent).toHaveBeenCalledWith("session.warning", {
      message: "Could not disconnect the rejected Copilot session; continuing with automatic model selection.",
    });
    await run.cleanup();
    expect(fallbackSession.disconnect).toHaveBeenCalledOnce();
    expect(mocks.clientStop).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("preserves a fallback error instead of a prior disconnect failure", async () => {
    const fallbackSession = makeFakeSession();
    session.sendAndWait.mockRejectedValue(new Error("Model 'gpt-4.1' is not available"));
    session.disconnect.mockRejectedValueOnce(new Error("Disconnect failed"));
    fallbackSession.sendAndWait.mockRejectedValue(new Error("Quota exhausted"));
    mocks.createSession.mockResolvedValueOnce(session).mockResolvedValueOnce(fallbackSession);

    await expect(runCopilotAgent("Run", makeOptions())).rejects.toThrow("Quota exhausted");

    expect(mocks.createSession).toHaveBeenCalledTimes(2);
    expect(fallbackSession.disconnect).toHaveBeenCalledOnce();
    expect(mocks.clientStop).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it.each([
    "HTTP 403", "HTTP 404", "Quota exceeded", "Authentication failed",
    "Connection unavailable", "context_length_exceeded", "Model service unavailable",
  ])("does not fallback for unrelated errors: %s", async (message) => {
    session.sendAndWait.mockRejectedValue(new Error(message));
    await expect(runCopilotAgent("Run", makeOptions())).rejects.toThrow(message);
    expect(mocks.createSession).toHaveBeenCalledOnce();
  });

  it("preserves the auto failure without another retry", async () => {
    mocks.listModels.mockResolvedValue([]);
    session.sendAndWait.mockRejectedValue(new Error("Quota exceeded"));
    await expect(runCopilotAgent("Run", makeOptions())).rejects.toThrow("Quota exceeded");
    expect(mocks.createSession).toHaveBeenCalledOnce();
    expect(mocks.clientStop).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("cleans up when creation of the fallback session fails", async () => {
    mocks.createSession
      .mockRejectedValueOnce(new Error("Model 'gpt-4.1' is not available"))
      .mockRejectedValueOnce(new Error("Copilot unavailable"));
    await expect(runCopilotAgent("Run", makeOptions())).rejects.toThrow("Copilot unavailable");
    expect(mocks.createSession).toHaveBeenCalledTimes(2);
    expect(mocks.clientStop).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("preserves quota errors identified by session.error", async () => {
    session.sendAndWait.mockImplementation(() => {
      session.handlers.get("session.error")?.({
        data: { errorType: "quota", message: "Model 'gpt-4.1' is not available" },
      });
      return Promise.reject(new Error("Quota exhausted"));
    });
    await expect(runCopilotAgent("Run", makeOptions())).rejects.toThrow("Quota exhausted");
    expect(mocks.createSession).toHaveBeenCalledOnce();
  });

  it("shares the remaining timeout with the fallback attempt", async () => {
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const fallbackSession = makeFakeSession();
      session.sendAndWait.mockImplementation(() => {
        now = 700;
        return Promise.reject(new Error("Model 'gpt-4.1' is not available"));
      });
      mocks.createSession.mockResolvedValueOnce(session).mockResolvedValueOnce(fallbackSession);
      const run = await runCopilotAgent("Run", makeOptions());
      expect(session.sendAndWait).toHaveBeenCalledWith({ prompt: "Run" }, 1_000);
      expect(fallbackSession.sendAndWait).toHaveBeenCalledWith({ prompt: "Run" }, 300);
      await run.cleanup();
    } finally {
      clock.mockRestore();
    }
  });

  it("leaves native review model selection to Copilot", async () => {
    const run = await runCopilotAgent("Review", makeOptions({
      model: "auto", mode: "review", reviewStrategy: "copilot_native",
    }));
    expect(mocks.listModels).not.toHaveBeenCalled();
    expect(mocks.emitEvent).not.toHaveBeenCalledWith("session.model_fallback", expect.anything());
    await run.cleanup();
  });

  it("retains the error from a failed MCP tool execution", async () => {
    let resolveResponse: ((value: { data: { content: string } }) => void) | undefined;
    session.sendAndWait.mockImplementation(() => new Promise((resolve) => {
      resolveResponse = resolve;
    }));
    const runPromise = runCopilotAgent("Review the patch", makeOptions({ mode: "review" }));
    await vi.waitFor(() => expect(session.on).toHaveBeenCalled());

    session.handlers.get("tool.execution_start")?.({
      data: {
        toolCallId: "submit-1",
        toolName: "ve-submission-ve_submit_review",
        arguments: { comments: [] },
      },
    });
    session.handlers.get("tool.execution_complete")?.({
      data: {
        toolCallId: "submit-1",
        success: false,
        error: { message: "MCP submission does not match its JSON Schema" },
      },
    });
    resolveResponse?.({ data: { content: "Review complete" } });

    const run = await runPromise;
    expect(run.toolCalls).toEqual([{
      callId: "submit-1",
      name: "ve-submission-ve_submit_review",
      input: { comments: [] },
      success: false,
      error: "MCP submission does not match its JSON Schema",
    }]);
    expect(mocks.emitEvent).toHaveBeenCalledWith("tool.execution_complete", expect.objectContaining({
      name: "ve-submission-ve_submit_review",
      status: "failed",
      error: "MCP submission does not match its JSON Schema",
    }));
  });

  it("stops the client and CLI when session creation fails", async () => {
    mocks.createSession.mockRejectedValue(new Error("Cannot create session"));

    await expect(runCopilotAgent("Implement", makeOptions())).rejects.toThrow(
      "Cannot create session"
    );

    expect(mocks.clientStop).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});

describe("Copilot worker native profile", () => {
  it("builds a parent prompt that delegates the VE prompt exactly once", () => {
    const prompt = buildNativeReviewPrompt("VE REVIEW CONTEXT\nDIFF CONTENT", "/sandbox/task-1-abc");

    expect(prompt).toBe([
      "Delegate exactly one review with the task tool:",
      '- name: "ve-native-code-review"',
      '- description: "Review the VE-provided patch"',
      '- agent_type: "code-review"',
      '- mode: "sync"',
      "- prompt: the content between VE_DELEGATED_PROMPT_START and VE_DELEGATED_PROMPT_END",
      "Use the delegated findings as the sole review analysis.",
      "",
      "VE_DELEGATED_PROMPT_START",
      "Review the Virtual Engineer context and supplied diff below as the source of truth.",
      "For extra context, only read files under /sandbox/task-1-abc; do not execute commands, access the network, or edit files.",
      "Do not recompute the diff or compare branches.",
      "Return findings to the parent; do not call submission tools.",
      "",
      "VE REVIEW CONTEXT",
      "DIFF CONTENT",
      "VE_DELEGATED_PROMPT_END",
      "",
      "Submit the final structured result through ve_submit_review before ending. Exactly one submission must be accepted; correct and retry rejected attempts.",
    ].join("\n"));
  });

  it("keeps native review submission guidance out of the delegated system message", () => {
    const config = buildCopilotSessionConfig({
      model: "gpt-5.1-codex",
      agentInstructions: "read-only review policy",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "review",
      reviewStrategy: "copilot_native",
      reviewOutputSchema: {
        type: "object",
        properties: { vote: { type: "integer", enum: [-1, 0, 1] } },
        required: ["vote"],
        additionalProperties: false,
      },
    });

    expect(config.systemMessage).toEqual({
      mode: "append",
      content: "read-only review policy",
    });
  });

  it("appends agent instructions to the Copilot CLI foundation explicitly", () => {
    expect(buildCopilotSystemMessage("permanent agent policy")).toEqual({
      mode: "append",
      content: "permanent agent policy",
    });
  });

  it("configures VE review submission alongside native repository discovery", () => {
    const outputSchema = {
      type: "object",
      properties: { vote: { type: "integer", enum: [-1, 0, 1] } },
      required: ["vote"],
      additionalProperties: false,
    };

    const config = buildCopilotSessionConfig({
      model: "gpt-5.1-codex",
      agentInstructions: "review policy",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "review",
      reviewOutputSchema: outputSchema,
    });

    expect(config.enableConfigDiscovery).toBe(true);
    expect(config.systemMessage).toEqual(expect.objectContaining({
      content: expect.stringContaining("ve_submit_review"),
    }));
    expect(config.mcpServers).toEqual({
      "ve-submission": expect.objectContaining({
        type: "stdio",
        tools: ["ve_submit_review"],
      }),
    });
  });

  it("requires the coding completion tool alongside native repository discovery", () => {
    const config = buildCopilotSessionConfig({
      model: "gpt-5.1-codex",
      agentInstructions: "coding policy",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    });

    expect(config.enableConfigDiscovery).toBe(true);
    expect(config.systemMessage).toEqual(expect.objectContaining({
      content: expect.stringContaining("ve_submit_changes"),
    }));
    expect(config.mcpServers).toEqual({
      "ve-submission": expect.objectContaining({
        tools: ["ve_submit_changes"],
      }),
    });
  });

  it("uses the read-only permission policy only for review sessions", async () => {
    const common = {
      model: "gpt-5.1-codex",
      agentInstructions: "policy",
      cwd: "/workspace",
      timeoutMs: 1000,
    };
    const reviewConfig = buildCopilotSessionConfig({
      ...common,
      mode: "review",
      reviewOutputSchema: {
        type: "object",
        properties: { vote: { type: "integer", enum: [-1, 0, 1] } },
        required: ["vote"],
        additionalProperties: false,
      },
    });
    const codeConfig = buildCopilotSessionConfig({ ...common, mode: "codegen" });

    // The handlers are now wrapped with the per-agent tool-authorization
    // layer, so verify behaviour rather than identity: codegen rejects network
    // commands but approves normal work; review rejects writes.
    const invocation = { sessionId: "test" };
    const codeResult = await codeConfig.onPermissionRequest(
      { kind: "shell", fullCommandText: "curl https://example.com" } as never,
      invocation,
    );
    expect(codeResult).toEqual(expect.objectContaining({ kind: "reject" }));

    const reviewResult = await reviewConfig.onPermissionRequest(
      { kind: "write", fileName: "x.ts" } as never,
      invocation,
    );
    expect(reviewResult).toEqual(expect.objectContaining({ kind: "reject" }));
  });
});