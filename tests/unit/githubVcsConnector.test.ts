import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GitHubVcsConnector } from "../../src/vcs/githubVcsConnector.js";
import type { VcsConnector } from "../../src/vcs/vcsConnector.js";
import { jsonResponse, errorResponse } from "./helpers/fixtures.js";
import { RecordingGitRunner } from "./helpers/recordingGitRunner.js";

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
const BRANCH_PR_RESPONSE = {
  ...PR_RESPONSE,
  merged_at: null,
  head: { ref: "feature-task-1", repo: { full_name: `${OWNER}/${REPO}` } },
  base: { ref: "main", repo: { full_name: `${OWNER}/${REPO}` } },
};

function makeConnector(
  overrides?: Partial<ConstructorParameters<typeof GitHubVcsConnector>[0]>,
  gitRunner: RecordingGitRunner = makeGitRunner()
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
  }, gitRunner);
}

function makeGitRunner(): RecordingGitRunner {
  const gitRunner = new RecordingGitRunner();
  gitRunner.run.mockImplementation(async (args) => ({
    stdout: args[0] === "remote" && args[1] === "get-url"
      ? "https://github.com/octocat/hello-world.git\n"
      : "",
    stderr: "",
  }));
  return gitRunner;
}

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
      const gitRunner = makeGitRunner();
      const repoUrl =
        "https://x-access-token:ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345@github.com/octocat/hello-world.git";

      await makeConnector(undefined, gitRunner).clone(repoUrl, "main", "/tmp/repo");

      expect(gitRunner.run).toHaveBeenCalledWith(
        ["clone", "--branch", "main", "--depth", "1", "--", repoUrl, "/tmp/repo"],
        expect.any(Object)
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ repoUrl: "https://<redacted>@github.com/octocat/hello-world.git" }),
        "cloning repository from GitHub via HTTPS"
      );
    });

    it("accepts an explicit HTTPS default port", async () => {
      const gitRunner = makeGitRunner();
      const repoUrl = "https://github.com:443/octocat/hello-world.git";

      await makeConnector(undefined, gitRunner).clone(repoUrl, "main", "/tmp/repo");

      expect(gitRunner.run).toHaveBeenCalledWith(
        ["clone", "--branch", "main", "--depth", "1", "--", repoUrl, "/tmp/repo"],
        expect.any(Object)
      );
    });

    it("redacts credentials from clone failures", async () => {
      const gitRunner = makeGitRunner();
      const repoUrl =
        "https://x-access-token:ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345@github.com/octocat/hello-world.git";
      gitRunner.run.mockRejectedValueOnce(new Error(`fatal: unable to access '${repoUrl}'`));

      await expect(makeConnector(undefined, gitRunner).clone(repoUrl, "main", "/tmp/repo")).rejects.not.toThrow(
        /ghp_/
      );
    });

    it.each([
      ["/tmp/local-repo", "local path"],
      ["ext::sh -c whoami", "ext protocol"],
      ["-unsafe", "option-like value"],
      ["https://evil.example/octocat/hello-world.git", "unconfigured host"],
      ["http://github.com/octocat/hello-world.git", "insecure scheme"],
    ])("rejects %s (%s) before invoking git", async (repoUrl) => {
      const gitRunner = makeGitRunner();

      await expect(makeConnector(undefined, gitRunner).clone(repoUrl, "main", "/tmp/repo"))
        .rejects.toThrow();
      expect(gitRunner.run).not.toHaveBeenCalled();
    });
  });

  describe("getChangeStatus", () => {
    it("returns OPEN for open PRs", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(PR_RESPONSE));
      expect(await makeConnector().getChangeStatus("42")).toBe("OPEN");
    });

    describe("findExistingReview", () => {
      it.each([
        { state: "open", merged_at: null, status: "OPEN" },
        { state: "closed", merged_at: "2026-11-01T12:00:00Z", status: "MERGED" },
        { state: "closed", merged_at: null, status: "ABANDONED" },
      ])("recovers a $status PR without a push", async ({ state, merged_at, status }) => {
        const gitRunner = makeGitRunner();
        fetchMock.mockResolvedValueOnce(jsonResponse([{ ...BRANCH_PR_RESPONSE, state, merged_at }]));

        expect(await makeConnector(undefined, gitRunner).findExistingReview("feature-task-1"))
          .toEqual({ changeId: "42", url: PR_RESPONSE.html_url, status, targetBranch: "main" });
        expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
          `${API_BASE_URL}/repos/${OWNER}/${REPO}/pulls?state=all&head=octocat%3Afeature-task-1&per_page=2`,
          expect.objectContaining({ headers: expect.any(Object) }),
        );
        expect(gitRunner.run).not.toHaveBeenCalled();
      });

      it("returns the target branch the PR was actually opened against", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse([
          { ...BRANCH_PR_RESPONSE, base: { ref: "release", repo: { full_name: `${OWNER}/${REPO}` } } },
        ]));

        expect(await makeConnector().findExistingReview("feature-task-1"))
          .toMatchObject({ changeId: "42", targetBranch: "release" });
      });

      it("returns null when no PR exists instead of creating one", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse([]));

        expect(await makeConnector().findExistingReview("feature-task-1")).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      it.each(["main", "release"])("refuses several PRs from the branch (second targets %s)", async (base) => {
        fetchMock.mockResolvedValueOnce(jsonResponse([
          BRANCH_PR_RESPONSE,
          { ...BRANCH_PR_RESPONSE, number: 43, base: { ref: base, repo: { full_name: `${OWNER}/${REPO}` } } },
        ]));

        await expect(makeConnector().findExistingReview("feature-task-1")).rejects.toThrow("Ambiguous");
      });

      it.each([
        { ...BRANCH_PR_RESPONSE, head: { ref: "other", repo: { full_name: `${OWNER}/${REPO}` } } },
        { ...BRANCH_PR_RESPONSE, base: { ref: "main", repo: { full_name: `fork/${REPO}` } } },
        { ...BRANCH_PR_RESPONSE, head: { ref: "feature-task-1", repo: { full_name: `fork/${REPO}` } } },
        { ...BRANCH_PR_RESPONSE, number: 0 },
        { ...BRANCH_PR_RESPONSE, html_url: "invalid" },
        PR_RESPONSE,
      ])("refuses mismatched or malformed recovery responses", async (response) => {
        fetchMock.mockResolvedValueOnce(jsonResponse([response]));

        await expect(makeConnector().findExistingReview("feature-task-1")).rejects.toThrow();
      });

      it("compares repository slugs case-insensitively but source branches exactly", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse([{
          ...BRANCH_PR_RESPONSE,
          head: { ref: "feature-task-1", repo: { full_name: "Octocat/Hello-World" } },
          base: { ref: "main", repo: { full_name: "OCTOCAT/hello-world" } },
        }]));
        expect(await makeConnector().findExistingReview("feature-task-1")).toMatchObject({ changeId: "42" });

        fetchMock.mockResolvedValueOnce(jsonResponse([{
          ...BRANCH_PR_RESPONSE,
          head: { ref: "Feature-Task-1", repo: { full_name: `${OWNER}/${REPO}` } },
        }]));
        await expect(makeConnector().findExistingReview("feature-task-1")).rejects.toThrow("does not match");
      });

      it("refuses a PR whose head repository was deleted", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse([
          { ...BRANCH_PR_RESPONSE, head: { ref: "feature-task-1", repo: null } },
        ]));

        await expect(makeConnector().findExistingReview("feature-task-1")).rejects.toThrow("does not match");
      });

      it("uses the enterprise API and escapes the source branch", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse([]));

        await makeConnector({ apiBaseUrl: "https://ghe.example.test/api/v3" })
          .findExistingReview("feature/fix & test");

        expect(fetchMock).toHaveBeenCalledWith(
          "https://ghe.example.test/api/v3/repos/octocat/hello-world/pulls?state=all&head=octocat%3Afeature%2Ffix%20%26%20test&per_page=2",
          expect.any(Object),
        );
      });

      it("propagates API errors without returning an empty successful result", async () => {
        fetchMock.mockResolvedValueOnce(errorResponse(403, "Forbidden"));

        await expect(makeConnector().findExistingReview("feature-task-1")).rejects.toThrow();
      });
    });

    it("returns MERGED for merged PRs", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(PR_MERGED));
      expect(await makeConnector().getChangeStatus("42")).toBe("MERGED");
    });

    it("returns ABANDONED for closed (not merged) PRs", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(PR_CLOSED));
      expect(await makeConnector().getChangeStatus("42")).toBe("ABANDONED");
    });

    it.each([
      { state: "opened", merged: false },
      {},
      { state: "closed" },
      { state: "closed", merged: "false" },
    ])("rejects an unknown or malformed PR status: %j", async (status) => {
      fetchMock.mockResolvedValueOnce(jsonResponse(status));

      await expect(makeConnector().getChangeStatus("42")).rejects.toThrow();
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

  describe("review comments", () => {
    it("leaves PR comments to the repository-bound review connector", () => {
      // An empty-result implementation would hide feedback from ReviewProgressService.
      const connector: VcsConnector = makeConnector();

      expect(connector.getUnresolvedComments).toBeUndefined();
      expect(connector.resolveComments).toBeUndefined();
    });
  });

  describe("pushDirect (createOrFindPullRequest)", () => {
    function gitRunnerWithHead(subject: string, body = ""): RecordingGitRunner {
      const gitRunner = new RecordingGitRunner();
      gitRunner.run.mockImplementation(async (args) => ({
        stdout:
          args[0] === "remote" && args[1] === "get-url"
            ? "https://github.com/octocat/hello-world.git\n"
            : args[0] === "log" && args[2] === "--pretty=%s"
              ? subject
              : args[0] === "log" && args[2] === "--pretty=%b"
                ? body
                : "",
        stderr: "",
      }));
      return gitRunner;
    }

    it("reuses an existing PR when one exists for the head branch", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([PR_RESPONSE]));

      const result = await makeConnector(undefined, gitRunnerWithHead("Add feature X")).pushDirect(
        "/tmp/repo",
        "feature-x"
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

      const result = await makeConnector(
        undefined,
        gitRunnerWithHead("Add feature X", "Details here")
      ).pushDirect("/tmp/repo", "feature-x");

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

      await makeConnector({ targetBranch: "develop" }, gitRunnerWithHead("Subject")).pushDirect(
        "/tmp/repo",
        "feature-x"
      );

      const [, createInit] = fetchMock.mock.calls[1] as [string, RequestInit];
      const body = JSON.parse(createInit.body as string) as Record<string, string>;
      expect(body["base"]).toBe("develop");
    });

    it("sends Authorization Bearer token on PR creation", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([]));
      fetchMock.mockResolvedValueOnce(jsonResponse(PR_RESPONSE));

      await makeConnector(undefined, gitRunnerWithHead("Subject")).pushDirect("/tmp/repo", "feature-x");

      const [, createInit] = fetchMock.mock.calls[1] as [string, RequestInit];
      const headers = createInit.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
      expect(headers["Accept"]).toBe("application/vnd.github+json");
    });

    it("throws when PR creation returns non-OK", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([]));
      fetchMock.mockResolvedValueOnce(errorResponse(422, "Validation failed"));

      await expect(
        makeConnector(undefined, gitRunnerWithHead("Subject")).pushDirect("/tmp/repo", "feature-x")
      ).rejects.toThrow();
    });
  });
});
