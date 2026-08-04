/**
 * Tests for the persisted tool-usage summary helper
 * (src/admin/ui/views/TasksView/toolUsageSummary.ts).
 */
import { describe, it, expect } from "vitest";
import { summarizeToolUsage } from "../../src/admin/ui/views/TasksView/toolUsageSummary.js";
import type { AgentLogEvent } from "../../src/admin/ui/types.js";

function ev(type: string, data: Record<string, unknown>): AgentLogEvent {
  return { type, timestamp: "2026-08-03T00:00:00.000Z", data, taskId: "t1", cycleNumber: 1 };
}

describe("summarizeToolUsage", () => {
  it("returns empty summary for undefined/empty events", () => {
    expect(summarizeToolUsage(undefined)).toEqual({ totalCalls: 0, totalDenials: 0, tools: [] });
    expect(summarizeToolUsage([])).toEqual({ totalCalls: 0, totalDenials: 0, tools: [] });
  });

  it("counts tool calls by name and dedups by callId", () => {
    const summary = summarizeToolUsage([
      ev("tool.execution_start", { name: "Read", callId: "r1" }),
      ev("tool.execution_start", { name: "Read", callId: "r1" }), // dup
      ev("tool.execution_start", { name: "Edit", callId: "e1" }),
    ]);
    expect(summary.totalCalls).toBe(2);
    expect(summary.tools).toHaveLength(2);
    const read = summary.tools.find((t) => t.name === "Read");
    expect(read?.callCount).toBe(1);
    const edit = summary.tools.find((t) => t.name === "Edit");
    expect(edit?.callCount).toBe(1);
  });

  it("counts permission.denied events per tool with reason", () => {
    const summary = summarizeToolUsage([
      ev("permission.denied", { toolName: "Bash", reason: "blocked" }),
      ev("permission.denied", { toolName: "Bash", reason: "blocked again" }),
      ev("permission.denied", { toolName: "WebFetch", reason: "network floor" }),
    ]);
    expect(summary.totalDenials).toBe(3);
    const bash = summary.tools.find((t) => t.name === "Bash");
    expect(bash?.denialCount).toBe(2);
    expect(bash?.lastDenialReason).toBe("blocked again");
    const web = summary.tools.find((t) => t.name === "WebFetch");
    expect(web?.denialCount).toBe(1);
  });

  it("counts calls without an identity (no dedup)", () => {
    const summary = summarizeToolUsage([
      ev("tool.execution_start", { name: "Read" }),
      ev("tool.execution_start", { name: "Read" }),
    ]);
    expect(summary.totalCalls).toBe(2);
    expect(summary.tools[0]?.callCount).toBe(2);
  });

  it("sorts tools by total activity then name", () => {
    const summary = summarizeToolUsage([
      ev("tool.execution_start", { name: "Read", callId: "r1" }),
      ev("tool.execution_start", { name: "Edit", callId: "e1" }),
      ev("tool.execution_start", { name: "Edit", callId: "e2" }),
      ev("permission.denied", { toolName: "Bash", reason: "x" }),
    ]);
    // Edit (2 calls) first, then Bash (1 denial), then Read (1 call)
    expect(summary.tools.map((t) => t.name)).toEqual(["Edit", "Bash", "Read"]);
  });
});
