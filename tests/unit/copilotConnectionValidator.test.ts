import { describe, expect, it, vi } from "vitest";
import { validateCopilotConnection } from "../../src/agents/copilotConnectionValidator.js";
import { encryptToken } from "../../src/utils/encryption.js";

const TEST_SECRET = "test-admin-auth-secret-for-validator";

function makeEncrypted(plainToken: string): string {
  return encryptToken(plainToken, TEST_SECRET);
}

function makeFetch(status: number) {
  return vi.fn(async (_url: string, _init?: RequestInit) => ({
    status,
    ok: status >= 200 && status < 300,
  })) as unknown as typeof globalThis.fetch;
}

describe("validateCopilotConnection", () => {
  it("returns success when GitHub API returns 200", async () => {
    const encrypted = makeEncrypted("ghp_test_token");
    const result = await validateCopilotConnection(
      { sessionToken: encrypted },
      { fetch: makeFetch(200), adminAuthSecret: TEST_SECRET }
    );

    expect(result).toEqual({ success: true, error: null, models: [] });
  });

  it("sends the decrypted token in the Authorization Bearer header", async () => {
    const mockFetch = makeFetch(200);
    const encrypted = makeEncrypted("ghp_my_key");

    await validateCopilotConnection(
      { sessionToken: encrypted },
      { fetch: mockFetch, adminAuthSecret: TEST_SECRET }
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

    const result = await validateCopilotConnection({}, { fetch: mockFetch, adminAuthSecret: TEST_SECRET });

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
      { fetch: mockFetch, adminAuthSecret: TEST_SECRET }
    );

    expect(result.success).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fails when adminAuthSecret is not provided", async () => {
    const encrypted = makeEncrypted("ghp_test");
    const result = await validateCopilotConnection(
      { sessionToken: encrypted },
      { fetch: makeFetch(200) }
    );

    expect(result).toEqual({
      success: false,
      error: "ADMIN_AUTH_SECRET is required to decrypt the session token.",
      models: [],
    });
  });

  it("returns failure for 401 Unauthorized", async () => {
    const encrypted = makeEncrypted("ghp_bad");
    const result = await validateCopilotConnection(
      { sessionToken: encrypted },
      { fetch: makeFetch(401), adminAuthSecret: TEST_SECRET }
    );

    expect(result).toEqual({
      success: false,
      error: "GitHub token is invalid or unauthorized.",
      models: [],
    });
  });

  it("returns failure for 403 Forbidden", async () => {
    const encrypted = makeEncrypted("ghp_bad");
    const result = await validateCopilotConnection(
      { sessionToken: encrypted },
      { fetch: makeFetch(403), adminAuthSecret: TEST_SECRET }
    );

    expect(result).toEqual({
      success: false,
      error: "GitHub token is invalid or unauthorized.",
      models: [],
    });
  });

  it("returns failure for unexpected HTTP status", async () => {
    const encrypted = makeEncrypted("ghp_test");
    const result = await validateCopilotConnection(
      { sessionToken: encrypted },
      { fetch: makeFetch(500), adminAuthSecret: TEST_SECRET }
    );

    expect(result).toEqual({
      success: false,
      error: "GitHub API returned unexpected status 500.",
      models: [],
    });
  });

  it("returns failure when fetch throws a network error", async () => {
    const mockFetch = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof globalThis.fetch;
    const encrypted = makeEncrypted("ghp_test");

    const result = await validateCopilotConnection(
      { sessionToken: encrypted },
      { fetch: mockFetch, adminAuthSecret: TEST_SECRET }
    );

    expect(result).toEqual({
      success: false,
      error: "ECONNREFUSED",
      models: [],
    });
  });

  it("returns failure when token decryption fails", async () => {
    const result = await validateCopilotConnection(
      { sessionToken: "not-valid-encrypted-data" },
      { fetch: makeFetch(200), adminAuthSecret: TEST_SECRET }
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  // ── PAT mode tests ─────────────────────────────────────────────────────────

  it("PAT mode: returns success when GitHub API returns 200", async () => {
    const result = await validateCopilotConnection(
      { authMode: "pat", token: "ghp_test_pat_token" },
      { fetch: makeFetch(200) }
    );

    expect(result).toEqual({ success: true, error: null, models: [] });
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

    expect(result).toEqual({ success: true, error: null, models: [] });
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
