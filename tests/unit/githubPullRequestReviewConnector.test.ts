import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  GitHubPullRequestReviewConnector,
  GitHubPrApiError,
} from "../../src/connectors/githubPullRequestReviewConnector.js";
import { makeExternalChangeId } from "../../src/interfaces.js";
import { jsonResponse, errorResponse } from "./helpers/fixtures.js";

const API_BASE_URL = "https://api.github.com";
const OWNER = "octocat";
const REPO = "hello-world";
const TOKEN = "ghp_test-token";

function makeConnector(
  overrides?: Partial<ConstructorParameters<typeof GitHubPullRequestReviewConnector>[0]>
) {
  return new GitHubPullRequestReviewConnector({
    apiBaseUrl: API_BASE_URL,
    owner: OWNER,
    repo: REPO,
    token: TOKEN,
    virtualEngineerUserLogin: "ve-bot",
    ...overrides,
  });
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const githubPr = {
  number: 42,
  state: "open",
  html_url: "https://github.com/octocat/hello-world/pull/42",
  title: "Add feature X",
  head: { ref: "feature-x", sha: "abc123def456" },
  merged: false,
};

const githubPrMerged = { ...githubPr, state: "closed", merged: true };
const githubPrClosed = { ...githubPr, state: "closed", merged: false };

const reviewComments = [
  {
    id: 101,
    user: { login: "reviewer" },
    body: "Please fix this",
    path: "src/main.ts",
    line: 10,
    updated_at: "2026-04-07T10:00:00.000Z",
    node_id: "MDI0OlB1bGxSZXF1ZXN0UmV2aWV3Q29tbWVudDEwMQ==",
  },
  {
    id: 102,
    user: { login: "ve-bot" },
    body: "Fixed in this commit",
    path: "src/main.ts",
    line: 10,
    updated_at: "2026-04-07T11:00:00.000Z",
    node_id: "MDI0OlB1bGxSZXF1ZXN0UmV2aWV3Q29tbWVudDEwMg==",
    in_reply_to_id: 101,
  },
];

const issueComments = [
  {
    id: 201,
    user: { login: "reviewer" },
    body: "Looks good overall but needs tests",
    updated_at: "2026-04-07T09:00:00.000Z",
    node_id: "MDEyOklzc3VlQ29tbWVudDIwMQ==",
  },
  {
    id: 202,
    user: { login: "ve-bot" },
    body: "Added tests",
    updated_at: "2026-04-07T12:00:00.000Z",
    node_id: "MDEyOklzc3VlQ29tbWVudDIwMg==",
  },
];

describe("GitHubPullRequestReviewConnector", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ─── getChange ────────────────────────────────────────────────────────────

  describe("getChange", () => {
    it("fetches PR and returns change ref", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(githubPr));

      const changeId = makeExternalChangeId("42");
      const ref = await makeConnector().getChange(changeId);

      expect(ref.changeId).toBe(changeId);
      expect(ref.changeNumber).toBe(42);
      expect(ref.url).toBe(githubPr.html_url);
    });
  });

  // ─── getChangeStatus ──────────────────────────────────────────────────────

  describe("getChangeStatus", () => {
    it("returns OPEN for open PRs", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(githubPr));
      expect(await makeConnector().getChangeStatus(makeExternalChangeId("42"))).toBe("OPEN");
    });

    it("returns MERGED for merged PRs", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(githubPrMerged));
      expect(await makeConnector().getChangeStatus(makeExternalChangeId("42"))).toBe("MERGED");
    });

    it("returns ABANDONED for closed (not merged) PRs", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(githubPrClosed));
      expect(await makeConnector().getChangeStatus(makeExternalChangeId("42"))).toBe("ABANDONED");
    });
  });

  // ─── getUnresolvedComments ────────────────────────────────────────────────

  describe("getUnresolvedComments", () => {
    it("merges review comments and issue comments, filtering VE's own", async () => {
      // First call: PR reviews — return a CHANGES_REQUESTED review to unblock comment fetch
      fetchMock.mockResolvedValueOnce(
        jsonResponse([{ state: "CHANGES_REQUESTED", user: { login: "reviewer" } }])
      );
      // Review comments
      fetchMock.mockResolvedValueOnce(jsonResponse(reviewComments));
      // Issue comments
      fetchMock.mockResolvedValueOnce(jsonResponse(issueComments));

      const comments = await makeConnector().getUnresolvedComments(makeExternalChangeId("42"));

      // Should include: reviewer's review comment (101), reviewer's issue comment (201)
      // Should exclude: ve-bot's reply (102, also has in_reply_to_id), ve-bot's issue comment (202)
      expect(comments).toHaveLength(2);

      const inline = comments.find((c) => c.id === "101");
      expect(inline).toBeDefined();
      expect(inline?.author).toBe("reviewer");
      expect(inline?.filePath).toBe("src/main.ts");
      expect(inline?.line).toBe(10);

      const general = comments.find((c) => c.id === "issue-201");
      expect(general).toBeDefined();
      expect(general?.author).toBe("reviewer");
      expect(general?.filePath).toBeUndefined();
    });

    it("returns empty array when no CHANGES_REQUESTED review exists", async () => {
      // PR reviews: only APPROVED — no CHANGES_REQUESTED
      fetchMock.mockResolvedValueOnce(
        jsonResponse([{ state: "APPROVED", user: { login: "reviewer" } }])
      );
      // No further calls expected (early return)

      const comments = await makeConnector().getUnresolvedComments(makeExternalChangeId("42"));
      expect(comments).toHaveLength(0);
      // Only one fetch call made (the reviews endpoint)
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("returns empty array when no reviews at all", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([]));

      const comments = await makeConnector().getUnresolvedComments(makeExternalChangeId("42"));
      expect(comments).toHaveLength(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("ignores CHANGES_REQUESTED submitted by VE itself", async () => {
      // VE submitted CHANGES_REQUESTED on its own PR (unusual but should be ignored)
      fetchMock.mockResolvedValueOnce(
        jsonResponse([{ state: "CHANGES_REQUESTED", user: { login: "ve-bot" } }])
      );

      const comments = await makeConnector().getUnresolvedComments(makeExternalChangeId("42"));
      expect(comments).toHaveLength(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("proceeds when at least one non-VE reviewer has CHANGES_REQUESTED", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse([
          { state: "APPROVED", user: { login: "alice" } },
          { state: "CHANGES_REQUESTED", user: { login: "bob" } },
        ])
      );
      fetchMock.mockResolvedValueOnce(jsonResponse([])); // review comments
      fetchMock.mockResolvedValueOnce(jsonResponse([])); // issue comments

      const comments = await makeConnector().getUnresolvedComments(makeExternalChangeId("42"));
      expect(comments).toHaveLength(0); // no actual comments, but proceeds past gate
      expect(fetchMock).toHaveBeenCalledTimes(3); // reviews + review comments + issue comments
    });
  });

  // ─── addChangeComment ─────────────────────────────────────────────────────

  describe("addChangeComment", () => {
    it("posts a general comment on the PR via issue comments API", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1 }));

      await makeConnector().addChangeComment(makeExternalChangeId("42"), "Working on it");

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/issues/42/comments");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string).body).toBe("Working on it");
    });
  });

  // ─── postReviewReply ──────────────────────────────────────────────────────

  describe("postReviewReply", () => {
    it("posts a reply to a review comment", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 301 }));

      await makeConnector().postReviewReply(42, 101, "Fixed!");

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/pulls/42/comments/101/replies");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string).body).toBe("Fixed!");
    });
  });

  // ─── getReviewThreadIdForComment (GraphQL) ────────────────────────────────

  describe("getReviewThreadIdForComment", () => {
    it("queries GraphQL and maps comment database ID to thread node ID", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: "thread-node-1",
                      comments: {
                        nodes: [{ databaseId: 101 }, { databaseId: 102 }],
                      },
                    },
                    {
                      id: "thread-node-2",
                      comments: {
                        nodes: [{ databaseId: 103 }],
                      },
                    },
                  ],
                },
              },
            },
          },
        })
      );

      const threadId = await makeConnector().getReviewThreadIdForComment(42, 101);

      expect(threadId).toBe("thread-node-1");
      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toBe("https://api.github.com/graphql");
    });

    it("returns undefined when comment not found in any thread", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: "thread-node-1",
                      comments: { nodes: [{ databaseId: 999 }] },
                    },
                  ],
                },
              },
            },
          },
        })
      );

      const threadId = await makeConnector().getReviewThreadIdForComment(42, 101);
      expect(threadId).toBeUndefined();
    });
  });

  // ─── markReviewThreadResolved (GraphQL mutation) ──────────────────────────

  describe("markReviewThreadResolved", () => {
    it("calls resolveReviewThread GraphQL mutation", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: { resolveReviewThread: { thread: { id: "thread-node-1" } } },
        })
      );

      await makeConnector().markReviewThreadResolved("thread-node-1");

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.github.com/graphql");
      const body = JSON.parse(init.body as string);
      expect(body.query).toContain("resolveReviewThread");
      expect(body.variables.threadId).toBe("thread-node-1");
    });

    it("throws GitHubPrApiError on failure", async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(403, "Forbidden"));

      await expect(
        makeConnector().markReviewThreadResolved("thread-node-1")
      ).rejects.toThrow(GitHubPrApiError);
    });
  });

  // ─── GitHubPrApiError ─────────────────────────────────────────────────────

  describe("GitHubPrApiError", () => {
    it("includes status, url, body in message", () => {
      const err = new GitHubPrApiError(403, "https://api.github.com/repos/x/y/pulls", "Forbidden");
      expect(err.message).toContain("403");
      expect(err.name).toBe("GitHubPrApiError");
    });
  });

  // ─── getOpenReviewAssignments ─────────────────────────────────────────────

  describe("getOpenReviewAssignments", () => {
    it("returns PRs where VE is a requested reviewer", async () => {
      const openPrs = [
        {
          number: 10,
          title: "Add feature",
          html_url: "https://github.com/octocat/hello-world/pull/10",
          state: "open",
          requested_reviewers: [{ login: "ve-bot" }, { login: "other-user" }],
        },
        {
          number: 11,
          title: "Bug fix",
          html_url: "https://github.com/octocat/hello-world/pull/11",
          state: "open",
          requested_reviewers: [{ login: "other-user" }], // VE not requested
        },
      ];
      fetchMock.mockResolvedValueOnce(jsonResponse(openPrs));

      const connector = makeConnector({ virtualEngineerUserLogin: "ve-bot" });
      const results = await connector.getOpenReviewAssignments(["octocat/hello-world"]);

      expect(results).toHaveLength(1);
      expect(results[0]?.changeId).toBe("octocat/hello-world#10");
      expect(results[0]?.project).toBe("octocat/hello-world");
      expect(results[0]?.subject).toBe("Add feature");
    });

    it("returns empty array when VE is not requested on any PR", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse([
          {
            number: 5,
            title: "Other PR",
            html_url: "https://github.com/octocat/hello-world/pull/5",
            state: "open",
            requested_reviewers: [{ login: "alice" }],
          },
        ])
      );

      const results = await makeConnector().getOpenReviewAssignments(["octocat/hello-world"]);
      expect(results).toHaveLength(0);
    });

    it("resolves login via GET /user when virtualEngineerUserLogin is not configured", async () => {
      // First call: GET /user to resolve login
      fetchMock.mockResolvedValueOnce(jsonResponse({ login: "ve-resolved" }));
      // Second call: PR list
      fetchMock.mockResolvedValueOnce(
        jsonResponse([
          {
            number: 7,
            title: "Login resolve test",
            html_url: "https://github.com/octocat/hello-world/pull/7",
            state: "open",
            requested_reviewers: [{ login: "ve-resolved" }],
          },
        ])
      );

      const connector = makeConnector({ virtualEngineerUserLogin: undefined });
      const results = await connector.getOpenReviewAssignments(["octocat/hello-world"]);

      expect(results).toHaveLength(1);
      expect(results[0]?.changeId).toBe("octocat/hello-world#7");
      const [userUrl] = fetchMock.mock.calls[0] as [string];
      expect(userUrl).toContain("/user");
    });

    it("caches the resolved login across multiple calls", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ login: "ve-cached" }));
      fetchMock.mockResolvedValueOnce(jsonResponse([])); // first repo
      fetchMock.mockResolvedValueOnce(jsonResponse([])); // second repo

      const connector = makeConnector({ virtualEngineerUserLogin: undefined });
      await connector.getOpenReviewAssignments(["octocat/repo-a"]);
      await connector.getOpenReviewAssignments(["octocat/repo-b"]);

      // GET /user called only once across both invocations
      const userCalls = (fetchMock.mock.calls as [string][]).filter(([url]) => url.endsWith("/user"));
      expect(userCalls).toHaveLength(1);
    });

    it("handles multiple repos and combines results", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse([
          {
            number: 1,
            title: "PR in repo A",
            html_url: "https://github.com/octocat/repo-a/pull/1",
            state: "open",
            requested_reviewers: [{ login: "ve-bot" }],
          },
        ])
      );
      fetchMock.mockResolvedValueOnce(
        jsonResponse([
          {
            number: 2,
            title: "PR in repo B",
            html_url: "https://github.com/octocat/repo-b/pull/2",
            state: "open",
            requested_reviewers: [{ login: "ve-bot" }],
          },
        ])
      );

      const results = await makeConnector().getOpenReviewAssignments(["octocat/repo-a", "octocat/repo-b"]);

      expect(results).toHaveLength(2);
      expect(results.map((r) => r.changeId)).toEqual(
        expect.arrayContaining(["octocat/repo-a#1", "octocat/repo-b#2"])
      );
    });

    it("returns empty array for repos with no open PRs", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([]));

      const results = await makeConnector().getOpenReviewAssignments(["octocat/empty-repo"]);
      expect(results).toHaveLength(0);
    });

    it("paginates when a page returns exactly 100 PRs", async () => {
      // Generate 100 PRs for page 1 (full page triggers pagination)
      const page1 = Array.from({ length: 100 }, (_, i) => ({
        number: i + 1,
        title: `PR ${i + 1}`,
        html_url: `https://github.com/octocat/repo/pull/${i + 1}`,
        state: "open",
        requested_reviewers: i === 0 ? [{ login: "ve-bot" }] : [],
      }));
      // Page 2 has fewer than 100 — last page
      const page2 = [
        {
          number: 101,
          title: "PR 101",
          html_url: "https://github.com/octocat/repo/pull/101",
          state: "open",
          requested_reviewers: [{ login: "ve-bot" }],
        },
      ];
      fetchMock.mockResolvedValueOnce(jsonResponse(page1));
      fetchMock.mockResolvedValueOnce(jsonResponse(page2));

      const results = await makeConnector().getOpenReviewAssignments(["octocat/repo"]);

      // Should have fetched 2 pages
      const pullCalls = (fetchMock.mock.calls as [string][]).filter(([url]) => url.includes("/pulls"));
      expect(pullCalls).toHaveLength(2);
      expect(pullCalls[0]![0]).toContain("page=1");
      expect(pullCalls[1]![0]).toContain("page=2");

      // 2 PRs matched ve-bot
      expect(results).toHaveLength(2);
    });

    it("stops paginating at MAX_PAGES (5)", async () => {
      // All 5 pages return exactly 100 PRs
      for (let i = 0; i < 5; i++) {
        const page = Array.from({ length: 100 }, (_, j) => ({
          number: i * 100 + j + 1,
          title: `PR ${i * 100 + j + 1}`,
          html_url: `https://github.com/octocat/repo/pull/${i * 100 + j + 1}`,
          state: "open",
          requested_reviewers: [] as Array<{ login: string }>,
        }));
        fetchMock.mockResolvedValueOnce(jsonResponse(page));
      }

      const results = await makeConnector().getOpenReviewAssignments(["octocat/repo"]);

      const pullCalls = (fetchMock.mock.calls as [string][]).filter(([url]) => url.includes("/pulls"));
      expect(pullCalls).toHaveLength(5); // Capped at 5, not 6
      expect(results).toHaveLength(0); // None matched ve-bot
    });
  });

  // ─── getCICheckFailures ───────────────────────────────────────────────────

  describe("getCICheckFailures", () => {
    const checkRunsResponse = {
      check_runs: [
        {
          id: 9001,
          name: "CI / test",
          conclusion: "failure",
          status: "completed",
          html_url: "https://github.com/octocat/hello-world/runs/9001",
          completed_at: "2026-05-29T10:00:00Z",
          output: { title: "2 tests failed", summary: "jest failed on foo.test.ts", text: null },
        },
        {
          id: 9002,
          name: "CI / lint",
          conclusion: "success",
          status: "completed",
          output: { title: null, summary: null, text: null },
        },
      ],
    };

    it("returns ReviewComments for failed check runs", async () => {
      // 1: PR (head sha)  2: check-runs  3: annotations for run 9001
      fetchMock.mockResolvedValueOnce(jsonResponse(githubPr));
      fetchMock.mockResolvedValueOnce(jsonResponse(checkRunsResponse));
      fetchMock.mockResolvedValueOnce(jsonResponse([])); // no annotations

      const results = await makeConnector().getCICheckFailures(makeExternalChangeId("42"));

      expect(results).toHaveLength(1);
      const r = results[0]!;
      expect(r.id).toBe("ci-run-9001");
      expect(r.author).toBe("github-actions[bot]");
      expect(r.message).toContain("CI / test");
      expect(r.message).toContain("failure");
      expect(r.message).toContain("2 tests failed");
      expect(r.message).toContain("jest failed on foo.test.ts");
      expect(r.unresolved).toBe(true);
    });

    it("includes annotations in the message", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(githubPr));
      fetchMock.mockResolvedValueOnce(jsonResponse(checkRunsResponse));
      fetchMock.mockResolvedValueOnce(
        jsonResponse([
          { path: "src/foo.ts", start_line: 12, annotation_level: "failure", message: "missing semicolon", title: "Lint error" },
        ])
      );

      const results = await makeConnector().getCICheckFailures(makeExternalChangeId("42"));

      expect(results[0]?.message).toContain("src/foo.ts:12");
      expect(results[0]?.message).toContain("Lint error");
    });

    it("returns empty array when all checks pass", async () => {
      const allPass = {
        check_runs: [
          { id: 1, name: "build", conclusion: "success", status: "completed", output: {} },
        ],
      };
      fetchMock.mockResolvedValueOnce(jsonResponse(githubPr));
      fetchMock.mockResolvedValueOnce(jsonResponse(allPass));

      const results = await makeConnector().getCICheckFailures(makeExternalChangeId("42"));
      expect(results).toHaveLength(0);
    });

    it("returns empty array and logs warning when check-runs fetch fails", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(githubPr));
      fetchMock.mockResolvedValueOnce(errorResponse(500, "Internal Server Error"));

      const results = await makeConnector().getCICheckFailures(makeExternalChangeId("42"));
      expect(results).toHaveLength(0);
    });

    it("still returns run comment even when annotations fetch fails", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(githubPr));
      fetchMock.mockResolvedValueOnce(jsonResponse(checkRunsResponse));
      fetchMock.mockResolvedValueOnce(errorResponse(403, "Forbidden")); // annotations fail

      const results = await makeConnector().getCICheckFailures(makeExternalChangeId("42"));
      expect(results).toHaveLength(1);
      expect(results[0]?.message).toContain("CI / test");
    });
  });
});
