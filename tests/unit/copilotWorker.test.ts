import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "child_process";

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  clientStop: vi.fn(),
  createConnection: vi.fn(),
  emitEvent: vi.fn(),
  emitLocalSkillsLoaded: vi.fn(),
  spawn: vi.fn(),
  statSync: vi.fn(),
}));

vi.mock("../../agent-worker/node_modules/@github/copilot-sdk/dist/index.js", () => ({
  CopilotClient: vi.fn(function CopilotClient() {
    return {
      createSession: mocks.createSession,
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
  emitLocalSkillsLoaded: (...args: unknown[]) => mocks.emitLocalSkillsLoaded(...args),
  localSkillsDir: (cwd: string) => `${cwd}/.github/skills`,
}));

import {
  buildCopilotSessionConfig,
  buildCopilotSystemMessage,
  buildNativeReviewPrompt,
  runCopilotAgent,
} from "../../agent-worker/src/providers/copilot.js";
import type { AgentRunOptions } from "../../agent-worker/src/providers/types.js";
import {
  restrictNetworkPermissionHandler,
  restrictReviewPermissionHandler,
} from "../../agent-worker/src/networkGuard.js";

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
    child = makeFakeChild();
    session = makeFakeSession();
    mocks.spawn.mockReturnValue(child);
    mocks.createSession.mockResolvedValue(session);
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
    const runPromise = runCopilotAgent("Implement the task", makeOptions({
      skillDiscovery: true,
    }));
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
      "/agent-worker/node_modules/.bin/copilot",
      ["--headless", "--port", "3000"],
      expect.objectContaining({ cwd: "/workspace" })
    );
    const spawnOptions = mocks.spawn.mock.calls[0]?.[2] as { env: Record<string, string> };
    expect(spawnOptions.env["GITHUB_TOKEN"]).toBe("secret-copilot-token");
    expect(spawnOptions.env["UNRELATED_SECRET"]).toBeUndefined();
    expect(mocks.createSession).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-4.1",
      reasoningEffort: "high",
      skillDirectories: ["/workspace/.github/skills", "/home/ve/.copilot/skills"],
      systemMessage: {
        mode: "append",
        content: expect.stringMatching(
          /Follow the repository instructions[\s\S]*ve_submit_changes/
        ),
      },
      workingDirectory: "/workspace",
    }));
    expect(mocks.emitLocalSkillsLoaded).toHaveBeenCalledWith("/workspace");
    expect(mocks.emitEvent).toHaveBeenCalledWith("tool.execution_start", expect.objectContaining({
      name: "edit",
      input: { path: "src/index.ts" },
    }));
    expect(mocks.emitEvent).toHaveBeenCalledWith("assistant.usage", expect.objectContaining({
      inputTokens: 12,
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

  it("uses review mode without optional reasoning or local skills", async () => {
    process.env["COPILOT_REASONING_EFFORT"] = "none";
    const run = await runCopilotAgent("Review the patch", makeOptions({
      mode: "review",
      skillDiscovery: false,
    }));

    expect(session.sendAndWait).toHaveBeenCalledWith({ prompt: "Review the patch" }, 1_000);
    const sessionOptions = mocks.createSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sessionOptions["reasoningEffort"]).toBeUndefined();
    expect(sessionOptions["skillDirectories"]).toEqual(["/home/ve/.copilot/skills"]);
    expect(mocks.emitLocalSkillsLoaded).not.toHaveBeenCalled();
    expect(mocks.emitEvent).toHaveBeenCalledWith("session.start", expect.objectContaining({
      mode: "review",
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
    const prompt = buildNativeReviewPrompt("VE REVIEW CONTEXT\nDIFF CONTENT");

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
      "For extra context, only read files under /workspace; do not execute commands, access the network, or edit files.",
      "Do not recompute the diff or compare branches.",
      "",
      "VE REVIEW CONTEXT",
      "DIFF CONTENT",
      "VE_DELEGATED_PROMPT_END",
    ].join("\n"));
  });

  it("appends agent instructions to the Copilot CLI foundation explicitly", () => {
    expect(buildCopilotSystemMessage("permanent agent policy")).toEqual({
      mode: "append",
      content: "permanent agent policy",
    });
  });

  it("configures only the explicit VE submission MCP server for review", () => {
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
    }, []);

    expect(config.enableConfigDiscovery).toBe(false);
    expect(config.mcpServers).toEqual({
      "ve-submission": expect.objectContaining({
        type: "stdio",
        tools: ["ve_submit_review"],
      }),
    });
  });

  it("requires the coding completion tool without loading repository MCP config", () => {
    const config = buildCopilotSessionConfig({
      model: "gpt-5.1-codex",
      agentInstructions: "coding policy",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    }, []);

    expect(config.enableConfigDiscovery).toBe(false);
    expect(config.systemMessage).toEqual(expect.objectContaining({
      content: expect.stringContaining("ve_submit_changes"),
    }));
    expect(config.mcpServers).toEqual({
      "ve-submission": expect.objectContaining({
        tools: ["ve_submit_changes"],
      }),
    });
  });

  it("uses the read-only permission policy only for review sessions", () => {
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
    }, []);
    const codeConfig = buildCopilotSessionConfig({ ...common, mode: "codegen" }, []);

    expect(reviewConfig.onPermissionRequest).toBe(restrictReviewPermissionHandler);
    expect(codeConfig.onPermissionRequest).toBe(restrictNetworkPermissionHandler);
  });
});