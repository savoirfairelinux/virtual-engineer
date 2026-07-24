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

import { runCopilotAgent } from "../../agent-worker/src/providers/copilot.js";
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
    systemPrompt: "Follow the repository instructions",
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
  });

  it("runs a headless CLI session, maps events, and cleans up", async () => {
    let resolveResponse: ((value: { data: { content: string } }) => void) | undefined;
    session.sendAndWait.mockImplementation(() => new Promise((resolve) => {
      resolveResponse = resolve;
    }));
    const runPromise = runCopilotAgent("Implement the task", makeOptions({
      skillDiscovery: true,
      reasoningEffort: "high",
    }));
    await vi.waitFor(() => expect(session.on).toHaveBeenCalled());

    session.handlers.get("tool.execution_start")?.({
      toolCall: { name: "edit", input: JSON.stringify({ path: "src/index.ts" }) },
    });
    session.handlers.get("tool.execution_complete")?.({
      tool: { name: "edit" },
      result: { content: "updated", status: "success" },
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
    resolveResponse?.({ data: { content: "Implemented safely" } });

    const run = await runPromise;
    expect(run).toMatchObject({
      content: "Implemented safely",
      toolCallCount: 1,
      toolsByKind: { edit: 1 },
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
      systemMessage: { content: "Follow the repository instructions" },
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
    expect(session.disconnect).toHaveBeenCalledOnce();

    await run.cleanup();
    expect(mocks.clientStop).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(JSON.stringify(mocks.emitEvent.mock.calls)).not.toContain("secret-copilot-token");
  });

  it("uses review mode without optional reasoning or local skills", async () => {
    const run = await runCopilotAgent("Review the patch", makeOptions({
      mode: "review",
      reasoningEffort: "none",
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

  it("stops the client and CLI when session creation fails", async () => {
    mocks.createSession.mockRejectedValue(new Error("Cannot create session"));

    await expect(runCopilotAgent("Implement", makeOptions())).rejects.toThrow(
      "Cannot create session"
    );

    expect(mocks.clientStop).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});