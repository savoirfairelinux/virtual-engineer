/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, connectSse, getStoredToken, onUnauthorized, storeToken } from "../../../src/admin/ui/api.js";

describe("admin API identity boundary", () => {
  beforeEach(() => {
    sessionStorage.clear();
    onUnauthorized(null);
    vi.restoreAllMocks();
  });

  it("ignores a delayed unauthorized response from a superseded token", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    })));
    const unauthorized = vi.fn();
    onUnauthorized(unauthorized);
    storeToken("old-token");

    const oldRequest = api.get("/api/admin/tasks");
    storeToken("new-token");
    resolveFetch?.(new Response(JSON.stringify({ error: "expired" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }));

    await expect(oldRequest).rejects.toMatchObject({ status: 401 });
    expect(getStoredToken()).toBe("new-token");
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it("ignores a delayed unauthorized SSE response from a superseded token", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    })));
    const unauthorized = vi.fn();
    onUnauthorized(unauthorized);
    storeToken("old-token");

    const stop = connectSse("/api/admin/events/stream", vi.fn());
    storeToken("new-token");
    resolveFetch?.(new Response(null, { status: 401 }));
    await vi.waitFor(() => expect(resolveFetch).toBeDefined());
    await Promise.resolve();

    expect(getStoredToken()).toBe("new-token");
    expect(unauthorized).not.toHaveBeenCalled();
    stop();
  });

  it("prefers a detailed server message over a generic error label", async () => {
    const message = 'Integration "Shared GitHub" is still in use by:\n- agent "Build Agent"';
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "Conflict",
      message,
    }), {
      status: 409,
      headers: { "content-type": "application/json" },
    })));

    await expect(api.delete("/api/admin/integrations/shared-github"))
      .rejects.toMatchObject({ status: 409, message });
  });
});
