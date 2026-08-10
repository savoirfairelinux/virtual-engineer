import { describe, expect, it, vi } from "vitest";
import { validateCopilotConnection } from "../../src/agents/copilotConnectionValidator.js";

function makeFetch(status: number) {
  return vi.fn(async (_url: string, _init?: RequestInit) => ({
    status,
    ok: status >= 200 && status < 300,
  })) as unknown as typeof globalThis.fetch;
}

describe("validateCopilotConnection", () => {
  it("returns success when GitHub API returns 200", async () => {
    const result = await validateCopilotConnection(
      { sessionToken: "ghp_test_token" },
      { fetch: makeFetch(200) }
    );

    expect(result).toEqual(expect.objectContaining({ success: true, error: null, models: [] }));
  });

  it("sends the session token in the Authorization Bearer header", async () => {
    const mockFetch = makeFetch(200);

    await validateCopilotConnection(
      { sessionToken: "ghp_my_key" },
      { fetch: mockFetch }
    );

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/user",
      expect.objectContaining({
        headers: expect.objectContaining({
          "Authorization": "Bearer ghp_my_key",
        }),
      })
    );
  });

  it("fails early when no session token is provided", async () => {
    const mockFetch = makeFetch(200);

    const result = await validateCopilotConnection({}, { fetch: mockFetch });

    expect(result).toEqual({
      success: false,
      error: "No session token configured. Use the OAuth device flow to authenticate.",
      models: [],
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fails early when session token is only whitespace", async () => {
    const mockFetch = makeFetch(200);

    const result = await validateCopilotConnection(
      { sessionToken: "   " },
      { fetch: mockFetch }
    );

    expect(result.success).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns failure for 401 Unauthorized", async () => {
    const result = await validateCopilotConnection(
      { sessionToken: "ghp_bad" },
      { fetch: makeFetch(401) }
    );

    expect(result).toEqual({
      success: false,
      error: "GitHub token is invalid or unauthorized.",
      models: [],
    });
  });

  it("returns failure for 403 Forbidden", async () => {
    const result = await validateCopilotConnection(
      { sessionToken: "ghp_bad" },
      { fetch: makeFetch(403) }
    );

    expect(result).toEqual({
      success: false,
      error: "GitHub token is invalid or unauthorized.",
      models: [],
    });
  });

  it("returns failure for unexpected HTTP status", async () => {
    const result = await validateCopilotConnection(
      { sessionToken: "ghp_test" },
      { fetch: makeFetch(500) }
    );

    expect(result).toEqual({
      success: false,
      error: "GitHub API returned unexpected status 500.",
      models: [],
    });
  });

  it("returns failure when fetch throws a network error", async () => {
    const mockFetch = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof globalThis.fetch;

    const result = await validateCopilotConnection(
      { sessionToken: "ghp_test" },
      { fetch: mockFetch }
    );

    expect(result).toEqual({
      success: false,
      error: "ECONNREFUSED",
      models: [],
    });
  });

  // ── PAT mode tests ─────────────────────────────────────────────────────────

  it("PAT mode: returns success when GitHub API returns 200", async () => {
    const result = await validateCopilotConnection(
      { authMode: "pat", token: "ghp_test_pat_token" },
      { fetch: makeFetch(200) }
    );

    expect(result).toEqual(expect.objectContaining({ success: true, error: null, models: [] }));
  });

  it("PAT mode: sends the PAT directly in the Authorization Bearer header", async () => {
    const mockFetch = makeFetch(200);

    await validateCopilotConnection(
      { authMode: "pat", token: "ghp_my_pat" },
      { fetch: mockFetch }
    );

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/user",
      expect.objectContaining({
        headers: expect.objectContaining({
          "Authorization": "Bearer ghp_my_pat",
        }),
      })
    );
  });

  it("PAT mode: fails early when no token is provided", async () => {
    const mockFetch = makeFetch(200);

    const result = await validateCopilotConnection(
      { authMode: "pat" },
      { fetch: mockFetch }
    );

    expect(result).toEqual({
      success: false,
      error: "No Personal Access Token provided. Paste your GitHub PAT in the token field.",
      models: [],
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("PAT mode: fails early when token is only whitespace", async () => {
    const mockFetch = makeFetch(200);

    const result = await validateCopilotConnection(
      { authMode: "pat", token: "   " },
      { fetch: mockFetch }
    );

    expect(result.success).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("PAT mode: does not require adminAuthSecret", async () => {
    const result = await validateCopilotConnection(
      { authMode: "pat", token: "ghp_works_without_secret" },
      { fetch: makeFetch(200) }
    );

    expect(result).toEqual(expect.objectContaining({ success: true, error: null, models: [] }));
  });

  it("PAT mode: returns failure for 401 Unauthorized", async () => {
    const result = await validateCopilotConnection(
      { authMode: "pat", token: "ghp_bad" },
      { fetch: makeFetch(401) }
    );

    expect(result).toEqual({
      success: false,
      error: "GitHub token is invalid or unauthorized.",
      models: [],
    });
  });

  it("PAT mode: returns failure for network error", async () => {
    const mockFetch = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof globalThis.fetch;

    const result = await validateCopilotConnection(
      { authMode: "pat", token: "ghp_test" },
      { fetch: mockFetch }
    );

    expect(result).toEqual({
      success: false,
      error: "ECONNREFUSED",
      models: [],
    });
  });
});
