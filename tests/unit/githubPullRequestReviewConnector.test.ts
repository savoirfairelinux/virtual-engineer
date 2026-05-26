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
  head: { ref: "feature-x" },
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

    it("returns empty array when no comments", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([]));
      fetchMock.mockResolvedValueOnce(jsonResponse([]));

      const comments = await makeConnector().getUnresolvedComments(makeExternalChangeId("42"));
      expect(comments).toHaveLength(0);
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
});
