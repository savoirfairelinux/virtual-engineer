import { describe, it, expect, vi } from "vitest";
import { validateCursorConnection } from "../../src/agents/cursorConnectionValidator.js";

function jsonResponse(status: number): Response {
  return new Response(status === 200 ? JSON.stringify({ apiKeyName: "CI Key" }) : "err", { status });
}

describe("validateCursorConnection", () => {
  it("returns success and calls the /v1/me identity endpoint with a bearer token", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(200));
    const result = await validateCursorConnection(
      { apiKey: "cursor-key" },
      { fetch: fetch as unknown as typeof globalThis.fetch }
    );
    expect(result.success).toBe(true);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.cursor.com/v1/me");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer cursor-key" });
  });

  it("fails when no api key is provided", async () => {
    const fetch = vi.fn();
    const result = await validateCursorConnection(
      {},
      { fetch: fetch as unknown as typeof globalThis.fetch }
    );
    expect(result.success).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports 401 as invalid", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(401));
    const result = await validateCursorConnection(
      { apiKey: "bad" },
      { fetch: fetch as unknown as typeof globalThis.fetch }
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("invalid");
  });

  it("reports an unexpected status", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(500));
    const result = await validateCursorConnection(
      { apiKey: "key" },
      { fetch: fetch as unknown as typeof globalThis.fetch }
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("500");
  });

  it("reports network errors", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("network down"));
    const result = await validateCursorConnection(
      { apiKey: "key" },
      { fetch: fetch as unknown as typeof globalThis.fetch }
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("network down");
  });
});
