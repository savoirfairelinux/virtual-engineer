import { describe, expect, it } from "vitest";
import { makeTaskId } from "../../src/interfaces.js";
import type { AgentCycle, AgentLogEvent } from "../../src/interfaces.js";
import {
  LOG_STREAM_REPLAY_LIMIT,
  readLastEventId,
  selectLogStreamReplay,
  type LogStreamReplay,
} from "../../src/admin/logStreamReplay.js";

const TASK_ID = "task-1";

function event(index: number): AgentLogEvent {
  return {
    type: "assistant.message",
    timestamp: new Date(Date.UTC(2026, 3, 7, 9) + index).toISOString(),
    data: { content: `event-${index}` },
    taskId: TASK_ID,
    cycleNumber: 1,
  };
}

function stderrLine(line: string): AgentLogEvent {
  return {
    type: "stderr.line",
    timestamp: "2026-04-07T09:00:00.000Z",
    data: { line },
    taskId: TASK_ID,
    cycleNumber: 1,
  };
}

/** An event whose payload records every time the replay reads it. */
function trackedEvent(index: number, touched: Set<number>, content = `event-${index}`): AgentLogEvent {
  return Object.defineProperty(event(index), "data", {
    enumerable: true,
    get: () => {
      touched.add(index);
      return { content };
    },
  });
}

function cycle(cycleNumber: number, agentEvents: AgentLogEvent[], agentLogs = ""): AgentCycle {
  return {
    id: cycleNumber,
    taskId: makeTaskId(TASK_ID),
    cycleNumber,
    result: { status: "success", modifiedFiles: [], summary: "", agentLogs, agentEvents, metadata: {} },
    validationResult: null,
    createdAt: new Date(Date.UTC(2026, 3, 7, 8, cycleNumber)),
  };
}

function labels(replay: LogStreamReplay): unknown[] {
  return replay.entries.map(({ entry }) => {
    const data = entry["data"];
    return data && typeof data === "object" && "content" in data ? data.content : entry["message"];
  });
}

function range(start: number, end: number, label: (index: number) => string): string[] {
  return Array.from({ length: end - start }, (_, offset) => label(start + offset));
}

function events(start: number, end: number): AgentLogEvent[] {
  return Array.from({ length: end - start }, (_, offset) => event(start + offset));
}

function eventLabels(start: number, end: number): string[] {
  return range(start, end, (index) => `event-${index}`);
}

