import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTaskId } from "../../src/interfaces.js";
import type { TaskContext } from "../../src/interfaces.js";
import { getLogger } from "../../src/logger.js";
import { agentLogBus, pushToTaskBuffer } from "../../src/agents/agentEventBus.js";
import { createStderrPipeline } from "../../src/agents/agentStderrPipeline.js";

vi.mock("../../src/agents/agentEventBus.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/agents/agentEventBus.js")>(
    "../../src/agents/agentEventBus.js"
  );
  return { ...actual, pushToTaskBuffer: vi.fn() };
});

function makeContext(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    taskId: makeTaskId("task-123"),
    ticketTitle: "Test",
    ticketDescription: "Test",
    acceptanceCriteria: [],
    baseBranch: "main",
    workspacePath: "/workspace",
    constraints: [],
    priorFeedback: [],
    cycleNumber: 1,
    commitMessage: "Test",
    agentSession: {
      agentContainerImage: "agent:test",
      repoCloneUrl: "ssh://git.example.test/project",
      pushRef: "refs/for/main",
      gitAuthorName: "Virtual Engineer",
      gitAuthorEmail: "ve@example.test",
    },
    ...overrides,
  };
}

const log = getLogger("agent-stderr-pipeline-test");

function veEventLine(overrides: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    __ve_event: true,
    type: "tool.execution_start",
    data: { tool: "readFile" },
    ts: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

describe("agentStderrPipeline", () => {
  beforeEach(() => {
    vi.mocked(pushToTaskBuffer).mockClear();
  });

  it("buffers a chunk split mid-line and only processes complete lines", () => {
    const pipeline = createStderrPipeline(makeContext(), { adapterName: "test", log });

    pipeline.consumeChunk("plain lo");
    expect(pipeline.state.plainLogLines).toHaveLength(0);
    pipeline.consumeChunk("g line\n");
    expect(pipeline.state.plainLogLines).toEqual(["plain log line"]);
  });

  it("routes __ve_event JSON lines to agentEvents, not plainLogLines", () => {
    const pipeline = createStderrPipeline(makeContext(), { adapterName: "test", log });

    pipeline.consumeChunk(`${veEventLine()}\n`);

    expect(pipeline.state.agentEvents).toHaveLength(1);
    expect(pipeline.state.plainLogLines).toHaveLength(0);
    const event = pipeline.state.agentEvents[0];
    expect(event?.type).toBe("tool.execution_start");
    expect(event?.taskId).toBe("task-123");
    expect(event?.cycleNumber).toBe(1);
  });

  it("routes plain non-JSON lines to plainLogLines, not agentEvents", () => {
    const pipeline = createStderrPipeline(makeContext(), { adapterName: "test", log });

    pipeline.consumeChunk("some plain log line\n");

    expect(pipeline.state.plainLogLines).toEqual(["some plain log line"]);
    expect(pipeline.state.agentEvents).toHaveLength(0);
  });

  it("treats malformed JSON as a plain line rather than throwing", () => {
    const pipeline = createStderrPipeline(makeContext(), { adapterName: "test", log });

    expect(() => pipeline.consumeChunk("{not valid json\n")).not.toThrow();
    expect(pipeline.state.plainLogLines).toEqual(["{not valid json"]);
    expect(pipeline.state.agentEvents).toHaveLength(0);
  });

  it("emits every parsed event on the shared agentLogBus and pushes it to the task buffer", () => {
    const received: unknown[] = [];
    const listener = (e: unknown) => received.push(e);
    agentLogBus.on("event", listener);

    const pipeline = createStderrPipeline(makeContext(), { adapterName: "test", log });
    pipeline.consumeChunk("plain line\n");
    pipeline.consumeChunk(`${veEventLine()}\n`);

    agentLogBus.off("event", listener);
    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({ type: "stderr.line", data: { line: "plain line" } });
    expect(received[1]).toMatchObject({ type: "tool.execution_start" });
    expect(pushToTaskBuffer).toHaveBeenCalledTimes(2);
  });

  it("invokes the onEvent hook only for structured events, never for plain lines", () => {
    const onEvent = vi.fn();
    const pipeline = createStderrPipeline(makeContext(), { adapterName: "test", log, onEvent });

    pipeline.consumeChunk("plain line\n");
    expect(onEvent).not.toHaveBeenCalled();

    pipeline.consumeChunk(`${veEventLine()}\n`);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "tool.execution_start" }));
  });

  it("works without an onEvent hook", () => {
    const pipeline = createStderrPipeline(makeContext(), { adapterName: "test", log });
    expect(() => pipeline.consumeChunk(`${veEventLine()}\n`)).not.toThrow();
  });

  it("flush is a no-op when the buffer is empty", () => {
    const pipeline = createStderrPipeline(makeContext(), { adapterName: "test", log });
    pipeline.flush();
    expect(pipeline.state.plainLogLines).toHaveLength(0);
    expect(pipeline.state.agentEvents).toHaveLength(0);
  });

  it("flush processes a trailing partial line with no newline and clears the buffer", () => {
    const pipeline = createStderrPipeline(makeContext(), { adapterName: "test", log });

    pipeline.consumeChunk("trailing line without newline");
    expect(pipeline.state.plainLogLines).toHaveLength(0);

    pipeline.flush();
    expect(pipeline.state.plainLogLines).toEqual(["trailing line without newline"]);

    pipeline.flush();
    expect(pipeline.state.plainLogLines).toEqual(["trailing line without newline"]);
  });
});
