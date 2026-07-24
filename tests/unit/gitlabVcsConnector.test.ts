/**
 * Test suite for GitLabVcsConnector.
 * Tests clone and push operations to GitLab.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitLabVcsConnector } from "../../src/vcs/gitlabVcsConnector.js";
import type { GitLabVcsConnectorConfig } from "../../src/vcs/gitlabVcsConnector.js";
import { ReviewApiError } from "../../src/interfaces.js";
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

vi.mock("../../src/connectors/gitlabHttpClient.js", () => {
  const GitLabHttpClient = vi.fn().mockImplementation(function () {
    return {
      fetchJson: vi.fn(),
      fetchJsonVoid: vi.fn(),
    };
  });
  return { GitLabHttpClient };
});

const mockConfig: GitLabVcsConnectorConfig = {
  baseUrl: "https://gitlab.example.com",
  projectId: "my-project",
  token: "glpat-xxx",
  gitAuthorName: "Virtual Engineer",
  gitAuthorEmail: "ve@example.com",
};

/** Access the private httpClient mock on a connector instance. */
function getHttpClient(c: GitLabVcsConnector) {
  return (c as any).httpClient as { fetchJson: ReturnType<typeof vi.fn>; fetchJsonVoid: ReturnType<typeof vi.fn> };
}

