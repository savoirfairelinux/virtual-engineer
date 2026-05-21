import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  GitLabIssueConnector,
  GitLabApiError,
  GitLabNotFoundError,
} from "../../src/connectors/gitlabIssueConnector.js";
import { makeTicketId, TicketNotFoundError, TicketApiError } from "../../src/interfaces.js";
import {
  gitlabUser,
  gitlabIssue,
  gitlabIssueNoAssignee,
  gitlabIssuesListResponse,
  jsonResponse,
  errorResponse,
} from "./helpers/fixtures.js";

const BASE_URL = "https://gitlab.test";
const PROJECT_ID = "12345";
const PROJECT_PATH = "root/demo-gitlab";
const ENCODED_PROJECT_PATH = "root%2Fdemo-gitlab";
const TOKEN = "glpat-test-token";
const IN_PROGRESS_LABEL = "triage";
const IN_REVIEW_LABEL = "review-ready";

function makeConnector(
  overrides?: Partial<ConstructorParameters<typeof GitLabIssueConnector>[0]>
) {
  return new GitLabIssueConnector({
    baseUrl: BASE_URL,
    projectId: PROJECT_ID,
    token: TOKEN,
    closedStatusId: 0,
    inProgressStatusId: 1,
    inReviewStatusId: 2,
    inProgressLabel: IN_PROGRESS_LABEL,
    inReviewLabel: IN_REVIEW_LABEL,
    ...overrides,
  });
}

