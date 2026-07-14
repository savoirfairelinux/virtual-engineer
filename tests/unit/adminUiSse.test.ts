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
});