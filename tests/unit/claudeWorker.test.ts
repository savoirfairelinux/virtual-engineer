import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunOptions } from "../../agent-worker/src/providers/types.js";

const mocks = vi.hoisted(() => ({
  emitEvent: vi.fn(),
  emitLocalSkillsLoaded: vi.fn(),
  query: vi.fn(),
}));

vi.mock("../../agent-worker/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs", () => ({
  query: (...args: unknown[]) => mocks.query(...args),
}));

vi.mock("../../agent-worker/src/providers/events.js", () => ({
  emitEvent: (...args: unknown[]) => mocks.emitEvent(...args),
}));

vi.mock("../../agent-worker/src/skills.js", () => ({
  emitLocalSkillsLoaded: (...args: unknown[]) => mocks.emitLocalSkillsLoaded(...args),
}));

import { runClaudeAgent } from "../../agent-worker/src/providers/claude.js";

interface FakeStream extends AsyncIterable<unknown> {
  close: ReturnType<typeof vi.fn>;
}

function makeStream(messages: unknown[]): FakeStream {
  return {
    close: vi.fn(),
    async *[Symbol.asyncIterator]() {
      yield* messages;
    },
  };
}

function makeOptions(overrides: Partial<AgentRunOptions> = {}): AgentRunOptions {
  return {
    model: "claude-sonnet",
    systemPrompt: "Follow repository instructions",
    cwd: "/workspace",
    timeoutMs: 1_000,
    mode: "codegen",
    ...overrides,
  };
}

describe("runClaudeAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps assistant tools, usage, cost, and the final result", async () => {
    const stream = makeStream([
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Edit", input: { file_path: "src/index.ts" } },
            { type: "text", text: "Working on it" },
          ],
          usage: {
            input_tokens: 20,
            output_tokens: 10,
            cache_read_input_tokens: 4,
            cache_creation_input_tokens: 2,
          },
        },
      },
      {
        type: "result",
        subtype: "success",
        result: "Implemented safely",
        total_cost_usd: 0.12,
        num_turns: 2,
      },
    ]);
    mocks.query.mockReturnValue(stream);

    const run = await runClaudeAgent("Implement the task", makeOptions({ skillDiscovery: true }));

    expect(run).toMatchObject({
      content: "Implemented safely",
      toolCallCount: 1,
      toolsByKind: { Edit: 1 },
    });
    expect(mocks.query).toHaveBeenCalledWith({
      prompt: "Implement the task",
      options: expect.objectContaining({
        model: "claude-sonnet",
        cwd: "/workspace",
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: "Follow repository instructions",
        },
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: ["project"],
      }),
    });
    expect(mocks.emitLocalSkillsLoaded).toHaveBeenCalledWith("/workspace");
    expect(mocks.emitEvent).toHaveBeenCalledWith("tool.execution_start", {
      name: "Edit",
      input: { file_path: "src/index.ts" },
      callNumber: 1,
    });
    expect(mocks.emitEvent).toHaveBeenCalledWith("assistant.usage", {
      inputTokens: 20,
      outputTokens: 10,
      cacheReadTokens: 4,
      cacheWriteTokens: 2,
      model: "claude-sonnet",
    });
    expect(mocks.emitEvent).toHaveBeenCalledWith("cost.total", {
      costUsd: 0.12,
      numTurns: 2,
      model: "claude-sonnet",
    });
    expect(stream.close).toHaveBeenCalledOnce();

    await run.cleanup();
    expect(stream.close).toHaveBeenCalledTimes(2);
  });

  it("uses the review system prompt and assistant text fallback", async () => {
    const stream = makeStream([
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "First finding" },
            { type: "text", text: "Second finding" },
          ],
        },
      },
      { type: "result", subtype: "success" },
    ]);
    mocks.query.mockReturnValue(stream);

    const run = await runClaudeAgent("Review", makeOptions({
      model: "",
      mode: "review",
      skillDiscovery: false,
    }));

    const queryInput = mocks.query.mock.calls[0]?.[0] as {
      options: Record<string, unknown>;
    };
    expect(queryInput.options["model"]).toBeUndefined();
    expect(queryInput.options["systemPrompt"]).toBe("Follow repository instructions");
    expect(queryInput.options["settingSources"]).toEqual([]);
    expect(run.content).toBe("First finding\nSecond finding");
    expect(mocks.emitLocalSkillsLoaded).not.toHaveBeenCalled();
    expect(mocks.emitEvent).toHaveBeenCalledWith("session.end", expect.objectContaining({
      mode: "review",
      model: "cli-default",
      outputLength: 28,
    }));
  });

  it("reports a terminal SDK error and closes the stream", async () => {
    const stream = makeStream([
      {
        type: "result",
        subtype: "error_during_execution",
        errors: ["tool failed", "permission denied"],
      },
    ]);
    mocks.query.mockReturnValue(stream);

    await expect(runClaudeAgent("Implement", makeOptions())).rejects.toThrow(
      "Claude session ended with error: tool failed; permission denied"
    );

    expect(mocks.emitEvent).toHaveBeenCalledWith("session.error", {
      message: "tool failed; permission denied",
    });
    expect(stream.close).toHaveBeenCalledOnce();
  });

  it("aborts at the timeout and closes a failing stream", async () => {
    vi.useFakeTimers();
    let abortController: AbortController | undefined;
    const stream: FakeStream = {
      close: vi.fn(),
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<unknown>>((_, reject) => {
            abortController?.signal.addEventListener("abort", () => {
              reject(new Error("aborted by timeout"));
            }, { once: true });
          }),
        };
      },
    };
    mocks.query.mockImplementation((input: { options: { abortController: AbortController } }) => {
      abortController = input.options.abortController;
      return stream;
    });

    const rejection = expect(
      runClaudeAgent("Implement", makeOptions({ timeoutMs: 50 }))
    ).rejects.toThrow("aborted by timeout");
    await vi.advanceTimersByTimeAsync(50);

    await rejection;
    expect(abortController?.signal.aborted).toBe(true);
    expect(stream.close).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});