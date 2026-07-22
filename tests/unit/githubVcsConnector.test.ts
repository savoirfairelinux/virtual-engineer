import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { GitHubVcsConnector } from "../../src/vcs/githubVcsConnector.js";
import { jsonResponse, errorResponse } from "./helpers/fixtures.js";

const { logger } = vi.hoisted(() => ({
  logger: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock("../../src/logger.js", () => ({
  getLogger: vi.fn(() => logger),
}));

const API_BASE_URL = "https://api.github.com";
const HOST = "github.com";
const OWNER = "octocat";
const REPO = "hello-world";
const TOKEN = "ghp_test-token";

const PR_RESPONSE = {
  number: 42,
  html_url: "https://github.com/octocat/hello-world/pull/42",
  state: "open",
  merged: false,
};

const PR_MERGED = { ...PR_RESPONSE, state: "closed", merged: true };
const PR_CLOSED = { ...PR_RESPONSE, state: "closed", merged: false };

function makeConnector(
  overrides?: Partial<ConstructorParameters<typeof GitHubVcsConnector>[0]>
) {
  return new GitHubVcsConnector({
    apiBaseUrl: API_BASE_URL,
    host: HOST,
    owner: OWNER,
    repo: REPO,
    token: TOKEN,
    gitAuthorName: "Virtual Engineer",
    gitAuthorEmail: "ve@virtual-engineer.local",
    ...overrides,
  });
}

vi.mock("child_process", () => ({
  execFile: vi.fn((_cmd, _args, _opts, cb) => {
    const callback = typeof _opts === "function" ? _opts : cb;
    if (callback) callback(null, "", "");
  }),
  execFileSync: vi.fn(() => "https://github.com/octocat/hello-world.git\n"),
}));

describe("GitHubVcsConnector", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe("static contract", () => {
    it("declares useChangeIdContinuity=false and reviewSystemLabel=github", () => {
      const c = makeConnector();
      expect(c.useChangeIdContinuity).toBe(false);
      expect(c.reviewSystemLabel).toBe("github");
    });

    it("buildPushSpec returns feature-<taskId> ref without topic when no ticketTitle is given", () => {
      const spec = makeConnector().buildPushSpec("main", "task-123");
      expect(spec).toEqual({ ref: "feature-task-123" });
    });

    it("buildPushSpec uses a slug from ticketTitle when provided", () => {
      const spec = makeConnector().buildPushSpec("main", "b7ddee79-cc3b-4208-815c-70fcf177a49e", "Add login button");
      expect(spec).toEqual({ ref: "feature/b7ddee79-add-login-button" });
    });

    it("buildPushSpec falls back to legacy ref when ticketTitle is empty", () => {
      const spec = makeConnector().buildPushSpec("main", "task-123", "");
      expect(spec).toEqual({ ref: "feature-task-123" });
    });
  });

  describe("clone", () => {
    it("redacts credentials from logs without changing the Git command", async () => {
      const repoUrl =
        "https://x-access-token:ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345@github.com/octocat/hello-world.git";

      await makeConnector().clone(repoUrl, "main", "/tmp/repo");

      expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
        "git",
        ["clone", "--branch", "main", "--depth", "1", repoUrl, "/tmp/repo"],
        expect.any(Object)
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ repoUrl: "https://<redacted>@github.com/octocat/hello-world.git" }),
        "cloning repository from GitHub via HTTPS"
      );
    });

    it("redacts credentials from clone failures", async () => {
      const repoUrl =
        "https://x-access-token:ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345@github.com/octocat/hello-world.git";
      vi.mocked(execFileSync).mockImplementationOnce(() => {
        throw new Error(`fatal: unable to access '${repoUrl}'`);
      });

      await expect(makeConnector().clone(repoUrl, "main", "/tmp/repo")).rejects.not.toThrow(
        /ghp_/
      );
    });
  });

  describe("getChangeStatus", () => {
    it("returns OPEN for open PRs", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(PR_RESPONSE));
      expect(await makeConnector().getChangeStatus("42")).toBe("OPEN");
    });

    it("returns MERGED for merged PRs", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(PR_MERGED));
      expect(await makeConnector().getChangeStatus("42")).toBe("MERGED");
    });

    it("returns ABANDONED for closed (not merged) PRs", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(PR_CLOSED));
      expect(await makeConnector().getChangeStatus("42")).toBe("ABANDONED");
    });

    it("uses the configured apiBaseUrl for enterprise", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(PR_RESPONSE));
      await makeConnector({ apiBaseUrl: "https://ghe.corp.com/api/v3" }).getChangeStatus("42");
      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toBe("https://ghe.corp.com/api/v3/repos/octocat/hello-world/pulls/42");
    });

    it("propagates HTTP errors via ReviewApiError", async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(404, "Not Found"));
      await expect(makeConnector().getChangeStatus("42")).rejects.toThrow();
    });
  });

  describe("getUnresolvedComments / resolveComments", () => {
    it("getUnresolvedComments always returns [] (handled by ReviewConnector)", async () => {
      expect(await makeConnector().getUnresolvedComments("42")).toEqual([]);
    });

    it("resolveComments is a no-op (handled by ReviewConnector)", async () => {
      await expect(makeConnector().resolveComments("42", [])).resolves.toBeUndefined();
    });
  });

  describe("push (createOrFindPullRequest)", () => {
    it("reuses an existing PR when one exists for the head branch", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([PR_RESPONSE]));

      const result = await makeConnector().push(
        "/tmp/repo",
        "feature-x",
        "Add feature X"
      );

      expect(result.changeId).toBe("42");
      expect(result.url).toBe(PR_RESPONSE.html_url);
      expect(result.status).toBe("OPEN");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [listUrl] = fetchMock.mock.calls[0] as [string];
      expect(listUrl).toContain("/pulls?state=open&head=");
      expect(listUrl).toContain(`${OWNER}%3Afeature-x`);
    });

    it("creates a new PR when none exists", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([]));
      fetchMock.mockResolvedValueOnce(jsonResponse(PR_RESPONSE));

      const result = await makeConnector().push(
        "/tmp/repo",
        "feature-x",
        "Add feature X\n\nDetails here"
      );

      expect(result.changeId).toBe("42");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [createUrl, createInit] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(createUrl).toBe(`${API_BASE_URL}/repos/${OWNER}/${REPO}/pulls`);
      expect(createInit.method).toBe("POST");
      const body = JSON.parse(createInit.body as string) as Record<string, string>;
      expect(body["title"]).toBe("Add feature X");
      expect(body["head"]).toBe("feature-x");
      expect(body["base"]).toBe("main");
    });

    it("uses the configured targetBranch when set", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([]));
      fetchMock.mockResolvedValueOnce(jsonResponse(PR_RESPONSE));

      await makeConnector({ targetBranch: "develop" }).push(
        "/tmp/repo",
        "feature-x",
        "Subject"
      );

      const [, createInit] = fetchMock.mock.calls[1] as [string, RequestInit];
      const body = JSON.parse(createInit.body as string) as Record<string, string>;
      expect(body["base"]).toBe("develop");
    });

    it("sends Authorization Bearer token on PR creation", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([]));
      fetchMock.mockResolvedValueOnce(jsonResponse(PR_RESPONSE));

      await makeConnector().push("/tmp/repo", "feature-x", "Subject");

      const [, createInit] = fetchMock.mock.calls[1] as [string, RequestInit];
      const headers = createInit.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
      expect(headers["Accept"]).toBe("application/vnd.github+json");
    });

    it("throws when PR creation returns non-OK", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([]));
      fetchMock.mockResolvedValueOnce(errorResponse(422, "Validation failed"));

      await expect(
        makeConnector().push("/tmp/repo", "feature-x", "Subject")
      ).rejects.toThrow();
    });
  });
});
