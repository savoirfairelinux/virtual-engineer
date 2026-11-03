/** @vitest-environment jsdom */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../../src/admin/ui/api.js";
import { TaskDetail } from "../../../src/admin/ui/views/TasksView/TaskDetail.js";
import type { ApiTask } from "../../../src/admin/ui/types.js";

const firstTask: ApiTask = {
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
const secondTask: ApiTask = { ...firstTask, taskId: "task-2", ticketId: "ticket-2", ticketTitle: "Second task" };

interface LogStreamRequest {
  url: string;
  signal: AbortSignal;
  send(text: string): void;
}

function stubLogStreams(): LogStreamRequest[] {
  const requests: LogStreamRequest[] = [];
  vi.stubGlobal("fetch", vi.fn((input: string, init: RequestInit) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    const signal = init.signal as AbortSignal;
    signal.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")));
    requests.push({ url: input, signal, send: (text) => controller.enqueue(new TextEncoder().encode(text)) });
    return Promise.resolve(new Response(body, { status: 200 }));
  }));
  return requests;
}

function renderDetail(task: ApiTask) {
  return render(<TaskDetail task={task} onRefresh={vi.fn()} onDeleted={vi.fn()} />);
}

function openTab(name: RegExp) {
  fireEvent.click(screen.getByRole("button", { name }));
}

describe("task detail live logs", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class {
      observe = vi.fn();
      disconnect = vi.fn();
    });
    vi.spyOn(api, "get").mockImplementation((path: string) => Promise.resolve(
      path.endsWith("/cycles") ? { cycles: [] } : path.endsWith("/transitions") ? { transitions: [] } : { task: firstTask },
    ));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens no log stream until the Logs tab is opened, then keeps it across tab switches", async () => {
    const requests = stubLogStreams();
    renderDetail(firstTask);
    await act(async () => undefined);

    expect(requests).toHaveLength(0);

    openTab(/Live logs/);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.url).toBe("/api/admin/logs/stream?taskId=task-1");

    openTab(/Agent cycles/);
    openTab(/Live logs/);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.signal.aborted).toBe(false);
  });

  it("closes the stream on task change and waits for explicit access to the next task", async () => {
    const requests = stubLogStreams();
    const { rerender } = renderDetail(firstTask);
    openTab(/Live logs/);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    openTab(/Agent cycles/);

    rerender(<TaskDetail task={secondTask} onRefresh={vi.fn()} onDeleted={vi.fn()} />);
    expect(requests[0]?.signal.aborted).toBe(true);
    rerender(<TaskDetail task={firstTask} onRefresh={vi.fn()} onDeleted={vi.fn()} />);
    await act(async () => undefined);
    expect(requests).toHaveLength(1);

    openTab(/Live logs/);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    rerender(<TaskDetail task={secondTask} onRefresh={vi.fn()} onDeleted={vi.fn()} />);
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[1]?.signal.aborted).toBe(true);
    expect(requests[2]?.url).toBe("/api/admin/logs/stream?taskId=task-2");
    expect(requests[2]?.signal.aborted).toBe(false);
  });

  it("shows how many older entries the server left out of the replay", async () => {
    const requests = stubLogStreams();
    renderDetail(firstTask);
    openTab(/Live logs/);
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    act(() => requests[0]?.send([
      `data: ${JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "stream.connected",
        level: "info",
        message: "Live log stream connected",
        data: { resumed: false, replayed: 1, omitted: 9_500, limit: 500 },
      })}\n\n`,
      `id: AAAAAAAAAAAAAAAA\ndata: ${JSON.stringify({
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "assistant.message",
        level: "info",
        message: "latest replayed entry",
      })}\n\n`,
    ].join("")));

    expect(await screen.findByText("latest replayed entry")).toBeTruthy();
    // Locale-formatted counts may use no-break spaces, which the DOM text normalizer collapses.
    const notice = `${(9_500).toLocaleString()} older entries omitted`.replace(/\s+/g, " ");
    expect((await screen.findByText(notice, { exact: false })).textContent).toContain("showing the latest 1;");
    expect(screen.queryByText("Live log stream connected")).toBeNull();
  });
});
