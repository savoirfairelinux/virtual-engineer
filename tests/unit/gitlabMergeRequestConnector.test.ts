import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  GitLabMergeRequestConnector,
  GitLabMrApiError,
  GitLabMrNotFoundError,
} from "../../src/connectors/gitlabMergeRequestConnector.js";
import { makeExternalChangeId, ReviewNotFoundError, ReviewApiError, ApiHttpError } from "../../src/interfaces.js";
import {
  gitlabMr,
  gitlabMrMerged,
  gitlabMrClosed,
  gitlabMrLocked,
  gitlabDiscussionsResponse,
  jsonResponse,
  errorResponse,
} from "./helpers/fixtures.js";

const BASE_URL = "https://gitlab.test";
const PROJECT_ID = "12345";
const TOKEN = "glpat-test-token";
const MR_ID = makeExternalChangeId("42");

function makeConnector() {
  return new GitLabMergeRequestConnector({
    baseUrl: BASE_URL,
    projectId: PROJECT_ID,
    token: TOKEN,
  });
}

describe("GitLabMergeRequestConnector", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ─── getChange ─────────────────────────────────────────────────────────────

  describe("getChange", () => {
    it("returns a GerritChangeRef with MR iid and web_url", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(gitlabMr));

      const ref = await makeConnector().getChange(MR_ID);

      expect(ref.changeId).toBe(MR_ID);
      expect(ref.changeNumber).toBe(42);
      expect(ref.patchsetNumber).toBe(1);
      expect(ref.url).toBe(gitlabMr.web_url);
    });

    it("sends Authorization Bearer header", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(gitlabMr));

      await makeConnector().getChange(MR_ID);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = init?.headers as Record<string, string>;
      expect(headers?.["Authorization"]).toBe(`Bearer ${TOKEN}`);
    });

    it("calls the correct project MR endpoint", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(gitlabMr));

      await makeConnector().getChange(MR_ID);

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toBe(`${BASE_URL}/api/v4/projects/${PROJECT_ID}/merge_requests/42`);
    });

    it("throws GitLabMrNotFoundError on 404", async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(404, "Not Found"));
      const err = await makeConnector().getChange(MR_ID).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GitLabMrNotFoundError);
      expect(err).toBeInstanceOf(ReviewNotFoundError);
      expect(err).toBeInstanceOf(ReviewApiError);
      expect(err).toBeInstanceOf(ApiHttpError);
      expect((err as GitLabMrNotFoundError).statusCode).toBe(404);
    });

    it("throws on invalid changeId (non-numeric)", async () => {
      await expect(
        makeConnector().getChange(makeExternalChangeId("not-a-number"))
      ).rejects.toThrow("Invalid GitLab MR number");
    });
  });

  // ─── getChangeStatus ───────────────────────────────────────────────────────

  describe("getChangeStatus", () => {
    it("maps 'opened' to OPEN", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(gitlabMr));
      expect(await makeConnector().getChangeStatus(MR_ID)).toBe("OPEN");
    });

    it("maps 'merged' to MERGED", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(gitlabMrMerged));
      expect(await makeConnector().getChangeStatus(MR_ID)).toBe("MERGED");
    });

    it("maps 'closed' to ABANDONED", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(gitlabMrClosed));
      expect(await makeConnector().getChangeStatus(MR_ID)).toBe("ABANDONED");
    });

    it("maps 'locked' to ABANDONED", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(gitlabMrLocked));
      expect(await makeConnector().getChangeStatus(MR_ID)).toBe("ABANDONED");
    });

    it("returns OPEN for unknown states", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ...gitlabMr, state: "unknown_state" }));
      expect(await makeConnector().getChangeStatus(MR_ID)).toBe("OPEN");
    });
  });

  // ─── getUnresolvedComments ─────────────────────────────────────────────────

  describe("getUnresolvedComments", () => {
    it("returns only unresolved non-system discussions", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(gitlabDiscussionsResponse));

      const comments = await makeConnector().getUnresolvedComments(MR_ID);

      // disc-1 (unresolved) and disc-3 (unresolved) should be returned
      // disc-2 (resolved) should be filtered out
      expect(comments).toHaveLength(2);
    });

    it("maps discussion id to GerritComment.id for dedup", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(gitlabDiscussionsResponse));

      const comments = await makeConnector().getUnresolvedComments(MR_ID);

      expect(comments[0]?.id).toBe("disc-1");
      expect(comments[1]?.id).toBe("disc-3");
    });

    it("maps note author username to comment author", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(gitlabDiscussionsResponse));

      const comments = await makeConnector().getUnresolvedComments(MR_ID);

      expect(comments[0]?.author).toBe("reviewer");
    });

    it("extracts file path and line from note position", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(gitlabDiscussionsResponse));

      const comments = await makeConnector().getUnresolvedComments(MR_ID);

      expect(comments[0]?.filePath).toBe("src/service.ts");
      expect(comments[0]?.line).toBe(42);
    });

    it("returns undefined filePath for notes without position", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(gitlabDiscussionsResponse));

      const comments = await makeConnector().getUnresolvedComments(MR_ID);

      // disc-3 has no position
      expect(comments[1]?.filePath).toBeUndefined();
      expect(comments[1]?.line).toBeUndefined();
    });

    it("marks all returned comments as unresolved=true", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(gitlabDiscussionsResponse));

      const comments = await makeConnector().getUnresolvedComments(MR_ID);

      for (const c of comments) {
        expect(c.unresolved).toBe(true);
      }
    });

    it("returns empty array when all discussions are resolved", async () => {
      const allResolved = gitlabDiscussionsResponse.map((d) => ({ ...d, resolved: true }));
      fetchMock.mockResolvedValueOnce(jsonResponse(allResolved));

      const comments = await makeConnector().getUnresolvedComments(MR_ID);
      expect(comments).toHaveLength(0);
    });

    it("ignores sincePatchset (GitLab has no patchsets)", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(gitlabDiscussionsResponse));

      // sincePatchset=99 should not filter out any comments
      const comments = await makeConnector().getUnresolvedComments(MR_ID, 99);
      expect(comments).toHaveLength(2);
    });
  });

  // ─── addChangeComment ──────────────────────────────────────────────────────

  describe("addChangeComment", () => {
    it("posts a note to the MR", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1, body: "hello" }));

      await makeConnector().addChangeComment(MR_ID, "hello from ve");

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain(`/merge_requests/42/notes`);
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string).body).toBe("hello from ve");
    });

    it("throws GitLabMrApiError on failure", async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(403, "Forbidden"));
      await expect(makeConnector().addChangeComment(MR_ID, "msg")).rejects.toThrow(GitLabMrApiError);
    });
  });

  // ─── resolveComments ──────────────────────────────────────────────────────

  describe("resolveComments", () => {
    it("does nothing when comments array is empty", async () => {
      await makeConnector().resolveComments(MR_ID, []);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("sends PUT resolve request for each discussion", async () => {
      fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ resolved: true })));

      const comments = [
        { id: "disc-1", author: "r", message: "fix this", unresolved: true, patchset: 0, updatedAt: new Date() },
        { id: "disc-3", author: "r", message: "lgtm", unresolved: true, patchset: 0, updatedAt: new Date() },
      ];

      await makeConnector().resolveComments(MR_ID, comments);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [url1, init1] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url1).toContain("/discussions/disc-1/resolve");
      expect(init1.method).toBe("PUT");
      expect(JSON.parse(init1.body as string)).toMatchObject({ resolved: true });

      const [url2] = fetchMock.mock.calls[1] as [string];
      expect(url2).toContain("/discussions/disc-3/resolve");
    });
  });

  // ─── GitLabMrApiError / GitLabMrNotFoundError ─────────────────────────────

  describe("GitLabMrApiError", () => {
    it("includes status, url, and body", () => {
      const err = new GitLabMrApiError(422, "https://gitlab.test/api/v4/...", "Unprocessable");
      expect(err.message).toContain("422");
      expect(err.message).toContain("Unprocessable");
      expect(err.name).toBe("GitLabMrApiError");
    });

    it("is instanceof ReviewApiError", () => {
      expect(new GitLabMrApiError(500, "/url", "err")).toBeInstanceOf(ReviewApiError);
    });
  });

  describe("GitLabMrNotFoundError", () => {
    it("is instanceof ReviewNotFoundError and ReviewApiError", () => {
      const err = new GitLabMrNotFoundError(404, "/url", "Not Found");
      expect(err).toBeInstanceOf(ReviewNotFoundError);
      expect(err).toBeInstanceOf(ReviewApiError);
      expect(err).toBeInstanceOf(ApiHttpError);
      expect(err.name).toBe("GitLabMrNotFoundError");
      expect(err.statusCode).toBe(404);
    });
  });
});
