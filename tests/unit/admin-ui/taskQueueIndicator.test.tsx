/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../../src/admin/ui/api.js";
import { TasksView } from "../../../src/admin/ui/views/TasksView/index.js";
import type { ApiTask } from "../../../src/admin/ui/types.js";

const reviewTask: ApiTask = {
  taskId: "review-task",
  taskType: "code-review",
  ticketId: "change-1",
  ticketSourceLabel: "gerrit",
  ticketTitle: "Review change",
  ticketDescription: "",
  state: "REVIEW_RUNNING",
  gerritChangeId: null,
  currentPatchset: 1,
  reviewedPatchset: null,
  cycleCount: 0,
  failureReason: null,
  ticketUrl: null,
  reviewUrl: null,
  displayId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  waitingForAgentSlot: true,
};

describe("task queue indicator", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows queued reviews and code tasks and clears the detail badge without a state change", async () => {
    vi.stubGlobal("ResizeObserver", class {
      observe = vi.fn();
      disconnect = vi.fn();
    });
    vi.spyOn(api, "get").mockResolvedValue({ task: reviewTask, cycles: [], transitions: [] });
    const codeTask: ApiTask = {
      ...reviewTask,
      taskId: "code-task",
      ticketId: "ticket-2",
      taskType: "code-gen",
      state: "CONTEXT_BUILDING",
    };
    const { rerender } = render(<TasksView tasks={[reviewTask, codeTask]} onRefresh={vi.fn()} />);

    expect(await screen.findAllByText("Queued")).toHaveLength(3);

    rerender(<TasksView tasks={[
      { ...reviewTask, waitingForAgentSlot: false },
      { ...codeTask, waitingForAgentSlot: false },
    ]} onRefresh={vi.fn()} />);
    expect(screen.queryByText("Queued")).toBeNull();
  });
});