describe("selectLogStreamReplay", () => {
  it("replays only the newest 500 of 10,000 events and never reads older ones", () => {
    const touched = new Set<number>();
    const history = Array.from({ length: 10_000 }, (_, index) => trackedEvent(index, touched));

    const replay = selectLogStreamReplay([cycle(1, history)], [], undefined);

    expect(LOG_STREAM_REPLAY_LIMIT).toBe(500);
    expect(labels(replay)).toEqual(eventLabels(9_500, 10_000));
    expect(replay.summary).toEqual({ resumed: false, replayed: 500, omitted: 9_500, limit: 500 });
    expect(touched.size).toBe(500);
    expect(Math.min(...touched)).toBe(9_500);
  });

  it("keeps the newest non-blank log lines of a cycle and counts older lines as omitted", () => {
    const agentLogs = `\n${range(0, 600, (index) => `line-${index}`).join("\r\n \r\n")}\n\n`;

    const replay = selectLogStreamReplay([cycle(1, [], agentLogs)], [], undefined);

    expect(labels(replay)).toEqual(range(100, 600, (index) => `line-${index}`));
    expect(replay.entries[0]?.entry).toMatchObject({
      timestamp: "2026-04-07T08:01:00.000Z",
      taskId: TASK_ID,
      level: "info",
      source: "agent",
    });
    expect(replay.summary).toEqual({ resumed: false, replayed: 500, omitted: 100, limit: 500 });
  });

  it("keeps history order and drops buffered events that overlap persisted ones", () => {
    const replay = selectLogStreamReplay(
      [cycle(1, [], "first cycle log"), cycle(2, [event(0), event(1), event(2)], "second cycle log")],
      [event(1), event(2), event(3)],
      undefined,
    );

    expect(labels(replay)).toEqual(["first cycle log", "second cycle log", "event-0", "event-1", "event-2", "event-3"]);
    expect(replay.summary).toEqual({ resumed: false, replayed: 6, omitted: 0, limit: 500 });
  });

  it("counts an event that a running review both persisted and buffered once", () => {
    const replay = selectLogStreamReplay([cycle(1, events(0, 500))], events(0, 500), undefined);

    expect(labels(replay)).toEqual(eventLabels(0, 500));
    expect(replay.summary).toEqual({ resumed: false, replayed: 500, omitted: 0, limit: 500 });
  });

  it("counts only history older than the buffered copies and reads no other payload", () => {
    const touched = new Set<number>();
    const persisted = Array.from({ length: 10_000 }, (_, index) => trackedEvent(index, touched));

    const replay = selectLogStreamReplay([cycle(1, persisted)], events(9_500, 10_000), undefined);

    expect(labels(replay)).toEqual(eventLabels(9_500, 10_000));
    expect(replay.summary).toEqual({ resumed: false, replayed: 500, omitted: 9_500, limit: 500 });
    expect(Math.min(...touched)).toBeGreaterThanOrEqual(9_500);
  });

  it("gives every replayed entry a stable compact event id", () => {
    const cycles = [cycle(1, events(0, 3), "log line")];

    const first = selectLogStreamReplay(cycles, [], undefined).entries.map(({ id }) => id);
    const second = selectLogStreamReplay(cycles, [], undefined).entries.map(({ id }) => id);

    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(4);
    for (const id of first) expect(id).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });

  it("resumes directly after a cursor that is still in the live buffer", () => {
    const history = [cycle(1, events(0, 10))];
    const cursor = selectLogStreamReplay(history, events(10, 20), undefined).entries.at(-6)?.id;

    const replay = selectLogStreamReplay(history, events(10, 21), cursor);

    expect(labels(replay)).toEqual(eventLabels(15, 21));
    expect(replay.summary).toEqual({ resumed: true, replayed: 6, omitted: 0, limit: 500 });
  });

  it("replays afresh once the cursor's cycle completed and its live buffer was cleared", () => {
    // A coding agent streams structured events and plain stderr lines in one
    // order, but its completed cycle stores the plain lines apart from events.
    const live = [event(0), stderrLine("diagnostic-1"), event(1)];
    const cursor = selectLogStreamReplay([], live, undefined).entries.at(-1)?.id;
    const completed = cycle(1, [event(0), event(1)], "diagnostic-1\ndiagnostic-2\ndiagnostic-3");

    const replay = selectLogStreamReplay([completed], [], cursor);

    expect(labels(replay)).toEqual(["diagnostic-1", "diagnostic-2", "diagnostic-3", "event-0", "event-1"]);
    expect(replay.summary).toEqual({ resumed: false, replayed: 5, omitted: 0, limit: 500 });
  });

  it("falls back to a bounded replay when the cursor is not in the live buffer", () => {
    const history = [cycle(1, events(0, 600))];
    const staleCursor = selectLogStreamReplay([cycle(1, events(0, 51))], [], undefined).entries.at(-1)?.id;

    const stale = selectLogStreamReplay(history, [], staleCursor);
    const unknown = selectLogStreamReplay(history, [], "AAAAAAAAAAAAAAAA");

    expect(labels(stale)).toEqual(eventLabels(100, 600));
    expect(stale.summary).toEqual({ resumed: false, replayed: 500, omitted: 100, limit: 500 });
    expect(unknown.summary).toEqual(stale.summary);
  });

  it("bounds the work spent skipping duplicate history", () => {
    const touched = new Set<number>();
    const duplicates = Array.from({ length: 5_000 }, (_, index) => {
      const duplicate = trackedEvent(index, touched, "same");
      duplicate.timestamp = "2026-04-07T09:00:00.000Z";
      return duplicate;
    });

    const replay = selectLogStreamReplay([cycle(1, duplicates)], [], undefined);

    expect(labels(replay)).toEqual(["same"]);
    expect(touched.size).toBeLessThanOrEqual(2 * LOG_STREAM_REPLAY_LIMIT);
  });
});

describe("readLastEventId", () => {
  it("accepts only ids in the format the log stream issues", () => {
    expect(readLastEventId("AbCdEfGh_-012345")).toBe("AbCdEfGh_-012345");
    expect(readLastEventId(undefined)).toBeUndefined();
    expect(readLastEventId("")).toBeUndefined();
    expect(readLastEventId("short")).toBeUndefined();
    expect(readLastEventId("A".repeat(200))).toBeUndefined();
    expect(readLastEventId("AbCdEfGh:-012345")).toBeUndefined();
    expect(readLastEventId(["AbCdEfGh_-012345"])).toBeUndefined();
  });
});
