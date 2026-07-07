import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitHubReviewProvider, parsePatchNewLineNumbers } from "../../src/connectors/githubReviewProvider.js";
import type { ExternalChangeId } from "../../src/interfaces.js";

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

const config = {
  apiBaseUrl: "https://api.github.com",
  owner: "octocat",
  repo: "hello-world",
  token: "ghp_test",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const cid = "42" as unknown as ExternalChangeId;

beforeEach(() => {
  fetchMock.mockReset();
});

describe("GitHubReviewProvider", () => {
  it("getChangeDetails maps open PR to OPEN status", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      number: 42,
      state: "open",
      title: "Add feature X",
      body: "Description here.",
      html_url: "https://github.com/octocat/hello-world/pull/42",
      merged: false,
      user: { login: "alice", id: 123 },
      base: { ref: "main", repo: { full_name: "octocat/hello-world" } },
      head: { ref: "feature-x", sha: "abc" },
    }));

    const p = new GitHubReviewProvider(config);
    const r = await p.getChangeDetails(cid);
    expect(r.status).toBe("OPEN");
    expect(r.changeNumber).toBe(42);
    expect(r.targetBranch).toBe("main");
    expect(r.project).toBe("octocat/hello-world");
    expect(r.ownerAccountId).toBe("123");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/octocat/hello-world/pulls/42",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer ghp_test" }) })
    );
  });

  it("getChangeDetails maps merged PR to MERGED", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      number: 7, state: "closed", title: "x", html_url: "u", merged: true,
      base: { ref: "main", repo: { full_name: "o/r" } }, head: { ref: "f", sha: "s" },
    }));
    const r = await new GitHubReviewProvider(config).getChangeDetails(cid);
    expect(r.status).toBe("MERGED");
  });

  it("getChangeDetails derives currentPatchset from the head SHA so updates re-review", async () => {
    const prAt = (sha: string): unknown => ({
      number: 42, state: "open", title: "t", html_url: "u", merged: false,
      base: { ref: "main", repo: { full_name: "o/r" } }, head: { ref: "f", sha },
    });
    const p = new GitHubReviewProvider(config);

    fetchMock.mockResolvedValueOnce(jsonResponse(prAt("aaaaaaaaaaaaaaaa")));
    const first = await p.getChangeDetails(cid);
    fetchMock.mockResolvedValueOnce(jsonResponse(prAt("aaaaaaaaaaaaaaaa")));
    const same = await p.getChangeDetails(cid);
    fetchMock.mockResolvedValueOnce(jsonResponse(prAt("bbbbbbbbbbbbbbbb")));
    const updated = await p.getChangeDetails(cid);

    // Same head SHA -> same patchset (dedup skips); new head SHA -> new patchset (re-review).
    expect(first.currentPatchset).toBe(same.currentPatchset);
    expect(updated.currentPatchset).not.toBe(first.currentPatchset);
  });

  it("getChangeDetails maps closed-unmerged PR to ABANDONED", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      number: 8, state: "closed", title: "x", html_url: "u", merged: false,
      base: { ref: "main", repo: { full_name: "o/r" } }, head: { ref: "f", sha: "s" },
    }));
    const r = await new GitHubReviewProvider(config).getChangeDetails(cid);
    expect(r.status).toBe("ABANDONED");
  });

  it("getChangeDiff returns mapped file list", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([
      { filename: "src/a.ts", status: "added", patch: "@@\n+new" },
      { filename: "src/b.ts", status: "modified", patch: "@@\n-old\n+new" },
      { filename: "src/c.ts", status: "removed", patch: "" },
      { filename: "src/d.ts", status: "renamed", patch: "" },
    ]));
    const r = await new GitHubReviewProvider(config).getChangeDiff(cid);
    expect(r.files).toHaveLength(4);
    expect(r.files[0]).toEqual({ path: "src/a.ts", status: "added", patch: "@@\n+new" });
    expect(r.files[2]?.status).toBe("deleted");
    expect(r.files[3]?.status).toBe("renamed");
  });

  it("getChangeDiff echoes the requested patchset", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([
      { filename: "src/a.ts", status: "modified", patch: "@@\n+new" },
    ]));
    const r = await new GitHubReviewProvider(config).getChangeDiff(cid, 42);
    expect(r.patchset).toBe(42);
  });

  it("postReviewWithComments posts an APPROVE review with inline comments", async () => {
    // First call: files fetch for line validation; src/a.ts has line 10 in hunk
    fetchMock.mockResolvedValueOnce(jsonResponse([
      { filename: "src/a.ts", status: "modified", patch: "@@ -8,5 +8,5 @@\n line8\n line9\n line10\n line11\n line12" },
    ]));
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1 }));
    await new GitHubReviewProvider(config).postReviewWithComments!(
      cid, 1,
      [{ file: "src/a.ts", line: 10, message: "nit", severity: "suggestion" }],
      "LGTM",
      1,
    );
    // First call is the files fetch, second is the review POST
    const reviewCall = fetchMock.mock.calls[1];
    expect(reviewCall?.[0]).toBe("https://api.github.com/repos/octocat/hello-world/pulls/42/reviews");
    const init = reviewCall?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.event).toBe("APPROVE");
    expect(body.body).toBe("LGTM");
    expect(body.comments).toEqual([{ path: "src/a.ts", line: 10, body: "nit", side: "RIGHT" }]);
  });

  it("postReviewWithComments posts REQUEST_CHANGES for score -1", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1 }));
    await new GitHubReviewProvider(config).postReviewWithComments!(cid, 1, [], "Issues found", -1);
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.event).toBe("REQUEST_CHANGES");
    expect(body.comments).toBeUndefined();
  });

  it("postReviewComments posts COMMENT event", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1 }));
    await new GitHubReviewProvider(config).postReviewComments(cid, 1, [], "FYI");
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.event).toBe("COMMENT");
  });

  it("vote(0) posts COMMENT, vote(1) APPROVE, vote(-1) REQUEST_CHANGES", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ id: 1 })));
    const p = new GitHubReviewProvider(config);
    await p.vote(cid, 1, 0, "neutral");
    await p.vote(cid, 1, 1, "ok");
    await p.vote(cid, 1, -1, "no");
    const events = fetchMock.mock.calls.map((c) => JSON.parse(((c[1] as RequestInit).body) as string).event);
    expect(events).toEqual(["COMMENT", "APPROVE", "REQUEST_CHANGES"]);
  });

  it("drops file-level (line=0) comments from inline list but folds them into the body", async () => {
    // Files fetch returns empty → line-validation map is empty → line>0 comment passes as inline
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1 }));
    await new GitHubReviewProvider(config).postReviewWithComments!(
      cid, 1,
      [
        { file: "src/a.ts", line: 0, message: "file-level", severity: "warning" },
        { file: "src/a.ts", line: 5, message: "inline", severity: "warning" },
      ],
      "x", -1,
    );
    const body = JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string);
    expect(body.comments).toEqual([{ path: "src/a.ts", line: 5, body: "inline", side: "RIGHT" }]);
    // The file-level comment is folded into the review body (without a line suffix).
    expect(body.body).toContain("file-level");
    expect(body.body).toContain("`src/a.ts`");
    expect(body.body).not.toContain("`src/a.ts:0`");
  });

  it("folds out-of-diff inline comments into review body", async () => {
    // Patch only covers lines 1-3; comment on line 99 is out-of-diff
    fetchMock.mockResolvedValueOnce(jsonResponse([
      { filename: "src/a.ts", status: "modified", patch: "@@ -1,3 +1,3 @@\n line1\n line2\n line3" },
    ]));
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1 }));
    await new GitHubReviewProvider(config).postReviewWithComments!(
      cid, 1,
      [
        { file: "src/a.ts", line: 2, message: "valid", severity: "warning" },
        { file: "src/a.ts", line: 99, message: "out-of-diff", severity: "error" },
      ],
      "Summary", -1,
    );
    const body = JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string);
    // Only line 2 is inline; line 99 is folded into body
    expect(body.comments).toEqual([{ path: "src/a.ts", line: 2, body: "valid", side: "RIGHT" }]);
    expect(body.body).toContain("Summary");
    expect(body.body).toContain("`src/a.ts:99`");
    expect(body.body).toContain("out-of-diff");
  });

  it("allowedFiles drops comments referencing files outside the patchset", async () => {
    // File filter drops ghost.ts; line validation fetches /files first
    fetchMock.mockResolvedValueOnce(jsonResponse([
      { filename: "src/a.ts", status: "modified", patch: "@@ -1,5 +1,5 @@\n line1\n line2\n line3\n line4\n line5" },
    ]));
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1 }));
    await new GitHubReviewProvider(config).postReviewWithComments!(
      cid, 1,
      [
        { file: "src/a.ts", line: 5, message: "kept", severity: "warning" },
        { file: "src/ghost.ts", line: 9, message: "dropped", severity: "error" },
      ],
      "summary", -1,
      new Set(["src/a.ts"]),
    );
    const body = JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string);
    expect(body.comments).toEqual([{ path: "src/a.ts", line: 5, body: "kept", side: "RIGHT" }]);
    expect(body.event).toBe("REQUEST_CHANGES");
    expect(body.body).toBe("summary");
  });

  it("allowedFiles: when all comments dropped, still posts summary+event", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1 }));
    await new GitHubReviewProvider(config).postReviewWithComments!(
      cid, 1,
      [{ file: "src/ghost.ts", line: 9, message: "dropped", severity: "error" }],
      "all gone", -1,
      new Set(["src/real.ts"]),
    );
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.comments).toBeUndefined();
    expect(body.body).toBe("all gone");
    expect(body.event).toBe("REQUEST_CHANGES");
  });

  it("postReviewComments: skips the API call when all comments are filtered and summary is empty", async () => {
    await new GitHubReviewProvider(config).postReviewComments(
      cid, 1,
      [{ file: "src/ghost.ts", line: 9, message: "dropped", severity: "error" }],
      "",
      new Set(["src/real.ts"]),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on non-OK API response", async () => {
    fetchMock.mockResolvedValueOnce(new Response("bad", { status: 404 }));
    await expect(new GitHubReviewProvider(config).getChangeDetails(cid)).rejects.toThrow(/404/);
  });

  it("rejects invalid PR number in changeId", async () => {
    await expect(new GitHubReviewProvider(config).getChangeDetails("not-a-number" as unknown as ExternalChangeId))
      .rejects.toThrow(/Invalid GitHub PR number/);
  });

  describe("discussion threads (GraphQL)", () => {
    it("getDiscussionThreads maps review threads and tags isOwn / resolved", async () => {
      // 1) viewer login lookup, 2) reviewThreads page.
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ data: { viewer: { login: "ve-bot" } } }))
        .mockResolvedValueOnce(
          jsonResponse({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        id: "THREAD_1",
                        isResolved: false,
                        path: "src/a.ts",
                        line: 12,
                        comments: {
                          nodes: [
                            { body: "Why not a Map?", author: { login: "alice" } },
                            { body: "Order matters.", author: { login: "ve-bot" } },
                          ],
                        },
                      },
                      {
                        id: "THREAD_2",
                        isResolved: true,
                        path: "src/b.ts",
                        line: 3,
                        comments: { nodes: [{ body: "nit", author: { login: "bob" } }] },
                      },
                    ],
                  },
                },
              },
            },
          })
        );

      const threads = await new GitHubReviewProvider(config).getDiscussionThreads(cid);
      expect(threads).toHaveLength(2);
      const t1 = threads.find((t) => t.threadId === "THREAD_1");
      expect(t1?.resolved).toBe(false);
      expect(t1?.file).toBe("src/a.ts");
      expect(t1?.line).toBe(12);
      expect(t1?.comments[0]).toEqual({ author: "alice", message: "Why not a Map?", isOwn: false });
      expect(t1?.comments[1]?.isOwn).toBe(true);
      expect(threads.find((t) => t.threadId === "THREAD_2")?.resolved).toBe(true);

      // First GraphQL call hit the api.github.com/graphql endpoint.
      expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.github.com/graphql");
    });

    it("postThreadReply issues the addPullRequestReviewThreadReply mutation", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ data: { addPullRequestReviewThreadReply: { comment: { id: "C1" } } } })
      );
      await new GitHubReviewProvider(config).postThreadReply(cid, 1, "THREAD_1", "Agreed.");
      const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as {
        query: string;
        variables: { threadId: string; body: string };
      };
      expect(body.query).toContain("addPullRequestReviewThreadReply");
      expect(body.variables).toEqual({ threadId: "THREAD_1", body: "Agreed." });
    });

    it("derives the GraphQL endpoint for GitHub Enterprise base URLs", async () => {
      const ghe = new GitHubReviewProvider({
        ...config,
        apiBaseUrl: "https://ghe.example.com/api/v3",
      });
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ data: { addPullRequestReviewThreadReply: { comment: { id: "C1" } } } })
      );
      await ghe.postThreadReply(cid, 1, "THREAD_1", "hi");
      expect(fetchMock.mock.calls[0]?.[0]).toBe("https://ghe.example.com/api/graphql");
    });
  });

  describe("hasReviewedCurrentPatchset", () => {
    const prBody = (sha: string): unknown => ({
      number: 42, state: "open", title: "t", html_url: "u", merged: false,
      base: { ref: "main", repo: { full_name: "o/r" } }, head: { ref: "f", sha },
    });

    it("returns true when VE has a review whose commit_id matches the current head SHA", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(prBody("headsha123"))) // PR fetch
        .mockResolvedValueOnce(jsonResponse({ data: { viewer: { login: "ve-bot" } } })) // viewer
        .mockResolvedValueOnce(jsonResponse([
          { user: { login: "alice" }, state: "APPROVED", commit_id: "headsha123" },
          { user: { login: "ve-bot" }, state: "CHANGES_REQUESTED", commit_id: "headsha123" },
        ])); // reviews
      expect(await new GitHubReviewProvider(config).hasReviewedCurrentPatchset(cid)).toBe(true);
    });

    it("returns false when VE only reviewed an older commit (head advanced)", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(prBody("newsha")))
        .mockResolvedValueOnce(jsonResponse({ data: { viewer: { login: "ve-bot" } } }))
        .mockResolvedValueOnce(jsonResponse([
          { user: { login: "ve-bot" }, state: "APPROVED", commit_id: "oldsha" },
        ]));
      expect(await new GitHubReviewProvider(config).hasReviewedCurrentPatchset(cid)).toBe(false);
    });

    it("returns false when only other reviewers reviewed the current head", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(prBody("headsha123")))
        .mockResolvedValueOnce(jsonResponse({ data: { viewer: { login: "ve-bot" } } }))
        .mockResolvedValueOnce(jsonResponse([
          { user: { login: "someone" }, state: "APPROVED", commit_id: "headsha123" },
        ]));
      expect(await new GitHubReviewProvider(config).hasReviewedCurrentPatchset(cid)).toBe(false);
    });
  });
});


