/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../../src/admin/ui/api.js";
import { CurrentUserProvider } from "../../../src/admin/ui/authContext.js";
import { TaskDetail } from "../../../src/admin/ui/views/TasksView/TaskDetail.js";
import { TasksView } from "../../../src/admin/ui/views/TasksView/index.js";
import type { ApiTask } from "../../../src/admin/ui/types.js";

const task: ApiTask = {
  taskId: "task-1",
  taskType: "code-gen",
  ticketId: "ticket-1",
  ticketSourceLabel: "github",
  ticketTitle: "Fix task",
  ticketDescription: "",
  state: "FAILED",
  gerritChangeId: null,
  currentPatchset: 0,
  reviewedPatchset: null,
  cycleCount: 0,
  failureReason: null,
  ticketUrl: null,
  reviewUrl: null,
  displayId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const queueTasks: ApiTask[] = [
  { ...task, taskId: "active-code", ticketTitle: "Active coding", state: "DETECTED", waitingForAgentSlot: true },
  { ...task, taskId: "watching-code", ticketTitle: "Watching coding", state: "IN_REVIEW", waitingForAgentSlot: true },
  { ...task, taskId: "preparing-code", ticketTitle: "Preparing coding", state: "CONTEXT_BUILDING" },
  { ...task, taskId: "active-review", ticketTitle: "Active review", taskType: "code-review", state: "REVIEW_RUNNING", waitingForAgentSlot: true },
  { ...task, taskId: "done-code", ticketTitle: "Done coding", state: "DONE" },
  { ...task, taskId: "failed-review", ticketTitle: "Failed review", taskType: "code-review", state: "REVIEW_FAILED", waitingForAgentSlot: false },
];

function renderQueue(tasks = queueTasks, compact = false) {
  window.history.replaceState({}, "", "#tasks");
  vi.stubGlobal("ResizeObserver", class {
    observe = vi.fn();
    disconnect = vi.fn();
  });
  const media = {
    matches: compact,
    addEventListener: vi.fn<(event: string, listener: () => void) => void>(),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal("matchMedia", vi.fn(() => media));
  vi.spyOn(api, "get").mockResolvedValue({ task: tasks[0], cycles: [], transitions: [] });
  return { ...render(<TasksView tasks={tasks} onRefresh={vi.fn()} />), media };
}

describe("task interactions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("asks before permanently deleting a terminal task", () => {
    vi.stubGlobal("ResizeObserver", class {
      observe = vi.fn();
      disconnect = vi.fn();
    });
    vi.spyOn(api, "get").mockResolvedValue({ task, cycles: [], transitions: [] });
    const deleteTask = vi.spyOn(api, "delete").mockResolvedValue({ ok: true });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <CurrentUserProvider value={{ user: { id: "u", username: "admin", role: "admin" }, isAdmin: true, canOperate: true, can: () => true }}>
        <TaskDetail task={task} onRefresh={vi.fn()} onDeleted={vi.fn()} />
      </CurrentUserProvider>,
    );

    fireEvent.click(screen.getByTitle("Delete task"));

    expect(confirm).toHaveBeenCalled();
    expect(deleteTask).not.toHaveBeenCalled();
  });

  it("uses effective task permissions, not just the operator role, for actions", () => {
    vi.stubGlobal("ResizeObserver", class {
      observe = vi.fn();
      disconnect = vi.fn();
    });
    vi.spyOn(api, "get").mockResolvedValue({ task, cycles: [], transitions: [] });
    const { rerender } = render(
      <CurrentUserProvider value={{ user: { id: "u", username: "operator", role: "operator" }, isAdmin: false, canOperate: true, can: () => false }}>
        <TaskDetail task={{ ...task, permissions: { operate: true, delete: false } }} onRefresh={vi.fn()} onDeleted={vi.fn()} />
      </CurrentUserProvider>,
    );
    expect(screen.getByTitle("Retry")).toBeTruthy();
    expect(screen.queryByTitle("Delete task")).toBeNull();

    rerender(
      <CurrentUserProvider value={{ user: { id: "u", username: "operator", role: "operator" }, isAdmin: false, canOperate: true, can: () => true }}>
        <TaskDetail task={{ ...task, permissions: { operate: false, delete: false } }} onRefresh={vi.fn()} onDeleted={vi.fn()} />
      </CurrentUserProvider>,
    );
    expect(screen.queryByTitle("Retry")).toBeNull();
    expect(screen.queryByTitle("Delete task")).toBeNull();
  });

  it("classifies detected tasks as active and closing tasks as active", () => {
    renderQueue([
      { ...task, taskId: "detected", ticketTitle: "Detected task", state: "DETECTED" },
      { ...task, taskId: "closing", ticketTitle: "Closing task", state: "CLOSING" },
    ], true);
    fireEvent.click(screen.getByRole("button", { name: "Active" }));
    expect(screen.getByText("Detected task")).toBeTruthy();
    expect(screen.getByText("Closing task")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Watching" }));
    expect(screen.getByText("Detected task")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Active" }));
    expect(screen.queryByText("Detected task")).toBeNull();
  });

  it("combines workflow statuses with task type, queue flag, and existing search", () => {
    renderQueue();
    fireEvent.click(screen.getByRole("button", { name: "Active" }));
    fireEvent.click(screen.getByRole("button", { name: "Watching" }));
    fireEvent.click(screen.getByRole("button", { name: "Coding" }));
    fireEvent.click(screen.getByRole("button", { name: "Queued only" }));

    expect(screen.getByRole("button", { name: "Inspect task Active coding" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Inspect task Watching coding" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Inspect task Preparing coding" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Inspect task Active review" })).toBeNull();
    expect(screen.getByLabelText("Task results").textContent).toBe("2/6");

    fireEvent.change(screen.getByRole("textbox", { name: "Search tasks" }), { target: { value: "WATCHING" } });
    expect(screen.queryByRole("button", { name: "Inspect task Active coding" })).toBeNull();
    expect(screen.getByRole("button", { name: "Inspect task Watching coding" })).toBeTruthy();
    expect(screen.getByLabelText("Task results").textContent).toBe("1/6");
  });

  it("shows status labels without numbers and keeps every choice available", () => {
    renderQueue();
    fireEvent.click(screen.getByRole("button", { name: "Active" }));
    fireEvent.click(screen.getByRole("button", { name: "Coding" }));
    fireEvent.click(screen.getByRole("button", { name: "Queued only" }));

    const statuses = within(screen.getByRole("group", { name: "Workflow status" }));
    expect(statuses.getAllByRole("button").map((button) => button.textContent)).toEqual(["All", "Active", "Watching", "Done", "Failed", "Queued"]);
    expect(statuses.getByRole<HTMLButtonElement>("button", { name: "Failed" }).disabled).toBe(false);
    expect(screen.getByLabelText("Task results").textContent).toBe("1/6");

    fireEvent.change(screen.getByRole("textbox", { name: "Search tasks" }), { target: { value: "Watching" } });
    expect(screen.getByLabelText("Task results").textContent).toBe("0/6");
    expect(statuses.getByRole<HTMLButtonElement>("button", { name: "Watching" }).disabled).toBe(false);
  });

  it("puts task types first and styles the independent Queued toggle like the statuses", () => {
    renderQueue(queueTasks, true);
    const taskTypes = screen.getByRole("group", { name: "Task type" });
    const statuses = screen.getByRole("group", { name: "Workflow status" });
    const queued = within(statuses).getByRole("button", { name: "Queued only" });

    expect(taskTypes.nextElementSibling).toBe(statuses);
    expect(statuses.children).toHaveLength(6);
    expect(statuses.style.display).toBe("grid");
    expect(taskTypes.style.display).toBe("grid");
    expect(within(taskTypes).getAllByRole("button").map((button) => button.textContent)).toEqual(["All", "Coding", "Review"]);
    expect(within(statuses).getAllByRole("button").map((button) => button.textContent)).toEqual(["All", "Active", "Watching", "Done", "Failed", "Queued"]);
    expect(queued.style.cssText).toBe(within(statuses).getByRole("button", { name: "Active" }).style.cssText);
    expect(queued.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(queued);
    expect(queued.getAttribute("aria-pressed")).toBe("true");
    expect(within(statuses).getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByLabelText("Task results").textContent).toBe("3/6");
    fireEvent.click(queued);
    expect(queued.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByLabelText("Task results").textContent).toBe("6/6");
  });

  it("keeps status buttons number-free even with many tasks", () => {
    const { rerender } = renderQueue(queueTasks, true);
    fireEvent.click(screen.getByRole("button", { name: "Failed" }));
    const tasks = Array.from({ length: 1001 }, (_, index) => ({
      ...task, taskId: `queued-${index}`, state: "DETECTED" as const,
    }));
    rerender(<TasksView tasks={tasks} onRefresh={vi.fn()} />);

    const statuses = within(screen.getByRole("group", { name: "Workflow status" }));
    expect(statuses.getAllByRole("button").map((button) => button.textContent)).toEqual(["All", "Active", "Watching", "Done", "Failed", "Queued"]);
    expect(statuses.getByRole("button", { name: "All" }).getAttribute("aria-describedby")).toBeNull();
    expect(screen.getByLabelText("Task results").textContent).toBe("0/1001");
  });

  it("returns to All after clearing statuses and resets every filter without changing the selected task", () => {
    renderQueue();
    const statuses = within(screen.getByRole("group", { name: "Workflow status" }));
    expect(statuses.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: "Reset filters" })).toBeNull();

    fireEvent.click(statuses.getByRole("button", { name: "Active" }));
    expect(statuses.getByRole("button", { name: "Active" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(statuses.getByRole("button", { name: "Active" }));
    expect(statuses.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByLabelText("Task results").textContent).toBe("6/6");

    fireEvent.click(statuses.getByRole("button", { name: "Watching" }));
    fireEvent.click(statuses.getByRole("button", { name: "All" }));
    expect(statuses.getByRole("button", { name: "Watching" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(statuses.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(screen.getByRole("button", { name: "Queued only" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search tasks" }), { target: { value: "missing" } });
    expect(screen.getByText("No tasks match the current filters.")).toBeTruthy();
    const selectedHash = window.location.hash;
    fireEvent.click(screen.getByRole("button", { name: "Clear all filters" }));

    expect(statuses.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(screen.getByRole("group", { name: "Task type" })).getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Queued only" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Search tasks" }).value).toBe("");
    expect(screen.getByLabelText("Task results").textContent).toBe("6/6");
    expect(window.location.hash).toBe(selectedHash);
    expect(screen.queryByRole("button", { name: "Reset filters" })).toBeNull();
  });

  it("filters reviews independently and preserves the selected detail when filtering it out", () => {
    renderQueue();
    const selectedHash = window.location.hash;
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByLabelText("Task results").textContent).toBe("2/6");
    expect(screen.getByRole("button", { name: "Inspect task Active review" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Inspect task Failed review" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Inspect task Active coding" })).toBeNull();
    expect(screen.getByText("Active coding")).toBeTruthy();
    expect(window.location.hash).toBe(selectedHash);
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(screen.getByLabelText("Task results").textContent).toBe("6/6");
  });

  it("normalizes all workflow selections to All and keeps type All independent of status", () => {
    renderQueue();
    const statuses = within(screen.getByRole("group", { name: "Workflow status" }));
    for (const name of ["Active", "Watching", "Done", "Failed"]) {
      fireEvent.click(statuses.getByRole("button", { name }));
    }
    expect(statuses.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByLabelText("Task results").textContent).toBe("6/6");
    expect(screen.queryByRole("button", { name: "Reset filters" })).toBeNull();

    fireEvent.click(statuses.getByRole("button", { name: "Active" }));
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByLabelText("Task results").textContent).toBe("1/6");
    fireEvent.click(within(screen.getByRole("group", { name: "Task type" })).getByRole("button", { name: "All" }));
    expect(screen.getByLabelText("Task results").textContent).toBe("3/6");
    expect(statuses.getByRole("button", { name: "Active" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("preserves filters when crossing the compact layout breakpoint", () => {
    const { media } = renderQueue();
    fireEvent.click(screen.getByRole("button", { name: "Active" }));
    fireEvent.click(screen.getByRole("button", { name: "Coding" }));
    fireEvent.click(screen.getByRole("button", { name: "Queued only" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search tasks" }), { target: { value: "Active" } });
    fireEvent.click(screen.getByRole("button", { name: "Inspect task Active coding" }));
    const onChange = media.addEventListener.mock.calls[0]?.[1];
    expect(onChange).toBeTypeOf("function");
    act(() => {
      media.matches = true;
      onChange?.();
    });
    expect(screen.queryByText("Task queue")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to tasks" }));
    expect(screen.getByLabelText("Task results").textContent).toBe("1/6");
    act(() => {
      media.matches = false;
      onChange?.();
    });

    expect(screen.getByRole("button", { name: "Active" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Coding" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Queued only" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Search tasks" }).value).toBe("Active");
    expect(screen.getByLabelText("Task results").textContent).toBe("1/6");
  });

  it("preserves search and every filter after opening mobile task detail and returning", () => {
    renderQueue(queueTasks, true);
    fireEvent.click(screen.getByRole("button", { name: "Active" }));
    fireEvent.click(screen.getByRole("button", { name: "Watching" }));
    fireEvent.click(screen.getByRole("button", { name: "Coding" }));
    fireEvent.click(screen.getByRole("button", { name: "Queued only" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search tasks" }), { target: { value: "Watching" } });
    fireEvent.click(screen.getByRole("button", { name: "Inspect task Watching coding" }));
    expect(screen.queryByText("Task queue")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to tasks" }));

    expect(screen.getByRole("button", { name: "Active" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Watching" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Coding" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Queued only" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Search tasks" }).value).toBe("Watching");
    expect(screen.getByLabelText("Task results").textContent).toBe("1/6");
  });

  it("exposes the external ticket link separately from the task selection button", () => {
    renderQueue([{ ...task, ticketUrl: "https://example.test/ticket/1" }], true);
    const link = screen.getByRole("link", { name: /TICKET-1/i });
    expect(link.closest("button")).toBeNull();
  });

  it("distinguishes failed cycle and timeline requests from empty results", async () => {
    vi.stubGlobal("ResizeObserver", class {
      observe = vi.fn();
      disconnect = vi.fn();
    });
    vi.spyOn(api, "get").mockImplementation((path) =>
      path.endsWith("/cycles") || path.endsWith("/transitions")
        ? Promise.reject(new Error("offline"))
        : Promise.resolve({ task }));
    render(<TaskDetail task={task} onRefresh={vi.fn()} onDeleted={vi.fn()} />);

    expect(await screen.findByText("Failed to load agent cycles.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /State timeline/ }));
    expect(await screen.findByText("Failed to load state timeline.")).toBeTruthy();
  });

  it("lets a narrow screen switch between the queue and task detail", () => {
    window.history.replaceState({}, "", "#tasks");
    vi.stubGlobal("ResizeObserver", class {
      observe = vi.fn();
      disconnect = vi.fn();
    });
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    vi.spyOn(api, "get").mockResolvedValue({ task, cycles: [], transitions: [] });
    render(<TasksView tasks={[task]} onRefresh={vi.fn()} />);

    expect(screen.getByText("Task queue")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Fix task/ }));
    expect(screen.queryByText("Task queue")).toBeNull();
    expect(screen.getByRole("button", { name: "Back to tasks" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to tasks" }));
    expect(screen.getByText("Task queue")).toBeTruthy();
  });
});
