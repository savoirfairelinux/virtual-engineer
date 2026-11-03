import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectSse } from "../../src/admin/ui/api.js";

describe("connectSse", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("sessionStorage", {
      getItem: vi.fn(() => "session-token"),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("reports connecting and open states", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));
    const states: string[] = [];

    const cleanup = connectSse("/stream", vi.fn(), undefined, (state) => states.push(state));
    await vi.waitFor(() => expect(states).toEqual(["connecting", "open"]));
    cleanup();
  });

  it("reports forbidden and does not retry a 403 response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    const states: string[] = [];

    connectSse("/stream", vi.fn(), undefined, (state) => states.push(state));
    await vi.waitFor(() => expect(states).toEqual(["connecting", "forbidden"]));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch a chunk that resolves after cleanup", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { streamController = controller; },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));
    const onEvent = vi.fn();
    const states: string[] = [];

    const cleanup = connectSse("/stream", onEvent, undefined, (state) => states.push(state));
    await vi.waitFor(() => expect(states).toEqual(["connecting", "open"]));
    cleanup();
    streamController.enqueue(new TextEncoder().encode("data: late\n\n"));
    await Promise.resolve();
    await Promise.resolve();

    expect(onEvent).not.toHaveBeenCalled();
  });

  it("sends the last received event id when it reconnects", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("id: first\ndata: {}\n\ndata: {\"control\":true}\n\nid: latest\ndata: {}\n\n"));
          controller.close();
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>(), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onEvent = vi.fn();
    const states: string[] = [];

    const cleanup = connectSse("/stream", onEvent, undefined, (state) => states.push(state));
    await vi.waitFor(() => expect(states).toContain("retrying"));
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    cleanup();

    const headersOf = (call: number): Headers =>
      new Headers((fetchMock.mock.calls[call] as [string, RequestInit])[1].headers);
    expect(onEvent).toHaveBeenCalledTimes(3);
    expect(headersOf(0).has("last-event-id")).toBe(false);
    expect(headersOf(1).get("last-event-id")).toBe("latest");
    expect(headersOf(1).get("authorization")).toBe("Bearer session-token");
  });
});