import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ApiCycle } from "../../src/admin/ui/types.ts";
import { getCyclePresentation } from "../../src/admin/ui/views/TasksView/agentCyclePresentation.js";
import {
  isCurrentTaskRequest,
  isSameTaskRequest,
  shouldStartTaskRequest,
} from "../../src/admin/ui/views/TasksView/taskDetailRequests.js";

function makeCycle(overrides: Partial<ApiCycle["result"]> = {}): ApiCycle {
  return {
    id: 1,
    taskId: "review-33847",
    cycleNumber: 1,
    result: {
      status: "failed",
      modifiedFiles: [],
      summary: "sandbox provisioning timed out",
      agentLogs: "",
      metadata: { error: "sandbox provisioning timed out" },
      ...overrides,
    },
    validationResult: null,
    createdAt: "2026-07-16T13:39:25.000Z",
    durationMs: null,
    cost: null,
  };
}

describe("getCyclePresentation", () => {
  it("rejects stale and cross-task detail responses", () => {
    expect(isCurrentTaskRequest("task-a", 2, "task-a", 2)).toBe(true);
    expect(isCurrentTaskRequest("task-a", 1, "task-a", 2)).toBe(false);
    expect(isCurrentTaskRequest("task-a", 2, "task-b", 2)).toBe(false);
  });

  it("prevents overlapping requests only for the same task", () => {
    const pending = { taskId: "task-a", requestSequence: 3 };

    expect(shouldStartTaskRequest("task-a", pending)).toBe(false);
    expect(shouldStartTaskRequest("task-b", pending)).toBe(true);
    expect(shouldStartTaskRequest("task-a", null)).toBe(true);
    expect(isSameTaskRequest(pending, { ...pending })).toBe(true);
    expect(isSameTaskRequest(pending, { taskId: "task-a", requestSequence: 4 })).toBe(false);
  });

  it("shows an explicit running cycle with the active tone", () => {
    expect(getCyclePresentation(makeCycle({
      status: "running",
      summary: "",
      metadata: {},
    }))).toEqual({ status: "running", tone: "active", error: null });
  });

  it("shows a persisted failed cycle as failed even when agent logs are empty", () => {
    expect(getCyclePresentation(makeCycle())).toEqual({
      status: "failed",
      tone: "danger",
      error: "sandbox provisioning timed out",
    });
  });

  it("wires failure presentation into the cycle card", () => {
    const source = readFileSync("src/admin/ui/views/TasksView/AgentCycles.tsx", "utf8");

    expect(source).toContain("getCyclePresentation(cycle)");
    expect(source).toContain("{presentation.error}");
    expect(source).not.toContain("!cycle.result.agentLogs");
  });

  it("refreshes cycles while the active cycles tab is visible", () => {
    const source = readFileSync("src/admin/ui/views/TasksView/TaskDetail.tsx", "utf8");

    expect(source).toContain('tab !== "cycles" || !isActiveState(task.state)');
    expect(source).toContain("window.setInterval");
    expect(source).toContain("loadCycles(task.taskId)");
    expect(source).toContain("window.clearInterval");
  });

  it("invalidates an in-flight cycle request before a task-state reload", () => {
    const source = readFileSync("src/admin/ui/views/TasksView/TaskDetail.tsx", "utf8");
    const reloadEffect = source.slice(source.indexOf("setCycles(null);", source.indexOf("useEffect")));

    expect(reloadEffect).toContain("cycleRequestSequence.current += 1");
    expect(reloadEffect).toContain("cycleRequestInFlight.current = null");
    expect(reloadEffect.indexOf("cycleRequestSequence.current += 1")).toBeLessThan(
      reloadEffect.indexOf("loadDetails(task.taskId, task)"),
    );
  });

  it("falls back to the cycle summary when failure metadata has no error", () => {
    expect(getCyclePresentation(makeCycle({ metadata: {} })).error).toBe(
      "sandbox provisioning timed out",
    );
  });

  it("does not expose an error for a successful cycle", () => {
    expect(getCyclePresentation(makeCycle({
      status: "success",
      summary: "review posted",
      metadata: {},
    }))).toEqual({ status: "success", tone: "ok", error: null });
  });
});
