import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitHubReviewProvider } from "../../src/connectors/githubReviewProvider.js";
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

  it("postReviewWithComments posts an APPROVE review with inline comments", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1 }));
    await new GitHubReviewProvider(config).postReviewWithComments!(
      cid, 1,
      [{ file: "src/a.ts", line: 10, message: "nit", severity: "suggestion" }],
      "LGTM",
      1,
    );
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe("https://api.github.com/repos/octocat/hello-world/pulls/42/reviews");
    const init = call?.[1] as RequestInit;
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

  it("postReviewWithComments drops file-level (line=0) comments from inline list", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1 }));
    await new GitHubReviewProvider(config).postReviewWithComments!(
      cid, 1,
      [
        { file: "src/a.ts", line: 0, message: "file-level", severity: "warning" },
        { file: "src/a.ts", line: 5, message: "inline", severity: "warning" },
      ],
      "x", -1,
    );
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.comments).toEqual([{ path: "src/a.ts", line: 5, body: "inline", side: "RIGHT" }]);
  });

  it("allowedFiles drops comments referencing files outside the patchset", async () => {
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
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
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
});
