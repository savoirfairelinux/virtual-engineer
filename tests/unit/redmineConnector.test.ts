import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  HttpRedmineConnector,
  RedmineApiError,
  RedmineNotFoundError,
} from "../../src/connectors/redmineConnector.js";
import { makeTicketId } from "../../src/interfaces.js";
import {
  redmineIssuesListResponse,
  redmineIssueResponse,
  redmineIssueNoAssignee,
  jsonResponse,
  errorResponse,
} from "./helpers/fixtures.js";

const BASE_URL = "http://redmine.test";
const VE_LOGIN = "ve-user";
const VE_USER_ID = 5;

function makeConnector(overrides?: Partial<ConstructorParameters<typeof HttpRedmineConnector>[0]>) {
  return new HttpRedmineConnector({
    baseUrl: BASE_URL,
    apiKey: "test-api-key",
    virtualEngineerUserLogin: VE_LOGIN,
    closedStatusId: 5,
    inProgressStatusId: 2,
    inReviewStatusId: 4,
    ...overrides,
  });
}

function mockLoginLookup(fetchMock: ReturnType<typeof vi.fn>): void {
  fetchMock.mockImplementationOnce(async (url: string) => {
    if (!url.endsWith("/users/current.json")) {
      throw new Error(`expected /users/current.json call, got: ${url}`);
    }
    return jsonResponse({ user: { id: VE_USER_ID, login: VE_LOGIN } });
  });
}

