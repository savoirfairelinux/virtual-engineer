/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
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

    expect(await screen.findAllByText("Queued", { selector: "span" })).toHaveLength(3);

    rerender(<TasksView tasks={[
      { ...reviewTask, waitingForAgentSlot: false },
      { ...codeTask, waitingForAgentSlot: false },
    ]} onRefresh={vi.fn()} />);
    expect(screen.queryByText("Queued", { selector: "span" })).toBeNull();
  });

  it("updates queued-only results when the waiting flag changes without a state or timestamp change", () => {
    window.history.replaceState({}, "", "#tasks");
    vi.stubGlobal("ResizeObserver", class {
      observe = vi.fn();
      disconnect = vi.fn();
    });
    vi.spyOn(api, "get").mockResolvedValue({ task: reviewTask, cycles: [], transitions: [] });
    const codeTask: ApiTask = {
      ...reviewTask,
      taskId: "code-task",
      ticketTitle: "Preparing code",
      taskType: "code-gen",
      state: "CONTEXT_BUILDING",
      waitingForAgentSlot: false,
    };
    const unreportedCodeTask: ApiTask = { ...codeTask, taskId: "unreported-code", ticketTitle: "Unreported code" };
    delete unreportedCodeTask.waitingForAgentSlot;
    const { rerender } = render(<TasksView tasks={[reviewTask, codeTask, unreportedCodeTask]} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Queued only" }));
    expect(screen.getByLabelText("Task results").textContent).toBe("1/3");
    expect(screen.getByRole("button", { name: "Inspect task Review change" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Inspect task Preparing code" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Inspect task Unreported code" })).toBeNull();

    rerender(<TasksView tasks={[
      { ...reviewTask, waitingForAgentSlot: false },
      { ...codeTask, waitingForAgentSlot: true },
      unreportedCodeTask,
    ]} onRefresh={vi.fn()} />);
    expect(screen.getByLabelText("Task results").textContent).toBe("1/3");
    expect(screen.queryByRole("button", { name: "Inspect task Review change" })).toBeNull();
    expect(screen.getByRole("button", { name: "Inspect task Preparing code" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Inspect task Unreported code" })).toBeNull();
  });
});