import { describe, it, expect, afterEach } from "vitest";
import { processReviewStderrLine } from "../../src/review/reviewStderrEvents.js";
import { agentLogBus, getTaskEventBuffer, clearTaskEventBuffer } from "../../src/agents/agentEventBus.js";
import type { AgentLogEvent } from "../../src/interfaces.js";

const TASK_ID = "review-42-abcd";

describe("processReviewStderrLine", () => {
  afterEach(() => {
    clearTaskEventBuffer(TASK_ID);
  });

  it("parses a structured __ve_event JSON line and emits it on the bus", () => {
    const collected: AgentLogEvent[] = [];
    const busEvents: AgentLogEvent[] = [];
    const listener = (event: AgentLogEvent): void => {
      busEvents.push(event);
    };
    agentLogBus.on("event", listener);
    try {
      const line = JSON.stringify({
        __ve_event: true,
        type: "tool.execution_start",
        ts: "2024-01-01T00:00:00.000Z",
        data: { toolName: "Read" },
      });
      processReviewStderrLine(line, TASK_ID, 1, collected);

      expect(collected).toHaveLength(1);
      expect(collected[0]).toMatchObject({
        type: "tool.execution_start",
        timestamp: "2024-01-01T00:00:00.000Z",
        data: { toolName: "Read" },
        taskId: TASK_ID,
        cycleNumber: 1,
      });
      expect(busEvents).toHaveLength(1);
      expect(getTaskEventBuffer(TASK_ID)).toHaveLength(1);
    } finally {
      agentLogBus.off("event", listener);
    }
  });

  it("defaults type/timestamp when a __ve_event line omits them", () => {
    const collected: AgentLogEvent[] = [];
    processReviewStderrLine(JSON.stringify({ __ve_event: true }), TASK_ID, 2, collected);

    expect(collected).toHaveLength(1);
    expect(collected[0]?.type).toBe("unknown");
    expect(collected[0]?.data).toBeNull();
    expect(typeof collected[0]?.timestamp).toBe("string");
  });

  it("wraps a plain (non-JSON) line as a stderr.line event", () => {
    const collected: AgentLogEvent[] = [];
    processReviewStderrLine("some raw diagnostic output", TASK_ID, 3, collected);

    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({
      type: "stderr.line",
      data: { line: "some raw diagnostic output" },
      taskId: TASK_ID,
      cycleNumber: 3,
    });
  });

  it("wraps a JSON line that is not a __ve_event as a stderr.line event", () => {
    const collected: AgentLogEvent[] = [];
    const line = JSON.stringify({ foo: "bar" });
    processReviewStderrLine(line, TASK_ID, 4, collected);

    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({ type: "stderr.line", data: { line } });
  });
});