describe("parsePatchNewLineNumbers", () => {
  it("returns valid new-file line numbers from a simple hunk", () => {
    // @@ -1,3 +1,4 @@ means new file starts at 1
    const patch = "@@ -1,3 +1,4 @@\n line1\n line2\n-removed\n+added\n line3";
    const valid = parsePatchNewLineNumbers(patch);
    // context lines 1,2,4 + added line 3 → new-file lines 1,2,3,4
    expect(valid).toEqual(new Set([1, 2, 3, 4]));
  });

  it("handles multiple hunks", () => {
    const patch =
      "@@ -1,2 +1,2 @@\n line1\n line2\n" +
      "@@ -10,2 +10,3 @@\n line10\n+inserted\n line11";
    const valid = parsePatchNewLineNumbers(patch);
    expect(valid.has(1)).toBe(true);
    expect(valid.has(2)).toBe(true);
    expect(valid.has(10)).toBe(true);
    expect(valid.has(11)).toBe(true);
    expect(valid.has(12)).toBe(true);
    // Line 9 is not in any hunk
    expect(valid.has(9)).toBe(false);
  });

  it("does not include removed lines in the set", () => {
    const patch = "@@ -1,2 +1,1 @@\n context\n-removed";
    const valid = parsePatchNewLineNumbers(patch);
    expect(valid).toEqual(new Set([1]));
  });

  it("skips no-newline markers", () => {
    const patch = "@@ -1,1 +1,1 @@\n line1\n\\ No newline at end of file";
    const valid = parsePatchNewLineNumbers(patch);
    expect(valid).toEqual(new Set([1]));
  });

  it("returns empty set for empty patch", () => {
    expect(parsePatchNewLineNumbers("")).toEqual(new Set());
  });
});