describe("GitLabIssueConnector", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ─── getAssignedTickets ────────────────────────────────────────────────────

  describe("getAssignedTickets", () => {
    it("calls /api/v4/user then fetches issues assigned to that user", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(gitlabUser))
        .mockResolvedValueOnce(jsonResponse(gitlabIssuesListResponse));

      await makeConnector().getAssignedTickets();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [userUrl] = fetchMock.mock.calls[0] as [string];
      expect(userUrl).toBe(`${BASE_URL}/api/v4/user`);
      const [issuesUrl] = fetchMock.mock.calls[1] as [string];
      expect(issuesUrl).toContain(`assignee_id=42`);
      expect(issuesUrl).toContain("state=opened");
    });

    it("maps GitLab issues to Ticket shape", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(gitlabUser))
        .mockResolvedValueOnce(jsonResponse(gitlabIssuesListResponse));

      const tickets = await makeConnector().getAssignedTickets();

      expect(tickets).toHaveLength(1);
      expect(tickets[0]?.id).toBe("7");
      expect(tickets[0]?.subject).toBe("Add logging to service");
      expect(tickets[0]?.description).toBe(gitlabIssue.description);
      expect(tickets[0]?.status).toBe("opened");
      expect(tickets[0]?.assigneeId).toBe(42);
      expect(tickets[0]?.projectId).toBe(12345);
    });

    it("maps labels into customFields", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(gitlabUser))
        .mockResolvedValueOnce(jsonResponse(gitlabIssuesListResponse));

      const tickets = await makeConnector().getAssignedTickets();
      expect(tickets[0]?.customFields?.["backend"]).toBe("backend");
      expect(tickets[0]?.customFields?.["status::in-progress"]).toBe("status::in-progress");
    });

    it("sends Authorization Bearer header", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(gitlabUser))
        .mockResolvedValueOnce(jsonResponse(gitlabIssuesListResponse));

      await makeConnector().getAssignedTickets();

      const [, userInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = userInit?.headers as Record<string, string>;
      expect(headers?.["Authorization"]).toBe(`Bearer ${TOKEN}`);
    });

    it("returns empty array when no issues assigned", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(gitlabUser))
        .mockResolvedValueOnce(jsonResponse([]));

      const tickets = await makeConnector().getAssignedTickets();
      expect(tickets).toHaveLength(0);
    });

    it("uses assignee.id = 0 when assignee is null", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(gitlabUser))
        .mockResolvedValueOnce(jsonResponse([gitlabIssueNoAssignee]));

      const tickets = await makeConnector().getAssignedTickets();
      expect(tickets[0]?.assigneeId).toBe(0);
    });

    it("throws GitLabApiError on non-OK response", async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(401, "Unauthorized"));

      await expect(makeConnector().getAssignedTickets()).rejects.toThrow(GitLabApiError);
    });

    it("encodes project path slugs in project-scoped issue list URLs", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(gitlabUser))
        .mockResolvedValueOnce(jsonResponse(gitlabIssuesListResponse));

      await makeConnector({ projectId: PROJECT_PATH }).getAssignedTickets();

      const [issuesUrl] = fetchMock.mock.calls[1] as [string];
      expect(issuesUrl).toContain(`/projects/${ENCODED_PROJECT_PATH}/issues`);
    });

    it("does not double-encode project path slugs that are already encoded", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(gitlabUser))
        .mockResolvedValueOnce(jsonResponse(gitlabIssuesListResponse));

      await makeConnector({ projectId: ENCODED_PROJECT_PATH }).getAssignedTickets();

      const [issuesUrl] = fetchMock.mock.calls[1] as [string];
      expect(issuesUrl).toContain(`/projects/${ENCODED_PROJECT_PATH}/issues`);
      expect(issuesUrl).not.toContain("%252F");
    });

    it("Phase 4: opts.projectKey overrides the configured projectId in the URL", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(gitlabUser))
        .mockResolvedValueOnce(jsonResponse(gitlabIssuesListResponse));

      await makeConnector({ projectId: "1" }).getAssignedTickets({ projectKey: "my-org/sdk" });

      const [issuesUrl] = fetchMock.mock.calls[1] as [string];
      expect(issuesUrl).toContain(`/projects/${encodeURIComponent("my-org/sdk")}/issues`);
      expect(issuesUrl).not.toContain("/projects/1/");
    });
  });

  // ─── getTicket ─────────────────────────────────────────────────────────────

  describe("getTicket", () => {
    it("fetches a single issue by IID", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(gitlabIssue));

      const ticket = await makeConnector().getTicket(makeTicketId("7"));

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toContain(`/issues/7`);
      expect(ticket.id).toBe("7");
      expect(ticket.subject).toBe(gitlabIssue.title);
    });

    it("throws GitLabNotFoundError on 404", async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(404, "Not Found"));
      const err = await makeConnector().getTicket(makeTicketId("999")).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GitLabNotFoundError);
      expect(err).toBeInstanceOf(TicketNotFoundError);
      expect(err).toBeInstanceOf(TicketApiError);
      expect((err as GitLabNotFoundError).statusCode).toBe(404);
    });

    it("encodes project path slugs in project-scoped issue detail URLs", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(gitlabIssue));

      await makeConnector({ projectId: PROJECT_PATH }).getTicket(makeTicketId("7"));

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toContain(`/projects/${ENCODED_PROJECT_PATH}/issues/7`);
    });
  });

  // ─── transitionStatus ─────────────────────────────────────────────────────

  describe("transitionStatus", () => {
    it("closes the issue when targetStatusId matches closedStatusId", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ iid: 7, state: "closed" }));

      await makeConnector().transitionStatus(makeTicketId("7"), 0);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/issues/7");
      expect(init.method).toBe("PUT");
      expect(JSON.parse(init.body as string)).toMatchObject({ state_event: "close" });
    });

    it("updates labels for in-progress status", async () => {
      // First call: GET current issue labels
      fetchMock.mockResolvedValueOnce(jsonResponse({ ...gitlabIssue, labels: ["backend"] }));
      // Second call: PUT updated labels
      fetchMock.mockResolvedValueOnce(jsonResponse(gitlabIssue));

      await makeConnector().transitionStatus(makeTicketId("7"), 1);

      const [, putInit] = fetchMock.mock.calls[1] as [string, RequestInit];
      const body = JSON.parse(putInit.body as string);
      // labels is sent as comma-separated string
      const labelsStr = body.labels as string;
      expect(labelsStr).toContain(IN_PROGRESS_LABEL);
      expect(labelsStr).not.toContain(IN_REVIEW_LABEL);
    });

    it("replaces existing status:: label when transitioning", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ ...gitlabIssue, labels: ["backend", "status::in-progress"] })
      );
      fetchMock.mockResolvedValueOnce(jsonResponse(gitlabIssue));

      await makeConnector().transitionStatus(makeTicketId("7"), 2);

      const [, putInit] = fetchMock.mock.calls[1] as [string, RequestInit];
      const body = JSON.parse(putInit.body as string);
      expect(body.labels).toContain(IN_REVIEW_LABEL);
      expect(body.labels).not.toContain("status::in-progress");
    });

    it("strips legacy status::* labels when adding the new workflow label", async () => {
      // Issue has old label status::in-progress
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ ...gitlabIssue, labels: ["backend", "status::in-progress"] })
      );
      fetchMock.mockResolvedValueOnce(jsonResponse(gitlabIssue));

      await makeConnector().transitionStatus(makeTicketId("7"), 1);

      const [, putInit] = fetchMock.mock.calls[1] as [string, RequestInit];
      const body = JSON.parse(putInit.body as string);
      // labels is sent as comma-separated string
      const labelsStr = body.labels as string;
      // Should contain new workflow label
      expect(labelsStr).toContain(IN_PROGRESS_LABEL);
      // Should NOT contain old status::in-progress label
      expect(labelsStr).not.toContain("status::in-progress");
      // Should still contain other labels
      expect(labelsStr).toContain("backend");
    });

    it("replaces the in-progress label when transitioning to in-review", async () => {
      // Issue has the configured in-progress label
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ ...gitlabIssue, labels: ["backend", IN_PROGRESS_LABEL] })
      );
      fetchMock.mockResolvedValueOnce(jsonResponse(gitlabIssue));

      await makeConnector().transitionStatus(makeTicketId("7"), 2);

      const [, putInit] = fetchMock.mock.calls[1] as [string, RequestInit];
      const body = JSON.parse(putInit.body as string);
      // labels is sent as comma-separated string
      const labelsStr = body.labels as string;
      // Should contain in-review label
      expect(labelsStr).toContain(IN_REVIEW_LABEL);
      // The configured in-progress label is removed when transitioning to inReview
      expect(labelsStr).not.toContain(IN_PROGRESS_LABEL);
      expect(labelsStr).toContain("backend");
    });

    it("removes all status:: labels regardless of value", async () => {
      // Issue has arbitrary status:: labels
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          ...gitlabIssue,
          labels: ["status::custom", "status::blocked", IN_PROGRESS_LABEL, "other"],
        })
      );
      fetchMock.mockResolvedValueOnce(jsonResponse(gitlabIssue));

      await makeConnector().transitionStatus(makeTicketId("7"), 1);

      const [, putInit] = fetchMock.mock.calls[1] as [string, RequestInit];
      const body = JSON.parse(putInit.body as string);
      // labels is sent as comma-separated string
      const labelsStr = body.labels as string;
      // Should remove all status::* labels
      expect(labelsStr).not.toContain("status::custom");
      expect(labelsStr).not.toContain("status::blocked");
      // Should keep non-status:: labels
      expect(labelsStr).toContain(IN_PROGRESS_LABEL);
      expect(labelsStr).toContain("other");
      // Should have the configured in-progress label exactly once
      const inProgressCount = labelsStr.split(",").filter((l) => l === IN_PROGRESS_LABEL).length;
      expect(inProgressCount).toBe(1);
    });

    it("handles mixed old/new labels during transition", async () => {
      // Issue has both old and new status labels
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          ...gitlabIssue,
          labels: ["status::in-progress", IN_PROGRESS_LABEL, "backend"],
        })
      );
      fetchMock.mockResolvedValueOnce(jsonResponse(gitlabIssue));

      await makeConnector().transitionStatus(makeTicketId("7"), 2);

      const [, putInit] = fetchMock.mock.calls[1] as [string, RequestInit];
      const body = JSON.parse(putInit.body as string);
      // labels is sent as comma-separated string
      const labelsStr = body.labels as string;
      // Should have new in-review label
      expect(labelsStr).toContain(IN_REVIEW_LABEL);
      // Should NOT have old status::in-progress
      expect(labelsStr).not.toContain("status::in-progress");
      // The configured in-progress label is removed when transitioning to inReview
      expect(labelsStr).not.toContain(IN_PROGRESS_LABEL);
      expect(labelsStr).toContain("backend");
    });

    it("does nothing for unknown statusId", async () => {
      await makeConnector().transitionStatus(makeTicketId("7"), 999);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("skips PUT when issue already has the target label and nothing to clean up", async () => {
      // Issue already has the configured in-progress label and no other workflow/status labels
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ ...gitlabIssue, labels: [IN_PROGRESS_LABEL, "backend"] })
      );

      await makeConnector().transitionStatus(makeTicketId("7"), 1);

      // Only the GET was fired; no PUT
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("encodes project path slugs in project-scoped update URLs", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ iid: 7, state: "closed" }));

      await makeConnector({ projectId: PROJECT_PATH }).transitionStatus(makeTicketId("7"), 0);

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toContain(`/projects/${ENCODED_PROJECT_PATH}/issues/7`);
    });

    it("uses configured inProgressLabel for in-progress transition", async () => {
      const connector = makeConnector({ inProgressLabel: "wip" });
      fetchMock.mockResolvedValueOnce(jsonResponse({ ...gitlabIssue, labels: ["backend"] }));
      fetchMock.mockResolvedValueOnce(jsonResponse(gitlabIssue));

      await connector.transitionStatus(makeTicketId("7"), 1);

      const [, putInit] = fetchMock.mock.calls[1] as [string, RequestInit];
      const body = JSON.parse(putInit.body as string);
      const labelsStr = body.labels as string;
      expect(labelsStr).toContain("wip");
      expect(labelsStr).not.toContain(IN_PROGRESS_LABEL);
    });

    it("uses configured inReviewLabel for in-review transition", async () => {
      const connector = makeConnector({ inReviewLabel: "needs-review" });
      fetchMock.mockResolvedValueOnce(jsonResponse({ ...gitlabIssue, labels: ["backend"] }));
      fetchMock.mockResolvedValueOnce(jsonResponse(gitlabIssue));

      await connector.transitionStatus(makeTicketId("7"), 2);

      const [, putInit] = fetchMock.mock.calls[1] as [string, RequestInit];
      const body = JSON.parse(putInit.body as string);
      const labelsStr = body.labels as string;
      expect(labelsStr).toContain("needs-review");
      expect(labelsStr).not.toContain(IN_REVIEW_LABEL);
    });

    it("removes old configured labels when transitioning between workflow states", async () => {
      const connector = makeConnector({ inProgressLabel: "wip", inReviewLabel: "needs-review" });
      fetchMock.mockResolvedValueOnce(jsonResponse({ ...gitlabIssue, labels: ["wip", "backend"] }));
      fetchMock.mockResolvedValueOnce(jsonResponse(gitlabIssue));

      await connector.transitionStatus(makeTicketId("7"), 2);

      const [, putInit] = fetchMock.mock.calls[1] as [string, RequestInit];
      const body = JSON.parse(putInit.body as string);
      const labelsStr = body.labels as string;
      expect(labelsStr).toContain("needs-review");
      expect(labelsStr).not.toContain("wip");
      expect(labelsStr).toContain("backend");
    });
  });

  // ─── addNote ──────────────────────────────────────────────────────────────

  describe("addNote", () => {
    it("posts a note to the issue", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1, body: "hello" }));

      await makeConnector().addNote(makeTicketId("7"), "hello world");

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/issues/7/notes");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body as string);
      expect(body.body).toBe("hello world");
      expect(body.confidential).toBe(false);
    });

    it("marks note as confidential when isPrivate=true", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 2, body: "private" }));

      await makeConnector().addNote(makeTicketId("7"), "private note", true);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(init.body as string).confidential).toBe(true);
    });

    it("encodes project path slugs in project-scoped notes URLs", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1, body: "hello" }));

      await makeConnector({ projectId: PROJECT_PATH }).addNote(makeTicketId("7"), "hello world");

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toContain(`/projects/${ENCODED_PROJECT_PATH}/issues/7/notes`);
    });
  });

  // ─── closeTicket ──────────────────────────────────────────────────────────

  describe("closeTicket", () => {
    it("adds a closing note then closes the issue", async () => {
      // addNote → POST /notes
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1 }));
      // transitionStatus → PUT /issues/7
      fetchMock.mockResolvedValueOnce(jsonResponse({ iid: 7, state: "closed" }));

      await makeConnector().closeTicket(makeTicketId("7"), "Done!");

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [notesUrl] = fetchMock.mock.calls[0] as [string];
      expect(notesUrl).toContain("/notes");
      const [closeUrl, closeInit] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(closeUrl).toContain("/issues/7");
      expect(JSON.parse(closeInit.body as string)).toMatchObject({ state_event: "close" });
    });
  });

  // ─── GitLabApiError / GitLabNotFoundError ─────────────────────────────────

  describe("GitLabApiError", () => {
    it("includes status code, url, and body in message", () => {
      const err = new GitLabApiError(403, "https://gitlab.test/api/v4/user", "Forbidden");
      expect(err.message).toContain("403");
      expect(err.message).toContain("https://gitlab.test/api/v4/user");
      expect(err.message).toContain("Forbidden");
      expect(err.name).toBe("GitLabApiError");
    });

    it("is instanceof TicketApiError", () => {
      expect(new GitLabApiError(500, "/url", "err")).toBeInstanceOf(TicketApiError);
    });
  });

  describe("GitLabNotFoundError", () => {
    it("is instanceof TicketNotFoundError and TicketApiError", () => {
      const err = new GitLabNotFoundError(404, "/url", "Not Found");
      expect(err).toBeInstanceOf(TicketNotFoundError);
      expect(err).toBeInstanceOf(TicketApiError);
      expect(err.name).toBe("GitLabNotFoundError");
      expect(err.statusCode).toBe(404);
    });
  });
});