describe("GitLabVcsConnector", () => {
  let connector: GitLabVcsConnector;
  let gitRunner: RecordingGitRunner;

  beforeEach(() => {
    gitRunner = new RecordingGitRunner();
    gitRunner.run.mockImplementation(async (args) => ({
      stdout: args[0] === "remote" && args[1] === "get-url"
        ? "https://gitlab.example.com/my-project.git"
        : "",
      stderr: "",
    }));
    connector = new GitLabVcsConnector(mockConfig, gitRunner);
    vi.clearAllMocks();
  });

  describe("clone", () => {
    it("should execute git clone with correct parameters", async () => {
      const repoUrl = "https://gitlab.example.com/my-project.git";
      const branch = "main";
      const targetDir = "/tmp/workspace/repo";

      await connector.clone(repoUrl, branch, targetDir);

      expect(gitRunner.run).toHaveBeenCalledWith(
        ["clone", "--branch", branch, "--depth", "1", repoUrl, targetDir],
        expect.any(Object)
      );
    });

    it("redacts credentials from clone logs without changing the Git command", async () => {
      const repoUrl =
        "https://oauth2:glpat-secret@gitlab.example.com/my-project.git";

      await connector.clone(repoUrl, "main", "/tmp/repo");

      expect(gitRunner.run).toHaveBeenCalledWith(
        ["clone", "--branch", "main", "--depth", "1", repoUrl, "/tmp/repo"],
        expect.any(Object)
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ repoUrl: "https://<redacted>@gitlab.example.com/my-project.git" }),
        "cloning repository from GitLab via HTTP"
      );
    });

    it("should throw on clone failure", async () => {
      gitRunner.run.mockRejectedValueOnce(new Error("Network error"));

      await expect(
        connector.clone("https://invalid.com/repo.git", "main", "/tmp/repo")
      ).rejects.toThrow("Failed to clone GitLab repository");
    });

    it("redacts credentials echoed in clone failures", async () => {
      const repoUrl = "https://oauth2:glpat-secret@gitlab.example.com/my-project.git";
      gitRunner.run.mockRejectedValueOnce(new Error(`fatal: unable to access '${repoUrl}'`));

      await expect(connector.clone(repoUrl, "main", "/tmp/repo")).rejects.not.toThrow(
        /glpat-secret/
      );
    });
  });

  describe("push", () => {
    it("should perform git operations in sequence and create MR", async () => {
      const httpClient = getHttpClient(connector);
      httpClient.fetchJson.mockResolvedValue({ iid: 1, web_url: "https://gitlab.example.com/mr/1" });

      const repoDir = "/tmp/workspace/repo";
      const message = "feat: add new feature";
      const featureBranch = "feature-new";

      const result = await connector.push(repoDir, featureBranch, message);

      const calls = gitRunner.run.mock.calls.map((call) => call[0]);
      expect(calls).toContainEqual(["config", "user.name", mockConfig.gitAuthorName]);
      expect(calls).toContainEqual(["config", "user.email", mockConfig.gitAuthorEmail]);
      expect(calls).toContainEqual(["add", "-A"]);
      expect(calls).toContainEqual(["commit", "-m", message]);
      expect(result.changeId).toBe("1");
      expect(result.url).toBe("https://gitlab.example.com/mr/1");
    });

    it("should handle push errors gracefully", async () => {
      gitRunner.run.mockImplementation(async (args) => {
        if (args[0] === "push") {
          throw new Error("Permission denied");
        }
        return {
          stdout: args[0] === "remote" && args[1] === "get-url"
            ? "https://gitlab.example.com/my-project.git"
            : "",
          stderr: "",
        };
      });

      await expect(
        connector.push("/tmp/workspace/repo", "feature-test", "feat: test")
      ).rejects.toThrow("Failed to push to GitLab");
    });

    it("passes branch names as standalone git arguments", async () => {
      const httpClient = getHttpClient(connector);
      httpClient.fetchJson.mockResolvedValue({ iid: 2, web_url: "https://gitlab.example.com/mr/2" });

      await connector.push("/tmp/workspace/repo", "feature/test-123", "feat: add new feature");

      expect(gitRunner.run).toHaveBeenCalledWith(
        ["push", "-u", "origin", "feature/test-123"],
        expect.any(Object)
      );
    });
  });

  describe("getChangeStatus", () => {
    it("returns the uppercased MR state on success", async () => {
      const httpClient = getHttpClient(connector);
      httpClient.fetchJson.mockResolvedValue({ state: "opened" });

      const status = await connector.getChangeStatus("42");
      expect(status).toBe("OPENED");
    });

    it("returns UNKNOWN on API error", async () => {
      const httpClient = getHttpClient(connector);
      httpClient.fetchJson.mockRejectedValue(new ReviewApiError(404, "/api/v4/projects/x/merge_requests/99", "Not Found"));

      const status = await connector.getChangeStatus("99");
      expect(status).toBe("UNKNOWN");
    });
  });

  describe("pushDirect", () => {
    it("force-pushes to feature branch and creates MR", async () => {
      gitRunner.run.mockImplementation(async (args) => {
        const stdout = args[0] === "remote" && args[1] === "get-url"
          ? "https://gitlab.example.com/my-project.git"
          : args[0] === "log" && args[1] === "-1"
            ? "feat: multi-commit feature"
            : "";
        return { stdout, stderr: "" };
      });
      const httpClient = getHttpClient(connector);
      httpClient.fetchJson.mockResolvedValue({ iid: 5, web_url: "https://gitlab.example.com/mr/5" });

      const result = await connector.pushDirect("/tmp/workspace/repo", "feature-TASK-1");

      // Verify git operations: checkout -B, push --force
      expect(gitRunner.run).toHaveBeenCalledWith(
        ["checkout", "-B", "feature-TASK-1"],
        expect.any(Object)
      );
      expect(gitRunner.run).toHaveBeenCalledWith(
        ["push", "--force", "-u", "origin", "feature-TASK-1"],
        expect.any(Object)
      );
      expect(result.changeId).toBe("5");
    });

    it("resets remote URL after push to avoid token leak", async () => {
      const remoteUrl = "https://gitlab.example.com/my-project.git";
      const setUrlCalls: string[][] = [];

      gitRunner.run.mockImplementation(async (args) => {
        if (args[0] === "remote" && args[1] === "set-url") {
          setUrlCalls.push([...args]);
        }
        const stdout = args[0] === "remote" && args[1] === "get-url"
          ? remoteUrl
          : args[0] === "log" && args[1] === "-1"
            ? "feat: test"
            : "";
        return { stdout, stderr: "" };
      });
      const httpClient = getHttpClient(connector);
      httpClient.fetchJson.mockResolvedValue({ iid: 6, web_url: "https://gitlab.example.com/mr/6" });

      await connector.pushDirect("/tmp/workspace/repo", "feature-TASK-2");

      // First set-url adds token, second should reset to original
      expect(setUrlCalls).toHaveLength(2);
      expect(setUrlCalls[1]![3]).toBe(remoteUrl);
    });

    it("ignores topic parameter (GitLab doesn't use Gerrit topics)", async () => {
      gitRunner.run.mockImplementation(async (args) => {
        const stdout = args[0] === "remote" && args[1] === "get-url"
          ? "https://gitlab.example.com/my-project.git"
          : args[0] === "log"
            ? "feat: test"
            : "";
        return { stdout, stderr: "" };
      });
      const httpClient = getHttpClient(connector);
      httpClient.fetchJson.mockResolvedValue({ iid: 7, web_url: "https://gitlab.example.com/mr/7" });

      await connector.pushDirect("/tmp/workspace/repo", "feature-TASK-3", "VE-TASK-3");

      // Should still push to the correct branch
      expect(gitRunner.run).toHaveBeenCalledWith(
        ["push", "--force", "-u", "origin", "feature-TASK-3"],
        expect.any(Object)
      );
    });
  });

  describe("createOrFindMergeRequest (via push)", () => {
    it("falls back to finding existing MR on 409 conflict", async () => {
      const httpClient = getHttpClient(connector);
      // First call (POST create) → 409; second call (GET list) → existing MR
      httpClient.fetchJson
        .mockRejectedValueOnce(new ReviewApiError(409, "/api/v4/projects/my-project/merge_requests", "Already exists"))
        .mockResolvedValueOnce([{ iid: 3, web_url: "https://gitlab.example.com/mr/3" }]);

      const result = await connector.push("/tmp/workspace/repo", "feature-dup", "feat: dup");
      expect(result.changeId).toBe("3");
    });
  });

  describe("getUnresolvedComments", () => {
    it("returns mapped ReviewComment array", async () => {
      const httpClient = getHttpClient(connector);
      httpClient.fetchJson.mockResolvedValue([
        {
          id: "disc-1",
          resolved: false,
          notes: [
            {
              id: 10,
              system: false,
              author: { username: "reviewer" },
              body: "Please fix this",
              updated_at: "2026-01-01T00:00:00Z",
              position: { new_path: "src/foo.ts", new_line: 42 },
            },
          ],
        },
      ]);

      const comments = await connector.getUnresolvedComments("7");
      expect(comments).toHaveLength(1);
      expect(comments[0]).toMatchObject({
        id: "disc-1",
        author: "reviewer",
        message: "Please fix this",
        filePath: "src/foo.ts",
        line: 42,
        unresolved: true,
      });
    });

    it("skips resolved discussions", async () => {
      const httpClient = getHttpClient(connector);
      httpClient.fetchJson.mockResolvedValue([
        { id: "disc-2", resolved: true, notes: [] },
      ]);

      const comments = await connector.getUnresolvedComments("7");
      expect(comments).toHaveLength(0);
    });

    it("returns empty array on API error (non-fatal)", async () => {
      const httpClient = getHttpClient(connector);
      httpClient.fetchJson.mockRejectedValue(new ReviewApiError(500, "/api", "Internal error"));

      const comments = await connector.getUnresolvedComments("7");
      expect(comments).toEqual([]);
    });

    it("returns empty array for invalid MR IID", async () => {
      const comments = await connector.getUnresolvedComments("not-a-number");
      expect(comments).toEqual([]);
    });
  });

  describe("resolveComments", () => {
    it("sends PUT to resolve each discussion thread", async () => {
      const httpClient = getHttpClient(connector);
      httpClient.fetchJsonVoid.mockResolvedValue(undefined);

      await connector.resolveComments("7", [
        { id: "disc-1", author: "a", message: "x", unresolved: true, patchset: 0, updatedAt: new Date() },
        { id: "disc-2", author: "b", message: "y", unresolved: true, patchset: 0, updatedAt: new Date() },
      ]);

      expect(httpClient.fetchJsonVoid).toHaveBeenCalledTimes(2);
      expect(httpClient.fetchJsonVoid).toHaveBeenCalledWith(
        expect.stringContaining("/discussions/disc-1"),
        expect.objectContaining({ method: "PUT" })
      );
    });

    it("does nothing when comments list is empty", async () => {
      const httpClient = getHttpClient(connector);
      await connector.resolveComments("7", []);
      expect(httpClient.fetchJsonVoid).not.toHaveBeenCalled();
    });
  });

  describe("push-spec protocol members", () => {
    it("useChangeIdContinuity is false", () => {
      expect(connector.useChangeIdContinuity).toBe(false);
    });

    it("reviewSystemLabel is \"gitlab\"", () => {
      expect(connector.reviewSystemLabel).toBe("gitlab");
    });

    it("buildPushSpec returns feature-<taskId> branch with no topic", () => {
      const spec = connector.buildPushSpec("main", "task-1");
      expect(spec.ref).toBe("feature-task-1");
      expect(spec.topic).toBeUndefined();
    });

    it("buildPushSpec ignores baseBranch — ref is always feature-<taskId>", () => {
      const specA = connector.buildPushSpec("main", "id-x");
      const specB = connector.buildPushSpec("release/2.0", "id-x");
      expect(specA.ref).toBe(specB.ref);
    });

    it("buildPushSpec uses a slug from ticketTitle when provided", () => {
      const spec = connector.buildPushSpec("main", "b7ddee79-cc3b-4208-815c-70fcf177a49e", "Add login button");
      expect(spec.ref).toBe("feature/b7ddee79-add-login-button");
      expect(spec.topic).toBeUndefined();
    });

    it("buildPushSpec falls back to legacy ref when ticketTitle is empty", () => {
      const spec = connector.buildPushSpec("main", "task-1", "");
      expect(spec.ref).toBe("feature-task-1");
    });
  });
});
