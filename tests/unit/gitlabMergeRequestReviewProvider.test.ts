import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitLabMergeRequestReviewProvider } from "../../src/connectors/gitlabMergeRequestReviewProvider.js";
import type { ExternalChangeId } from "../../src/interfaces.js";

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

const config = {
  baseUrl: "https://gitlab.example.com",
  projectId: 100,
  token: "glpat_test",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const cid = "42" as unknown as ExternalChangeId;

const MR_BODY = {
  iid: 42,
  state: "opened",
  title: "Add feature X",
  description: "Description here.",
  web_url: "https://gitlab.example.com/group/proj/-/merge_requests/42",
  target_branch: "main",
  source_branch: "feature-x",
  project_id: 100,
  author: { id: 7, username: "alice" },
  references: { full: "group/proj!42" },
  diff_refs: { base_sha: "base", head_sha: "head", start_sha: "start" },
};

const CHANGES_BODY = {
  diff_refs: { base_sha: "base", head_sha: "head", start_sha: "start" },
  changes: [
    {
      old_path: "src/a.ts",
      new_path: "src/a.ts",
      new_file: false,
      renamed_file: false,
      deleted_file: false,
      diff: "@@ -1 +1,2 @@\n context\n+added line",
    },
  ],
};

beforeEach(() => {
  fetchMock.mockReset();
});

describe("GitLabMergeRequestReviewProvider", () => {
  it("getChangeDetails maps an open MR to OPEN and resolves the project path", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(MR_BODY));
    const p = new GitLabMergeRequestReviewProvider(config);
    const r = await p.getChangeDetails(cid);
    expect(r.status).toBe("OPEN");
    expect(r.changeNumber).toBe(42);
    expect(r.targetBranch).toBe("main");
    expect(r.project).toBe("group/proj");
    expect(r.ownerAccountId).toBe("7");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gitlab.example.com/api/v4/projects/100/merge_requests/42",
      expect.objectContaining({ headers: expect.anything() })
    );
  });

  it("maps merged and closed MRs to MERGED / ABANDONED", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...MR_BODY, state: "merged" }));
    expect((await new GitLabMergeRequestReviewProvider(config).getChangeDetails(cid)).status).toBe("MERGED");
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...MR_BODY, state: "closed" }));
    expect((await new GitLabMergeRequestReviewProvider(config).getChangeDetails(cid)).status).toBe("ABANDONED");
  });

  it("parses a project-prefixed changeId", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(MR_BODY));
    const p = new GitLabMergeRequestReviewProvider(config);
    await p.getChangeDetails("group/proj#42" as unknown as ExternalChangeId);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gitlab.example.com/api/v4/projects/group%2Fproj/merge_requests/42",
      expect.anything()
    );
  });

  it("getChangeDiff maps the MR changes to review diff files", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(CHANGES_BODY));
    const p = new GitLabMergeRequestReviewProvider(config);
    const diff = await p.getChangeDiff(cid);
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]?.path).toBe("src/a.ts");
    expect(diff.files[0]?.status).toBe("modified");
  });

  it("postReviewWithComments posts inline discussions, a summary note, and approves on +1", async () => {
    // 1) fetch changes (line validation + diff_refs), 2) discussion, 3) note, 4) approve
    fetchMock
      .mockResolvedValueOnce(jsonResponse(CHANGES_BODY))
      .mockResolvedValueOnce(jsonResponse({ id: "d1" }))
      .mockResolvedValueOnce(jsonResponse({ id: 1 }))
      .mockResolvedValueOnce(jsonResponse({}));

    const p = new GitLabMergeRequestReviewProvider(config);
    await p.postReviewWithComments(
      cid,
      1,
      [{ file: "src/a.ts", line: 2, message: "Bug here", severity: "error" }],
      "Looks good overall",
      1
    );

    const urls = fetchMock.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(urls).toContain("https://gitlab.example.com/api/v4/projects/100/merge_requests/42/discussions");
    expect(urls).toContain("https://gitlab.example.com/api/v4/projects/100/merge_requests/42/notes");
    expect(urls).toContain("https://gitlab.example.com/api/v4/projects/100/merge_requests/42/approve");
  });

  it("folds out-of-diff comments into the summary note instead of posting them inline", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(CHANGES_BODY)) // line 999 is not in the diff
      .mockResolvedValueOnce(jsonResponse({ id: 1 })); // summary note only

    const p = new GitLabMergeRequestReviewProvider(config);
    await p.postReviewComments(
      cid,
      1,
      [{ file: "src/a.ts", line: 999, message: "Out of range", severity: "warning" }],
      "Summary"
    );

    const calls = fetchMock.mock.calls;
    const discussionCalls = calls.filter((c: unknown[]) => String(c[0]).endsWith("/discussions"));
    expect(discussionCalls).toHaveLength(0);
    const noteCall = calls.find((c: unknown[]) => String(c[0]).endsWith("/notes"));
    expect(noteCall).toBeDefined();
    const body = JSON.parse((noteCall?.[1] as { body: string }).body) as { body: string };
    expect(body.body).toContain("Out of range");
  });

  it("vote(-1) unapproves the MR", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({})); // unapprove (no inline, no note)
    const p = new GitLabMergeRequestReviewProvider(config);
    await p.vote(cid, 1, -1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gitlab.example.com/api/v4/projects/100/merge_requests/42/unapprove",
      expect.objectContaining({ method: "POST" })
    );
  });

  describe("discussion threads", () => {
    it("getDiscussionThreads maps discussions, tags isOwn and resolved", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ id: 9, username: "ve-bot" })) // /api/v4/user
        .mockResolvedValueOnce(
          jsonResponse([
            {
              id: "disc-open",
              individual_note: false,
              notes: [
                {
                  id: 1,
                  body: "Why this approach?",
                  resolvable: true,
                  resolved: false,
                  author: { id: 7, username: "alice" },
                  position: { new_path: "src/a.ts", new_line: 12 },
                },
                {
                  id: 2,
                  body: "Because of X.",
                  resolvable: true,
                  resolved: false,
                  author: { id: 9, username: "ve-bot" },
                },
              ],
            },
            {
              id: "disc-resolved",
              individual_note: false,
              notes: [
                {
                  id: 3,
                  body: "nit",
                  resolvable: true,
                  resolved: true,
                  author: { id: 7, username: "alice" },
                },
              ],
            },
            {
              id: "disc-system",
              individual_note: false,
              notes: [{ id: 4, body: "changed the description", system: true }],
            },
          ])
        );

      const p = new GitLabMergeRequestReviewProvider(config);
      const threads = await p.getDiscussionThreads(cid);

      // The system-only discussion is dropped.
      expect(threads).toHaveLength(2);
      const open = threads.find((t) => t.threadId === "disc-open");
      expect(open?.resolved).toBe(false);
      expect(open?.file).toBe("src/a.ts");
      expect(open?.line).toBe(12);
      expect(open?.comments).toHaveLength(2);
      expect(open?.comments[0]).toEqual({
        author: "alice",
        message: "Why this approach?",
        isOwn: false,
      });
      expect(open?.comments[1]?.isOwn).toBe(true);
      const resolved = threads.find((t) => t.threadId === "disc-resolved");
      expect(resolved?.resolved).toBe(true);
    });

    it("postThreadReply POSTs a note to the discussion", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 99 }));
      const p = new GitLabMergeRequestReviewProvider(config);
      await p.postThreadReply(cid, 1, "disc-open", "Thanks, addressed.");
      expect(fetchMock).toHaveBeenCalledWith(
        "https://gitlab.example.com/api/v4/projects/100/merge_requests/42/discussions/disc-open/notes",
        expect.objectContaining({ method: "POST" })
      );
      const body = JSON.parse(
        (fetchMock.mock.calls[0]?.[1] as { body: string }).body
      ) as { body: string };
      expect(body.body).toBe("Thanks, addressed.");
    });
  });
});

