import { describe, it, expect, vi } from "vitest";
import { validateGitHubConnection } from "../../src/agents/githubConnectionValidator.js";

function jsonResponse(status: number): Response {
  return new Response(status === 200 ? '{"login":"ve-bot"}' : "err", { status });
}

describe("validateGitHubConnection", () => {
  it("returns success and calls GET /user with a Bearer token", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(200));
    const result = await validateGitHubConnection(
      { token: "ghp_valid" },
      { fetch: fetch as unknown as typeof globalThis.fetch },
    );
    expect(result.success).toBe(true);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.github.com/user");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer ghp_valid",
    });
  });

  it("fails early when no token is provided — fetch is not called", async () => {
    const fetch = vi.fn();
    const result = await validateGitHubConnection(
      {},
      { fetch: fetch as unknown as typeof globalThis.fetch },
    );
    expect(result.success).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports 401 as invalid credentials", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(401));
    const result = await validateGitHubConnection(
      { token: "ghp_bad" },
      { fetch: fetch as unknown as typeof globalThis.fetch },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("invalid");
  });

  it("reports 403 as invalid credentials", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(403));
    const result = await validateGitHubConnection(
      { token: "ghp_bad" },
      { fetch: fetch as unknown as typeof globalThis.fetch },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("invalid");
  });

  it("uses a custom apiBaseUrl for GitHub Enterprise", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(200));
    await validateGitHubConnection(
      { token: "ghp_ent", apiBaseUrl: "https://github.example.com/api/v3" },
      { fetch: fetch as unknown as typeof globalThis.fetch },
    );
    const [url] = fetch.mock.calls[0]!;
    expect(url).toBe("https://github.example.com/api/v3/user");
  });

  it("returns failure on network error", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await validateGitHubConnection(
      { token: "ghp_test" },
      { fetch: fetch as unknown as typeof globalThis.fetch },
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("ECONNREFUSED");
  });
});
