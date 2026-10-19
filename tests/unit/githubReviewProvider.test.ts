import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitHubReviewProvider, parsePatchNewLineNumbers } from "../../src/connectors/githubReviewProvider.js";
import type { ExternalChangeId, ReviewChangeDetails, ReviewOverviewPublication, PublishedReviewFinding } from "../../src/interfaces.js";
import { patchsetFromRevisionSha } from "../../src/review/revisionPatchset.js";

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

const config = {
  apiBaseUrl: "https://api.github.com",
  owner: "octocat",
  repo: "hello-world",
  token: "ghp_test",
  virtualEngineerUserLogin: "ve-bot",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const cid = "42" as unknown as ExternalChangeId;
const headSha = "a".repeat(40);
const pr = {
  number: 42, state: "open", title: "Feature",
  html_url: "https://github.com/octocat/hello-world/pull/42",
  merged: false,
  base: { ref: "main", repo: { full_name: "octocat/hello-world" } },
  head: { ref: "feature", sha: headSha },
};
const finding = { file: "src/a.ts", line: 2, message: "Fix this", severity: "error" };

function publication(overrides: Partial<ReviewOverviewPublication> = {}): ReviewOverviewPublication {
  return {
    details: {
      changeId: cid, changeNumber: 42, subject: "Feature", description: "",
      ownerAccountId: "123", currentPatchset: 1, headSha, status: "OPEN",
      project: "octocat/hello-world", targetBranch: "main", url: pr.html_url,
    },
    summary: "Review summary", changeOverview: "New feature", requiredAction: "Fix this",
    score: -1, comments: [finding], folded: [], previous: [], reReview: false,
    ...overrides,
  };
}

const fileResponse = [{ filename: "src/a.ts", status: "modified", patch: "@@ -1,3 +1,3 @@\n line1\n line2\n line3" }];
const postedComment = (id: number, body = finding.message, line = 2): unknown => ({
  id, body, path: "src/a.ts", line,
  html_url: `${pr.html_url}#discussion_r${id}`,
});

beforeEach(() => {
  fetchMock.mockReset();
});

describe("GitHubReviewProvider", () => {
  describe("postReviewOverview", () => {
    it("finds and links an inline comment in the second files page", async () => {
      const firstPage = Array.from({ length: 100 }, (_, index) => ({
        filename: `src/other-${index}.ts`, status: "modified", patch: "@@ -1 +1 @@\n+one",
      }));
      const controller = new AbortController();
      fetchMock
        .mockResolvedValueOnce(jsonResponse(firstPage))
        .mockResolvedValueOnce(jsonResponse(fileResponse))
        .mockResolvedValueOnce(jsonResponse({ id: 7 }))
        .mockResolvedValueOnce(jsonResponse([postedComment(91)]))
        .mockResolvedValueOnce(jsonResponse(pr))
        .mockResolvedValueOnce(jsonResponse({ id: 7 }));

      const result = await new GitHubReviewProvider(config).postReviewOverview!(
        cid, 1, publication(), controller.signal,
      );

      expect(fetchMock.mock.calls.slice(0, 2).map((call) => call[0])).toEqual([
        "https://api.github.com/repos/octocat/hello-world/pulls/42/files?per_page=100&page=1",
        "https://api.github.com/repos/octocat/hello-world/pulls/42/files?per_page=100&page=2",
      ]);
      expect((fetchMock.mock.calls[1]?.[1] as RequestInit).signal).toBe(controller.signal);
      const pending = JSON.parse((fetchMock.mock.calls[2]?.[1] as RequestInit).body as string);
      expect(pending.body).toEqual(expect.stringMatching(/\S/));
      expect(pending.comments).toEqual([{ path: finding.file, line: finding.line, body: finding.message, side: "RIGHT" }]);
      expect(result.findings[0]?.url).toBe(`${pr.html_url}#discussion_r91`);
    });

    it("refuses to create a draft if file-list completeness cannot be established at the 3,000-file cap", async () => {
      const page = Array.from({ length: 100 }, (_, index) => ({
        filename: `src/changed-${index}.ts`, status: "modified", patch: "@@ -1 +1 @@\n+one",
      }));
      fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(page)));
      await expect(new GitHubReviewProvider(config).postReviewOverview!(cid, 1, publication()))
        .rejects.toThrow(/3,000.*complete/i);
      expect(fetchMock).toHaveBeenCalledTimes(30);
      expect(fetchMock.mock.calls[29]?.[0]).toBe(
        "https://api.github.com/repos/octocat/hello-world/pulls/42/files?per_page=100&page=30",
      );
    });

    it("links actual pending comments, folds unanchorable findings, and submits only on the reviewed head", async () => {
      const created = vi.fn(async () => {
        expect(fetchMock.mock.calls.map((call) => call[0])).toHaveLength(2);
      });
      const posted = vi.fn(async (_finding: PublishedReviewFinding) => {
        expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(
          "https://api.github.com/repos/octocat/hello-world/pulls/42/reviews/7/events",
        );
      });
      const extra = { file: "src/a.ts", line: 99, message: "Outside hunk", severity: "warning" };
      const folded = { file: "src/a.ts", line: 0, message: "File note", severity: "suggestion" };
      fetchMock
        .mockResolvedValueOnce(jsonResponse(fileResponse))
        .mockResolvedValueOnce(jsonResponse({ id: 7 }))
        .mockResolvedValueOnce(jsonResponse([postedComment(91)]))
        .mockResolvedValueOnce(jsonResponse(pr))
        .mockResolvedValueOnce(jsonResponse({ id: 7 }));

      const result = await new GitHubReviewProvider(config).postReviewOverview!(
        cid, 1, publication({ comments: [finding, extra, folded], folded: [folded], onPublicationCreated: created, onFindingPosted: posted }),
      );

      expect(result).toEqual({
        remoteId: "7", advisoryOnly: false,
        findings: [
          { comment: finding, url: `${pr.html_url}#discussion_r91`, providerThreadId: "91", disposition: "inline" },
          { comment: extra, url: null, providerThreadId: null, disposition: "folded" },
          { comment: folded, url: null, providerThreadId: null, disposition: "folded" },
        ],
      });
      expect(created).toHaveBeenCalledWith("7");
      expect(posted.mock.calls.map((call) => call[0])).toEqual(result.findings);
      const calls = fetchMock.mock.calls;
      const pendingBody = JSON.parse((calls[1]?.[1] as RequestInit).body as string);
      expect(pendingBody.event).toBeUndefined();
      // GitHub rejects editing a review whose current body is empty, so the
      // pending draft must be created with a non-empty placeholder.
      expect(pendingBody.body).toEqual(expect.stringMatching(/\S/));
      expect(pendingBody.commit_id).toBe(headSha);
      expect(pendingBody.comments).toEqual([{ path: "src/a.ts", line: 2, body: "Fix this", side: "RIGHT" }]);
      expect(calls[2]?.[0]).toBe("https://api.github.com/repos/octocat/hello-world/pulls/42/reviews/7/comments?per_page=100&page=1");
      expect(calls.some((call) => (call[1] as RequestInit | undefined)?.method === "PUT")).toBe(false);
      expect(calls[4]?.[0]).toBe("https://api.github.com/repos/octocat/hello-world/pulls/42/reviews/7/events");
      const submit = JSON.parse((calls[4]?.[1] as RequestInit).body as string) as { body: string; event: string };
      const overview = submit.body;
      expect(overview).toContain(`[Fix this`);
      expect(overview).toContain(`#discussion_r91`);
      expect(overview).toContain("Outside hunk");
      expect(overview).toContain("File note");
      expect(overview).toContain("🤖 Reviewed by [Virtual Engineer]");
      expect(calls[3]?.[0]).toBe("https://api.github.com/repos/octocat/hello-world/pulls/42");
      expect(submit.event).toBe("REQUEST_CHANGES");
      expect(calls).toHaveLength(5);
    });

    it("matches duplicated locations by body across paginated responses and includes verified previous links", async () => {
      const second = { ...finding, message: "Second", severity: "warning" };
      const page = Array.from({ length: 99 }, (_, i) => postedComment(i + 1, `other ${i}`, 2));
      const comments = Array.from({ length: 99 }, (_, i) => ({ ...finding, message: `other ${i}` }));
      fetchMock
        .mockResolvedValueOnce(jsonResponse(fileResponse))
        .mockResolvedValueOnce(jsonResponse({ id: 7 }))
        .mockResolvedValueOnce(jsonResponse([...page, postedComment(100, second.message)]))
        .mockResolvedValueOnce(jsonResponse([postedComment(101, finding.message)]))
        .mockResolvedValueOnce(jsonResponse(pr))
        .mockResolvedValueOnce(jsonResponse({}));
      const result = await new GitHubReviewProvider(config).postReviewOverview!(
        cid, 1, publication({
          comments: [finding, second, ...comments],
          previous: [{ comment: { ...finding, message: "Old issue" }, url: `${pr.html_url}#discussion_r3` }],
          reReview: true, score: 1,
        }),
      );
      expect(result.findings[0]?.url).toBe(`${pr.html_url}#discussion_r101`);
      expect(result.findings[1]?.url).toBe(`${pr.html_url}#discussion_r100`);
      const body = JSON.parse((fetchMock.mock.calls[5]?.[1] as RequestInit).body as string).body as string;
      expect(body).toContain("Previously reported");
      expect(body).toContain("#discussion_r3");
      expect(JSON.parse((fetchMock.mock.calls[5]?.[1] as RequestInit).body as string).event).toBe("APPROVE");
    });

    it("posts an empty COMMENT overview without inventing links", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ id: 8 }))
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(jsonResponse(pr))
        .mockResolvedValueOnce(jsonResponse({}));
      const result = await new GitHubReviewProvider(config).postReviewOverview!(
        cid, 1, publication({ comments: [], score: 0 }),
      );
      expect(result.findings).toEqual([]);
      expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string).comments).toBeUndefined();
      expect(JSON.parse((fetchMock.mock.calls[3]?.[1] as RequestInit).body as string).event).toBe("COMMENT");
    });

    it("renders verified prior findings without URLs and includes verified fix counts", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ id: 8 }))
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(jsonResponse(pr))
        .mockResolvedValueOnce(jsonResponse({}));
      await new GitHubReviewProvider(config).postReviewOverview!(
        cid, 1, publication({
          comments: [], reReview: true, fixedCount: 2,
          previous: [{ comment: finding, url: null }],
        }),
      );
      const body = JSON.parse((fetchMock.mock.calls[3]?.[1] as RequestInit).body as string).body as string;
      expect(body).toContain("Previously reported");
      expect(body).toContain("2 verified fixes");
      expect(body).not.toContain("](null)");
    });

    it("folds findings for files outside the PR diff instead of submitting invalid inline positions", async () => {
      const unknown = { ...finding, file: "src/missing.ts" };
      fetchMock
        .mockResolvedValueOnce(jsonResponse(fileResponse))
        .mockResolvedValueOnce(jsonResponse({ id: 8 }))
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(jsonResponse(pr))
        .mockResolvedValueOnce(jsonResponse({}));
      const result = await new GitHubReviewProvider(config).postReviewOverview!(
        cid, 1, publication({ comments: [unknown] }),
      );
      expect(result.findings).toEqual([
        { comment: unknown, url: null, providerThreadId: null, disposition: "folded" },
      ]);
      expect(JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string).comments).toBeUndefined();
    });

    it.each([
      { name: "omitted", file: { filename: "assets/picture.png", status: "modified" } },
      { name: "empty", file: { filename: "assets/picture.png", status: "modified", patch: "" } },
    ])("folds a binary finding with an $name patch and keeps valid diff lines inline", async ({ file }) => {
      const binary = { ...finding, file: file.filename, message: "Binary asset needs review" };
      fetchMock
        .mockResolvedValueOnce(jsonResponse([file, ...fileResponse]))
        .mockResolvedValueOnce(jsonResponse({ id: 7 }))
        .mockResolvedValueOnce(jsonResponse([postedComment(91)]))
        .mockResolvedValueOnce(jsonResponse(pr))
        .mockResolvedValueOnce(jsonResponse({ id: 7 }));

      const result = await new GitHubReviewProvider(config).postReviewOverview!(
        cid, 1, publication({ comments: [binary, finding] }),
      );

      const pending = JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string);
      expect(pending.comments).toEqual([{ path: finding.file, line: finding.line, body: finding.message, side: "RIGHT" }]);
      expect(result.findings).toEqual([
        { comment: finding, url: `${pr.html_url}#discussion_r91`, providerThreadId: "91", disposition: "inline" },
        { comment: binary, url: null, providerThreadId: null, disposition: "folded" },
      ]);
      const body = JSON.parse((fetchMock.mock.calls[4]?.[1] as RequestInit).body as string).body as string;
      expect(body).toContain("Binary asset needs review");
      expect(body).not.toContain("](null)");
    });

    it.each([
      { name: "missing anchor", response: { ...postedComment(9) as object, html_url: pr.html_url } },
      { name: "wrong body", response: postedComment(9, "unrelated") },
      { name: "wrong line", response: postedComment(9, finding.message, 3) },
      { name: "wrong path", response: { ...postedComment(9) as object, path: "src/b.ts" } },
    ])("deletes pending review rather than linking a $name", async ({ response }) => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(fileResponse))
        .mockResolvedValueOnce(jsonResponse({ id: 7 }))
        .mockResolvedValueOnce(jsonResponse([response]))
        .mockResolvedValueOnce(new Response(null, { status: 204 }));
      await expect(new GitHubReviewProvider(config).postReviewOverview!(cid, 1, publication())).rejects.toThrow();
      expect((fetchMock.mock.calls[3]?.[1] as RequestInit).method).toBe("DELETE");
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it("links pending comments returned without line numbers, as the GitHub review comments API does", async () => {
      const second = { ...finding, line: 3 };
      const pending = (id: number): unknown => ({
        id, body: finding.message, path: "src/a.ts", position: id - 90, original_position: id - 90,
        line: undefined, html_url: `${pr.html_url}#discussion_r${id}`,
      });
      fetchMock
        .mockResolvedValueOnce(jsonResponse(fileResponse))
        .mockResolvedValueOnce(jsonResponse({ id: 7 }))
        .mockResolvedValueOnce(jsonResponse([pending(91), pending(92)]))
        .mockResolvedValueOnce(jsonResponse(pr))
        .mockResolvedValueOnce(jsonResponse({ id: 7 }));

      const result = await new GitHubReviewProvider(config).postReviewOverview!(
        cid, 1, publication({ comments: [finding, second] }),
      );

      expect(result.findings.map((entry) => [entry.comment.line, entry.url])).toEqual([
        [2, `${pr.html_url}#discussion_r91`],
        [3, `${pr.html_url}#discussion_r92`],
      ]);
    });

    it("rejects missing pending review ID without attempting an unsafe submission", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({}));
      await expect(new GitHubReviewProvider(config).postReviewOverview!(
        cid, 1, publication({ comments: [] }),
      )).rejects.toThrow(/review ID/i);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("deletes pending review if an inline comment is missing", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(fileResponse))
        .mockResolvedValueOnce(jsonResponse({ id: 7 }))
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(new Response(null, { status: 204 }));
      await expect(new GitHubReviewProvider(config).postReviewOverview!(cid, 1, publication()))
        .rejects.toThrow(/deleted.*missing inline comments/i);
      expect((fetchMock.mock.calls[3]?.[1] as RequestInit).method).toBe("DELETE");
    });

    it("never records pending inline or folded findings if submission fails", async () => {
      const folded = { ...finding, line: 0 };
      const posted = vi.fn(async (_finding: PublishedReviewFinding) => {});
      fetchMock
        .mockResolvedValueOnce(jsonResponse(fileResponse))
        .mockResolvedValueOnce(jsonResponse({ id: 7 }))
        .mockResolvedValueOnce(jsonResponse([postedComment(91)]))
        .mockResolvedValueOnce(jsonResponse({ ...pr, state: "closed" }))
        .mockResolvedValueOnce(new Response(null, { status: 204 }));
      await expect(new GitHubReviewProvider(config).postReviewOverview!(
        cid, 1, publication({ comments: [finding, folded], onFindingPosted: posted }),
      )).rejects.toThrow(/deleted.*no longer open/i);
      expect(posted).not.toHaveBeenCalled();
      expect((fetchMock.mock.calls[4]?.[1] as RequestInit).method).toBe("DELETE");
    });

    it("never records findings if submission request fails and does not delete a potentially submitted review", async () => {
      const posted = vi.fn(async (_finding: PublishedReviewFinding) => {});
      fetchMock
        .mockResolvedValueOnce(jsonResponse(fileResponse))
        .mockResolvedValueOnce(jsonResponse({ id: 7 }))
        .mockResolvedValueOnce(jsonResponse([postedComment(91)]))
        .mockResolvedValueOnce(jsonResponse(pr))
        .mockResolvedValueOnce(new Response("timeout", { status: 503 }));
      await expect(new GitHubReviewProvider(config).postReviewOverview!(
        cid, 1, publication({ onFindingPosted: posted }),
      )).rejects.toThrow(/outcome unknown/i);
      expect(posted).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it("reports a post-submission ledger failure without deleting the published review", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(fileResponse))
        .mockResolvedValueOnce(jsonResponse({ id: 7 }))
        .mockResolvedValueOnce(jsonResponse([postedComment(91)]))
        .mockResolvedValueOnce(jsonResponse(pr))
        .mockResolvedValueOnce(jsonResponse({ id: 7 }));
      const callback = vi.fn(async () => { throw new Error("persistence failed"); });
      await expect(new GitHubReviewProvider(config).postReviewOverview!(
        cid, 1, publication({ onFindingPosted: callback }),
      )).rejects.toThrow(/submitted.*persistence failed/i);
      expect(callback).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it("cleans up when the pre-submit PR check fails", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ id: 7 }))
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
        .mockResolvedValueOnce(new Response(null, { status: 204 }));
      await expect(new GitHubReviewProvider(config).postReviewOverview!(
        cid, 1, publication({ comments: [] }),
      )).rejects.toThrow(/deleted.*503/);
      expect((fetchMock.mock.calls[3]?.[1] as RequestInit).method).toBe("DELETE");
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it("requires the captured head SHA before creating a pending review", async () => {
      const details = { ...publication().details, headSha: undefined };
      await expect(new GitHubReviewProvider(config).postReviewOverview!(
        cid, 1, publication({ comments: [], details }),
      )).rejects.toThrow(/known head SHA/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("deletes pending review and never submits on a newer head", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ id: 7 }))
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(jsonResponse({ ...pr, head: { ...pr.head, sha: "b".repeat(40) } }))
        .mockResolvedValueOnce(new Response(null, { status: 204 }));
      await expect(new GitHubReviewProvider(config).postReviewOverview!(
        cid, 1, publication({ comments: [] }),
      )).rejects.toThrow(/deleted.*reviewed head SHA/);
      expect((fetchMock.mock.calls[3]?.[1] as RequestInit).method).toBe("DELETE");
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it("does not submit on a changed head and surfaces failed cleanup", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ id: 7 }))
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(jsonResponse({ ...pr, head: { ...pr.head, sha: "b".repeat(40) } }))
        .mockResolvedValueOnce(new Response("cleanup failed", { status: 500 }));
      const error = await new GitHubReviewProvider(config).postReviewOverview!(
        cid, 1, publication({ comments: [] }),
      ).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as Error).message).toMatch(/cleanup failed.*draft may remain/i);
      expect((fetchMock.mock.calls[3]?.[1] as RequestInit).method).toBe("DELETE");
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it("cleans up an aborted pending review and never submits", async () => {
      const controller = new AbortController();
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ id: 7 }))
        .mockImplementationOnce(() => {
          controller.abort();
          return Promise.resolve(jsonResponse([]));
        })
        .mockResolvedValueOnce(new Response(null, { status: 204 }));
      await expect(new GitHubReviewProvider(config).postReviewOverview!(
        cid, 1, publication({ comments: [] }), controller.signal,
      )).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect((fetchMock.mock.calls[2]?.[1] as RequestInit).signal).toBeUndefined();
    });
  });
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
    expect(r.headSha).toBe("abc");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/octocat/hello-world/pulls/42",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer ghp_test" }) })
    );
  });

  describe("reviewer assignment", () => {
    it("confirms VE is a requested reviewer", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({
          number: 42,
          state: "open",
          title: "t",
          html_url: "u",
          merged: false,
          user: { login: "alice", id: 123 },
          base: { ref: "main", repo: { full_name: "octocat/hello-world" } },
          head: { ref: "feature", sha: "abc" },
        }))
        .mockResolvedValueOnce(jsonResponse({ users: [{ login: "ve-bot" }], teams: [] }));

      await expect(new GitHubReviewProvider(config).isReviewer(cid)).resolves.toBe(true);
    });

    it("requests VE without replacing existing requested reviewers", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({
          number: 42,
          state: "open",
          title: "t",
          html_url: "u",
          merged: false,
          user: { login: "alice", id: 123 },
          base: { ref: "main", repo: { full_name: "octocat/hello-world" } },
          head: { ref: "feature", sha: "abc" },
        }))
        .mockResolvedValueOnce(jsonResponse({ users: [{ login: "alice-reviewer" }], teams: [{ slug: "maintainers" }] }))
        .mockResolvedValueOnce(jsonResponse({}));

      await new GitHubReviewProvider(config).ensureReviewerAssignment(cid);

      expect(fetchMock).toHaveBeenLastCalledWith(
        "https://api.github.com/repos/octocat/hello-world/pulls/42/requested_reviewers",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ reviewers: ["ve-bot"], team_reviewers: [] }),
        }),
      );
    });

    it("retries reviewer identity lookup after a transient failure", async () => {
      const configWithoutLogin = {
        apiBaseUrl: config.apiBaseUrl,
        owner: config.owner,
        repo: config.repo,
        token: config.token,
      };
      const pr = {
        number: 42,
        state: "open",
        title: "t",
        html_url: "u",
        merged: false,
        user: { login: "alice", id: 123 },
        base: { ref: "main", repo: { full_name: "octocat/hello-world" } },
        head: { ref: "feature", sha: "abc" },
      };
      fetchMock
        .mockResolvedValueOnce(jsonResponse(pr))
        .mockRejectedValueOnce(new Error("temporary /user failure"))
        .mockResolvedValueOnce(jsonResponse(pr))
        .mockResolvedValueOnce(jsonResponse({ login: "ve-bot" }))
        .mockResolvedValueOnce(jsonResponse({ users: [{ login: "ve-bot" }], teams: [] }));

      const provider = new GitHubReviewProvider(configWithoutLogin);
      await expect(provider.isReviewer(cid)).rejects.toThrow("temporary /user failure");
      await expect(provider.isReviewer(cid)).resolves.toBe(true);
    });
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
    expect(r.files[3]?.patch).toBe("");
  });

  it("getChangeDiff includes later file pages and keeps binary files without synthetic patches", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      filename: `src/changed-${index}.ts`, status: "modified", patch: "@@ -1 +1 @@\n+one",
    }));
    const controller = new AbortController();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(jsonResponse([
        { filename: "assets/picture.png", status: "added", additions: 0, deletions: 0, changes: 0 },
        { filename: "src/late.ts", status: "modified", patch: "@@ -1 +1 @@\n+late" },
      ]));
    const result = await new GitHubReviewProvider(config).getChangeDiff(cid, 42, controller.signal);
    expect(result.files).toHaveLength(102);
    expect(result.files.at(-2)).toEqual({ path: "assets/picture.png", status: "added", patch: "" });
    expect(result.files.at(-1)?.path).toBe("src/late.ts");
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "https://api.github.com/repos/octocat/hello-world/pulls/42/files?per_page=100&page=1",
      "https://api.github.com/repos/octocat/hello-world/pulls/42/files?per_page=100&page=2",
    ]);
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).signal).toBe(controller.signal);
  });

  it("getChangeDiff refuses a full 3,000-file response rather than returning a truncated prompt", async () => {
    const page = Array.from({ length: 100 }, (_, index) => ({
      filename: `src/changed-${index}.ts`, status: "modified", patch: "@@ -1 +1 @@\n+one",
    }));
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(page)));
    await expect(new GitHubReviewProvider(config).getChangeDiff(cid))
      .rejects.toThrow(/3,000.*complete/i);
    expect(fetchMock).toHaveBeenCalledTimes(30);
  });

  it("getChangeDiff rejects an overfull file page rather than exceeding the 3,000-file bound", async () => {
    const page = Array.from({ length: 101 }, (_, index) => ({
      filename: `src/changed-${index}.ts`, status: "modified", patch: "@@ -1 +1 @@\n+one",
    }));
    fetchMock.mockResolvedValueOnce(jsonResponse(page));
    await expect(new GitHubReviewProvider(config).getChangeDiff(cid))
      .rejects.toThrow(/more than 100/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("getChangeDiff echoes the requested patchset", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([
      { filename: "src/a.ts", status: "modified", patch: "@@\n+new" },
    ]));
    const r = await new GitHubReviewProvider(config).getChangeDiff(cid, 42);
    expect(r.patchset).toBe(42);
  });

  it("getChangeDiff fetches every page of PR files", async () => {
    const firstPage = Array.from({ length: 100 }, (_, i) => ({
      filename: `src/file-${i}.ts`, status: "modified", patch: `+${i}`,
    }));
    fetchMock
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(jsonResponse([
        { filename: "src/last.ts", status: "added", patch: "+last" },
      ]));

    const result = await new GitHubReviewProvider(config).getChangeDiff(cid);
    expect(result.files).toHaveLength(101);
    expect(result.files[100]?.patch).toBe("+last");
    expect(fetchMock.mock.calls[1]?.[0]).toContain("/files?per_page=100&page=2");
  });

  it("rejects PR files with unavailable patches instead of approving an incomplete review", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([
      { filename: "src/missing.ts", status: "modified", additions: 4000, deletions: 12, changes: 4012 },
    ]));
    await expect(new GitHubReviewProvider(config).getChangeDiff(cid))
      .rejects.toThrow(/patch.*src\/missing\.ts/i);
  });

  it("rejects PR files missing both patch and line counts", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([
      { filename: "src/missing.ts", status: "modified" },
    ]));
    await expect(new GitHubReviewProvider(config).getChangeDiff(cid))
      .rejects.toThrow(/patch.*src\/missing\.ts/i);
  });

  it("accepts binary files and pure renames that GitHub lists without a patch", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([
      { filename: "docs/logo.png", status: "added", additions: 0, deletions: 0, changes: 0 },
      { filename: "src/new-name.ts", status: "renamed", additions: 0, deletions: 0, changes: 0 },
      { filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+new" },
    ]));
    const result = await new GitHubReviewProvider(config).getChangeDiff(cid);
    expect(result.files).toEqual([
      { path: "docs/logo.png", status: "added", patch: "" },
      { path: "src/new-name.ts", status: "renamed", patch: "" },
      { path: "src/a.ts", status: "modified", patch: "@@\n+new" },
    ]);
  });

  it("tolerates oversized generated files (Drizzle snapshots, lockfiles) without a patch", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([
      { filename: "drizzle/meta/0009_snapshot.json", status: "added", additions: 9000, deletions: 0, changes: 9000 },
      { filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+new" },
    ]));
    const result = await new GitHubReviewProvider(config).getChangeDiff(cid);
    expect(result.files).toEqual([
      { path: "drizzle/meta/0009_snapshot.json", status: "added", patch: "" },
      { path: "src/a.ts", status: "modified", patch: "@@\n+new" },
    ]);
  });

  it("getInterPatchsetDiff compares the old reviewed commit with the current head", async () => {
    const fromSha = "1111111111111aaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const toSha = "2222222222222bbbbbbbbbbbbbbbbbbbbbbbbb";
    const fromPatchset = patchsetFromRevisionSha(fromSha);
    const toPatchset = patchsetFromRevisionSha(toSha);
    const details: ReviewChangeDetails = {
      changeId: cid,
      changeNumber: 42,
      subject: "Add feature X",
      description: "",
      ownerAccountId: "123",
      currentPatchset: toPatchset,
      status: "OPEN",
      project: "octocat/hello-world",
      targetBranch: "main",
      url: "https://github.com/octocat/hello-world/pull/42",
    };

    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        number: 42,
        state: "open",
        title: "Add feature X",
        html_url: "https://github.com/octocat/hello-world/pull/42",
        merged: false,
        base: { ref: "main", repo: { full_name: "octocat/hello-world" } },
        head: { ref: "feature-x", sha: toSha },
      }))
      .mockResolvedValueOnce(jsonResponse([{ sha: fromSha }]))
      .mockResolvedValueOnce(jsonResponse({
        files: [{ filename: "src/a.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" }],
      }));

    const result = await new GitHubReviewProvider(config).getInterPatchsetDiff(
      details,
      fromPatchset,
      toPatchset,
    );

    expect(result).toEqual({
      changeId: cid,
      patchset: toPatchset,
      files: [{ path: "src/a.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" }],
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/octocat/hello-world/pulls/42"
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://api.github.com/repos/octocat/hello-world/pulls/42/commits?per_page=100&page=1"
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      `https://api.github.com/repos/octocat/hello-world/compare/${fromSha}...${toSha}?per_page=300`
    );
  });

  it("getInterPatchsetDiff rejects compared text files whose patch GitHub omitted", async () => {
    const fromSha = "1111111111111aaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const toSha = "2222222222222bbbbbbbbbbbbbbbbbbbbbbbbb";
    const details: ReviewChangeDetails = {
      changeId: cid,
      changeNumber: 42,
      subject: "Add feature X",
      description: "",
      ownerAccountId: "123",
      currentPatchset: patchsetFromRevisionSha(toSha),
      status: "OPEN",
      project: "octocat/hello-world",
      targetBranch: "main",
      url: "https://github.com/octocat/hello-world/pull/42",
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        number: 42,
        state: "open",
        title: "Add feature X",
        html_url: "https://github.com/octocat/hello-world/pull/42",
        merged: false,
        base: { ref: "main", repo: { full_name: "octocat/hello-world" } },
        head: { ref: "feature-x", sha: toSha },
      }))
      .mockResolvedValueOnce(jsonResponse([{ sha: fromSha }]))
      .mockResolvedValueOnce(jsonResponse({
        files: [
          { filename: "docs/logo.png", status: "modified", additions: 0, deletions: 0, changes: 0 },
          { filename: "src/huge.ts", status: "modified", additions: 9000, deletions: 0, changes: 9000 },
        ],
      }));

    await expect(new GitHubReviewProvider(config).getInterPatchsetDiff(
      details,
      patchsetFromRevisionSha(fromSha),
      patchsetFromRevisionSha(toSha),
    )).rejects.toThrow(/patch.*src\/huge\.ts/i);
  });

  it("postReviewWithComments posts an APPROVE review with inline comments", async () => {
    // First call: files fetch for line validation; src/a.ts has line 10 in hunk
    fetchMock.mockResolvedValueOnce(jsonResponse([
      { filename: "src/a.ts", status: "modified", patch: "@@ -8,5 +8,5 @@\n line8\n line9\n line10\n line11\n line12" },
    ]));
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1 }));
    const controller = new AbortController();
    await new GitHubReviewProvider(config).postReviewWithComments!(
      cid, 1,
      [{ file: "src/a.ts", line: 10, message: "nit", severity: "suggestion" }],
      "LGTM",
      1,
      undefined,
      controller.signal,
    );
    // First call is the files fetch, second is the review POST
    const reviewCall = fetchMock.mock.calls[1];
    expect(reviewCall?.[0]).toBe("https://api.github.com/repos/octocat/hello-world/pulls/42/reviews");
    const init = reviewCall?.[1] as RequestInit;
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal).toBe(controller.signal);
    expect(init.signal).toBe(controller.signal);
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

  it("postReviewWithComments posts COMMENT for a neutral decision", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1 }));
    await new GitHubReviewProvider(config).postReviewWithComments!(cid, 1, [], "Notes only", 0);
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.event).toBe("COMMENT");
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
      // 1) viewer login lookup, 2) submitted reviews, 3) reviewThreads page.
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ data: { viewer: { login: "ve-bot" } } }))
        .mockResolvedValueOnce(jsonResponse([
          { state: "COMMENTED", user: { login: "alice" }, commit_id: "sha-a" },
          { state: "COMMENTED", user: { login: "bob" }, commit_id: "sha-b" },
          { state: "COMMENTED", user: { login: "ve-bot" }, commit_id: "sha-ve" },
          { state: "PENDING", user: { login: "charlie" }, commit_id: "sha-pending" },
        ]))
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
                      {
                        id: "THREAD_3",
                        isResolved: false,
                        path: "src/c.ts",
                        line: 7,
                        comments: { nodes: [{ body: "outsider comment", author: { login: "charlie" } }] },
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
      expect(threads.find((t) => t.threadId === "THREAD_3")).toBeUndefined();

      // First GraphQL call hit the api.github.com/graphql endpoint.
      expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.github.com/graphql");
    });

    it("passes the abort signal through paginated patchset lookup", async () => {
      const fromSha = "1111111111111aaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const toSha = "2222222222222bbbbbbbbbbbbbbbbbbbbbbbbb";
      const details: ReviewChangeDetails = {
        changeId: cid,
        changeNumber: 42,
        subject: "Add feature X",
        description: "",
        ownerAccountId: "123",
        currentPatchset: patchsetFromRevisionSha(toSha),
        status: "OPEN",
        project: "octocat/hello-world",
        targetBranch: "main",
        url: "https://github.com/octocat/hello-world/pull/42",
      };
      const controller = new AbortController();
      const fullPage = Array.from({ length: 100 }, () => ({ sha: "a".repeat(40) }));
      let commitPageCalls = 0;

      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/pulls/42")) {
          return jsonResponse({
            number: 42,
            state: "open",
            title: "Add feature X",
            html_url: "https://github.com/octocat/hello-world/pull/42",
            merged: false,
            base: { ref: "main", repo: { full_name: "octocat/hello-world" } },
            head: { ref: "feature-x", sha: toSha },
          });
        }
        if (url.includes("/commits?")) {
          commitPageCalls += 1;
          expect(init?.signal).toBe(controller.signal);
          controller.abort();
          return jsonResponse(fullPage);
        }
        throw new Error(`unexpected request: ${url}`);
      });

      await expect(
        new GitHubReviewProvider(config).getInterPatchsetDiff(
          details,
          patchsetFromRevisionSha(fromSha),
          patchsetFromRevisionSha(toSha),
          controller.signal,
        )
      ).rejects.toThrow();
      expect(commitPageCalls).toBe(1);
    });

    it("redacts credential-bearing GraphQL error messages", async () => {
      const secret = "github-graphql-sensitive-value";
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ errors: [{ message: `invalid token=${secret}` }] }),
      );

      const err = await new GitHubReviewProvider(config)
        .postThreadReply(cid, 1, "THREAD_1", "reply")
        .catch((error: unknown) => error) as Error;

      expect(err.message).not.toContain(secret);
      expect(err.message).toContain("<redacted>");
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

    it("paginates past a full first page to find VE's review on a later page", async () => {
      const fullPage = Array.from({ length: 100 }, (_, i) => ({
        user: { login: "alice" }, state: "COMMENTED", commit_id: `sha${i}`,
      }));
      fetchMock
        .mockResolvedValueOnce(jsonResponse(prBody("headsha123"))) // PR fetch
        .mockResolvedValueOnce(jsonResponse({ data: { viewer: { login: "ve-bot" } } })) // viewer
        .mockResolvedValueOnce(jsonResponse(fullPage)) // page 1 (full, no match)
        .mockResolvedValueOnce(jsonResponse([
          { user: { login: "ve-bot" }, state: "APPROVED", commit_id: "headsha123" },
        ])); // page 2 (match)
      expect(await new GitHubReviewProvider(config).hasReviewedCurrentPatchset(cid)).toBe(true);
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