describe("HttpRedmineConnector", () => {
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
    it("returns mapped tickets from the API", async () => {
      mockLoginLookup(fetchMock);
      fetchMock.mockResolvedValueOnce(jsonResponse(redmineIssuesListResponse));
      const tickets = await makeConnector().getAssignedTickets();

      expect(tickets).toHaveLength(1);
      expect(tickets[0]?.id).toBe("101");
      expect(tickets[0]?.subject).toBe("Implement feature X");
      expect(tickets[0]?.assigneeId).toBe(5);
      expect(tickets[0]?.projectId).toBe(1);
    });

    it("maps custom fields into a record", async () => {
      mockLoginLookup(fetchMock);
      fetchMock.mockResolvedValueOnce(jsonResponse(redmineIssuesListResponse));
      const tickets = await makeConnector().getAssignedTickets();
      expect(tickets[0]?.customFields?.["Priority-Score"]).toBe("high");
    });

    it("sends X-Redmine-API-Key header", async () => {
      mockLoginLookup(fetchMock);
      fetchMock.mockResolvedValueOnce(jsonResponse(redmineIssuesListResponse));
      await makeConnector().getAssignedTickets();

      const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
      const headers = init?.headers as Record<string, string>;
      expect(headers?.["X-Redmine-API-Key"]).toBe("test-api-key");
    });

    it("includes assigned_to_id query parameter", async () => {
      mockLoginLookup(fetchMock);
      fetchMock.mockResolvedValueOnce(jsonResponse(redmineIssuesListResponse));
      await makeConnector().getAssignedTickets();

      const [url] = fetchMock.mock.calls[1] as [string];
      expect(url).toContain("assigned_to_id=5");
    });

    it("Phase 4: passes project_id query parameter when projectKey opt is provided", async () => {
      mockLoginLookup(fetchMock);
      fetchMock.mockResolvedValueOnce(jsonResponse(redmineIssuesListResponse));
      await makeConnector().getAssignedTickets({ projectKey: "platform" });

      const [url] = fetchMock.mock.calls[1] as [string];
      expect(url).toContain("project_id=platform");
    });

    it("Phase 4: omits project_id when projectKey is not provided", async () => {
      mockLoginLookup(fetchMock);
      fetchMock.mockResolvedValueOnce(jsonResponse(redmineIssuesListResponse));
      await makeConnector().getAssignedTickets();

      const [url] = fetchMock.mock.calls[1] as [string];
      expect(url).not.toContain("project_id=");
    });

    it("returns empty array when no issues returned", async () => {
      mockLoginLookup(fetchMock);
      fetchMock.mockResolvedValueOnce(jsonResponse({ issues: [], total_count: 0 }));
      const tickets = await makeConnector().getAssignedTickets();
      expect(tickets).toHaveLength(0);
    });

    it("throws RedmineApiError on non-ok response", async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(401, "Unauthorized"));
      await expect(makeConnector().getAssignedTickets()).rejects.toThrow(RedmineApiError);
    });

    it("RedmineApiError carries statusCode and url", async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(403, "Forbidden"));
      const err = await makeConnector().getAssignedTickets().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RedmineApiError);
      expect((err as RedmineApiError).statusCode).toBe(403);
      expect((err as RedmineApiError).url).toContain(BASE_URL);
    });
  });

  // ─── getTicket ─────────────────────────────────────────────────────────────

  describe("getTicket", () => {
    it("returns a single mapped ticket", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(redmineIssueResponse));
      const ticket = await makeConnector().getTicket(makeTicketId("101"));

      expect(ticket.id).toBe("101");
      expect(ticket.subject).toBe("Implement feature X");
    });

    it("maps assigneeId to 0 when no assignee", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ issue: redmineIssueNoAssignee }));
      const ticket = await makeConnector().getTicket(makeTicketId("102"));
      expect(ticket.assigneeId).toBe(0);
    });

    it("constructs the correct URL", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(redmineIssueResponse));
      await makeConnector().getTicket(makeTicketId("101"));

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toBe(`${BASE_URL}/issues/101.json`);
    });

    it("throws RedmineNotFoundError on 404", async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(404, "Not Found"));
      const err = await makeConnector().getTicket(makeTicketId("999")).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RedmineNotFoundError);
      expect((err as RedmineNotFoundError).statusCode).toBe(404);
    });
  });

  // ─── transitionStatus ─────────────────────────────────────────────────────

  describe("transitionStatus", () => {
    it("PUTs the new status_id", async () => {
      fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
      await makeConnector().transitionStatus(makeTicketId("101"), 3);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${BASE_URL}/issues/101.json`);
      expect(init.method).toBe("PUT");
      const body = JSON.parse(init.body as string) as { issue: { status_id: number } };
      expect(body.issue.status_id).toBe(3);
    });

    it("throws RedmineApiError on server error", async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(500));
      await expect(makeConnector().transitionStatus(makeTicketId("101"), 3)).rejects.toThrow(RedmineApiError);
    });
  });

  // ─── addNote ───────────────────────────────────────────────────────────────

  describe("addNote", () => {
    it("PUTs a note to the issue", async () => {
      fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
      await makeConnector().addNote(makeTicketId("101"), "Work in progress");

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { issue: { notes: string; private_notes: boolean } };
      expect(body.issue.notes).toBe("Work in progress");
      expect(body.issue.private_notes).toBe(false);
    });

    it("sets private_notes when isPrivate is true", async () => {
      fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
      await makeConnector().addNote(makeTicketId("101"), "Internal note", true);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { issue: { private_notes: boolean } };
      expect(body.issue.private_notes).toBe(true);
    });
  });

  // ─── closeTicket ───────────────────────────────────────────────────────────

  describe("closeTicket", () => {
    it("PUTs closed status and closing note", async () => {
      fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
      await makeConnector({ closedStatusId: 5 }).closeTicket(makeTicketId("101"), "Done!");

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { issue: { status_id: number; notes: string } };
      expect(body.issue.status_id).toBe(5);
      expect(body.issue.notes).toBe("Done!");
    });
  });

  // ─── Issue 7: Redmine Connector Doesn't Distinguish 404 from Other Errors ──

  describe("Issue 7: HTTP error code distinction", () => {
    it("throws RedmineNotFoundError for HTTP 404", async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(404, "Not Found"));
      const connector = makeConnector();

      await expect(connector.getTicket(makeTicketId("999")))
        .rejects
        .toThrow(expect.objectContaining({ statusCode: 404, name: "RedmineNotFoundError" }));
    });

    it("throws RedmineApiError for HTTP 500", async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(500, "Internal Server Error"));
      const connector = makeConnector();

      const err = await connector.getTicket(makeTicketId("101")).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RedmineApiError);
      expect((err as RedmineApiError).statusCode).toBe(500);
      // Should NOT be RedmineNotFoundError
      expect((err as any).name).not.toBe("RedmineNotFoundError");
    });

    it("throws RedmineApiError for HTTP 502", async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(502, "Bad Gateway"));
      const connector = makeConnector();

      await expect(connector.transitionStatus(makeTicketId("101"), 2))
        .rejects
        .toThrow(RedmineApiError);
    });

    it("throws RedmineApiError for HTTP 403", async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(403, "Forbidden"));
      const connector = makeConnector();

      const err = await connector.addNote(makeTicketId("101"), "note").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RedmineApiError);
      expect((err as RedmineApiError).statusCode).toBe(403);
    });

    it("RedmineNotFoundError has distinct name for instanceof checks", async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(404, "Not Found"));
      const connector = makeConnector();

      try {
        await connector.getTicket(makeTicketId("missing"));
        throw new Error("should have thrown");
      } catch (err: unknown) {
        expect(err).toHaveProperty("name", "RedmineNotFoundError");
        expect(err).toBeInstanceOf(Error);
        // Orchestrator should be able to differentiate using instance check or name
        const isNotFoundError = (err as any).name === "RedmineNotFoundError" || (err as any).statusCode === 404;
        expect(isNotFoundError).toBe(true);
      }
    });

    it("getAssignedTickets throws RedmineApiError (not RedmineNotFoundError) on 5xx", async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(503, "Service Unavailable"));
      const connector = makeConnector();

      const err = await connector.getAssignedTickets().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RedmineApiError);
      expect((err as any).name).not.toBe("RedmineNotFoundError");
    });

    it("close ticket throws RedmineNotFoundError for 404", async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(404, "Ticket not found"));
      const connector = makeConnector();

      const err = await connector.closeTicket(makeTicketId("missing"), "closing").catch((e: unknown) => e);
      expect(err).toHaveProperty("statusCode", 404);
      expect((err as any).name).toBe("RedmineNotFoundError");
    });
  });
});
