import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  startGitHubDeviceFlow,
  pollGitHubDeviceToken,
  fetchGitHubCurrentUser,
  resolveGitHubUrls,
  GitHubAuthError,
} from "../../src/utils/githubAuth.js";
import { jsonResponse, errorResponse } from "./helpers/fixtures.js";

describe("githubAuth", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ─── resolveGitHubUrls ──────────────────────────────────────────────────────

  describe("resolveGitHubUrls", () => {
    it("returns github.com URLs for github.com mode", () => {
      const urls = resolveGitHubUrls("github.com");
      expect(urls.webBaseUrl).toBe("https://github.com");
      expect(urls.apiBaseUrl).toBe("https://api.github.com");
    });

    it("returns enterprise URLs for github-enterprise mode", () => {
      const urls = resolveGitHubUrls("github-enterprise", "https://github.example.com");
      expect(urls.webBaseUrl).toBe("https://github.example.com");
      expect(urls.apiBaseUrl).toBe("https://github.example.com/api/v3");
    });

    it("strips trailing slashes from enterprise URL", () => {
      const urls = resolveGitHubUrls("github-enterprise", "https://github.example.com/");
      expect(urls.webBaseUrl).toBe("https://github.example.com");
      expect(urls.apiBaseUrl).toBe("https://github.example.com/api/v3");
    });

    it("throws when enterprise mode has no customBaseUrl", () => {
      expect(() => resolveGitHubUrls("github-enterprise")).toThrow(
        "customBaseUrl is required for github-enterprise mode"
      );
    });
  });

  // ─── startGitHubDeviceFlow ──────────────────────────────────────────────────

  describe("startGitHubDeviceFlow", () => {
    it("calls POST /login/device/code and returns device flow response", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          device_code: "dc-123",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          interval: 5,
          expires_in: 900,
        })
      );

      const result = await startGitHubDeviceFlow("client-id-1", "https://github.com");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://github.com/login/device/code");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body as string);
      expect(body.client_id).toBe("client-id-1");
      expect(body.scope).toBe("repo");

      expect(result.deviceCode).toBe("dc-123");
      expect(result.userCode).toBe("ABCD-1234");
      expect(result.verificationUri).toBe("https://github.com/login/device");
      expect(result.interval).toBe(5);
      expect(result.expiresIn).toBe(900);
    });

    it("throws GitHubAuthError on non-OK response", async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(401, "Unauthorized"));

      await expect(
        startGitHubDeviceFlow("client-id-1", "https://github.com")
      ).rejects.toThrow(GitHubAuthError);
    });
  });

  // ─── pollGitHubDeviceToken ──────────────────────────────────────────────────

  describe("pollGitHubDeviceToken", () => {
    it("returns success with token on successful poll", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          access_token: "gho_abc123",
          token_type: "bearer",
          scope: "repo",
        })
      );

      const result = await pollGitHubDeviceToken(
        "client-id-1",
        "dc-123",
        "https://github.com"
      );

      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.token.accessToken).toBe("gho_abc123");
        expect(result.token.tokenType).toBe("bearer");
        expect(result.token.scope).toBe("repo");
      }
    });

    it("returns pending when authorization_pending", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          error: "authorization_pending",
          error_description: "User has not yet entered the code",
        })
      );

      const result = await pollGitHubDeviceToken(
        "client-id-1",
        "dc-123",
        "https://github.com"
      );

      expect(result.status).toBe("pending");
    });

    it("returns slow_down with new interval", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          error: "slow_down",
          interval: 10,
        })
      );

      const result = await pollGitHubDeviceToken(
        "client-id-1",
        "dc-123",
        "https://github.com"
      );

      expect(result.status).toBe("slow_down");
      if (result.status === "slow_down") {
        expect(result.interval).toBe(10);
      }
    });

    it("returns expired when token expired", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          error: "expired_token",
          error_description: "The device code has expired",
        })
      );

      const result = await pollGitHubDeviceToken(
        "client-id-1",
        "dc-123",
        "https://github.com"
      );

      expect(result.status).toBe("expired");
    });

    it("returns error for unknown error codes", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          error: "access_denied",
          error_description: "User denied access",
        })
      );

      const result = await pollGitHubDeviceToken(
        "client-id-1",
        "dc-123",
        "https://github.com"
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error).toBe("User denied access");
      }
    });

    it("throws GitHubAuthError on HTTP failure", async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(500, "Server Error"));

      await expect(
        pollGitHubDeviceToken("client-id-1", "dc-123", "https://github.com")
      ).rejects.toThrow(GitHubAuthError);
    });
  });

  // ─── fetchGitHubCurrentUser ─────────────────────────────────────────────────

  describe("fetchGitHubCurrentUser", () => {
    it("fetches current user with Bearer token", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ id: 12345, login: "ve-bot" })
      );

      const user = await fetchGitHubCurrentUser("gho_abc123", "https://api.github.com");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.github.com/user");
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer gho_abc123");

      expect(user.id).toBe(12345);
      expect(user.login).toBe("ve-bot");
    });

    it("throws GitHubAuthError on non-OK response", async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(401, "Bad credentials"));

      await expect(
        fetchGitHubCurrentUser("bad-token", "https://api.github.com")
      ).rejects.toThrow(GitHubAuthError);
    });
  });
});
