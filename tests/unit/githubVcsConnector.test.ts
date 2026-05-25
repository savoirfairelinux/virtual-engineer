import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  GitHubVcsConnector,
  GitHubVcsError,
} from "../../src/vcs/githubVcsConnector.js";
import { jsonResponse, errorResponse } from "./helpers/fixtures.js";

const API_BASE_URL = "https://api.github.com";
const HOST = "github.com";
const OWNER = "octocat";
const REPO = "hello-world";
const TOKEN = "ghp_test-token";

function makeConnector(
  overrides?: Partial<ConstructorParameters<typeof GitHubVcsConnector>[0]>
) {
  return new GitHubVcsConnector({
    apiBaseUrl: API_BASE_URL,
    host: HOST,
    owner: OWNER,
    repo: REPO,
    token: TOKEN,
    ...overrides,
  });
}

// Mock child_process.execFile
vi.mock("child_process", () => ({
  execFile: vi.fn((_cmd, _args, _opts, cb) => {
    if (typeof _opts === "function") {
      _opts(null, "", "");
    } else if (cb) {
      cb(null, "", "");
    }
  }),
}));

describe("GitHubVcsConnector", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ─── pushBranch ───────────────────────────────────────────────────────────

  describe("pushBranch", () => {
    it("constructs correct push URL with token", async () => {
      const { execFile } = await import("child_process");
      const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;

      await makeConnector().pushBranch("/tmp/repo", "feature-branch");

      expect(execFileMock).toHaveBeenCalled();
      const [cmd, args] = execFileMock.mock.calls[execFileMock.mock.calls.length - 1] as [string, string[]];
      expect(cmd).toBe("git");
      expect(args[0]).toBe("push");
      expect(args[1]).toContain("x-access-token:");
      expect(args[1]).toContain(TOKEN);
      expect(args[1]).toContain(`${HOST}/${OWNER}/${REPO}.git`);
      expect(args[2]).toBe("feature-branch");
    });

    it("uses enterprise host when configured", async () => {
      const { execFile } = await import("child_process");
      const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;

      await makeConnector({ host: "github.corp.com" }).pushBranch("/tmp/repo", "my-branch");

      const args = execFileMock.mock.calls[execFileMock.mock.calls.length - 1]?.[1] as string[];
      expect(args[1]).toContain("github.corp.com");
    });
  });

  // ─── createPullRequest ────────────────────────────────────────────────────

  describe("createPullRequest", () => {
    it("creates a PR and returns URL + number", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          html_url: "https://github.com/octocat/hello-world/pull/99",
          number: 99,
        })
      );

      const result = await makeConnector().createPullRequest({
        title: "feat: add logging",
        body: "Implements structured logging",
        head: "feature-branch",
        base: "main",
      });

      expect(result.url).toBe("https://github.com/octocat/hello-world/pull/99");
      expect(result.number).toBe(99);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/repos/octocat/hello-world/pulls");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body as string);
      expect(body.title).toBe("feat: add logging");
      expect(body.head).toBe("feature-branch");
      expect(body.base).toBe("main");
    });

    it("throws GitHubVcsError on failure", async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(422, "Validation Failed"));

      await expect(
        makeConnector().createPullRequest({
          title: "test",
          body: "",
          head: "x",
          base: "main",
        })
      ).rejects.toThrow(GitHubVcsError);
    });
  });

  // ─── requestReview ────────────────────────────────────────────────────────

  describe("requestReview", () => {
    it("requests reviewers on a PR", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ requested_reviewers: [] }));

      await makeConnector().requestReview(99, ["alice", "bob"]);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/pulls/99/requested_reviewers");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string).reviewers).toEqual(["alice", "bob"]);
    });

    it("throws GitHubVcsError on failure", async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(422, "Validation Failed"));
      await expect(makeConnector().requestReview(99, ["x"])).rejects.toThrow(GitHubVcsError);
    });
  });

  // ─── closePullRequest ─────────────────────────────────────────────────────

  describe("closePullRequest", () => {
    it("patches PR state to closed", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ number: 99, state: "closed" }));

      await makeConnector().closePullRequest(99);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/pulls/99");
      expect(init.method).toBe("PATCH");
      expect(JSON.parse(init.body as string).state).toBe("closed");
    });

    it("throws GitHubVcsError on failure", async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(404, "Not Found"));
      await expect(makeConnector().closePullRequest(99)).rejects.toThrow(GitHubVcsError);
    });
  });

  // ─── GitHubVcsError ───────────────────────────────────────────────────────

  describe("GitHubVcsError", () => {
    it("includes status, url, body in message", () => {
      const err = new GitHubVcsError(422, "https://api.github.com/repos/x/y/pulls", "Failed");
      expect(err.message).toContain("422");
      expect(err.name).toBe("GitHubVcsError");
    });
  });
});
