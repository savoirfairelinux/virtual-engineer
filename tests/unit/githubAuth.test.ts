import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  startGitHubDeviceFlow,
  pollGitHubDeviceToken,
  fetchGitHubCurrentUser,
  resolveGitHubUrls,
  listGitHubRepositoriesForOwner,
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

  describe("listGitHubRepositoriesForOwner", () => {
    function repo(name: string) {
      return {
        full_name: `acme/${name}`,
        name,
        html_url: `https://github.com/acme/${name}`,
        clone_url: `https://github.com/acme/${name}.git`,
        ssh_url: `git@github.com:acme/${name}.git`,
        default_branch: "main",
      };
    }
    function pageResponse(data: unknown, nextUrl?: string): Response {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (nextUrl) headers["Link"] = `<${nextUrl}>; rel="next", <https://x/last>; rel="last"`;
      return new Response(JSON.stringify(data), { status: 200, headers });
    }

    it("hits /orgs first and returns the repos when the owner is an org", async () => {
      fetchMock.mockResolvedValueOnce(pageResponse([repo("alpha"), repo("beta")]));

      const result = await listGitHubRepositoriesForOwner("tok", "https://api.github.com", "acme");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.github.com/orgs/acme/repos?per_page=100&type=all");
      expect(result.map((r) => r.name)).toEqual(["alpha", "beta"]);
      expect(result[0]?.fullName).toBe("acme/alpha");
      expect(result[0]?.cloneUrl).toBe("https://github.com/acme/alpha.git");
      expect(result[0]?.sshUrl).toBe("git@github.com:acme/alpha.git");
      expect(result[0]?.defaultBranch).toBe("main");
    });

    it("falls back to /users when /orgs returns 404 (personal account)", async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(404, "Not Found"));
      fetchMock.mockResolvedValueOnce(pageResponse([repo("solo")]));

      const result = await listGitHubRepositoriesForOwner("tok", "https://api.github.com", "acme");

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [secondUrl] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(secondUrl).toBe("https://api.github.com/users/acme/repos?per_page=100&type=owner");
      expect(result.map((r) => r.name)).toEqual(["solo"]);
    });

    it("follows Link rel=next pagination across pages", async () => {
      fetchMock.mockResolvedValueOnce(pageResponse([repo("p1a"), repo("p1b")], "https://api.github.com/page2"));
      fetchMock.mockResolvedValueOnce(pageResponse([repo("p2a")]));

      const result = await listGitHubRepositoriesForOwner("tok", "https://api.github.com", "acme");

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect((fetchMock.mock.calls[1] as [string])[0]).toBe("https://api.github.com/page2");
      expect(result.map((r) => r.name)).toEqual(["p1a", "p1b", "p2a"]);
    });

    it("throws when the owner is neither user nor org (both 404)", async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(404, ""));
      fetchMock.mockResolvedValueOnce(errorResponse(404, ""));

      await expect(
        listGitHubRepositoriesForOwner("tok", "https://api.github.com", "ghost"),
      ).rejects.toThrow(/was not found/);
    });

    it("throws on /orgs non-404 error without falling back", async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(500, "boom"));

      await expect(
        listGitHubRepositoriesForOwner("tok", "https://api.github.com", "acme"),
      ).rejects.toThrow(/List org repositories failed \(500\)/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("sends Bearer auth header and GitHub Accept on every request", async () => {
      fetchMock.mockResolvedValueOnce(pageResponse([repo("alpha")], "https://api.github.com/page2"));
      fetchMock.mockResolvedValueOnce(pageResponse([repo("beta")]));

      await listGitHubRepositoriesForOwner("secret-token", "https://api.github.com", "acme");

      for (const call of fetchMock.mock.calls) {
        const init = (call as [string, RequestInit])[1];
        const headers = init.headers as Record<string, string>;
        expect(headers.Authorization).toBe("Bearer secret-token");
        expect(headers.Accept).toBe("application/vnd.github+json");
      }
    });
  });
});
