import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  GitHubIssueConnector,
  GitHubApiError,
} from "../../src/connectors/githubIssueConnector.js";
import { makeTicketId, TicketApiError, TicketNotFoundError } from "../../src/interfaces.js";
import { jsonResponse, errorResponse } from "./helpers/fixtures.js";

const API_BASE_URL = "https://api.github.com";
const OWNER = "octocat";
const REPO = "hello-world";
const TOKEN = "ghp_test-token";

function makeConnector(
  overrides?: Partial<ConstructorParameters<typeof GitHubIssueConnector>[0]>
) {
  return new GitHubIssueConnector({
    apiBaseUrl: API_BASE_URL,
    owner: OWNER,
    repo: REPO,
    token: TOKEN,
    virtualEngineerUserLogin: "ve-bot",
    ...overrides,
  });
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const githubIssue = {
  number: 7,
  title: "Add logging to service",
  body: "We need structured logging\n\n## AC\n- Use pino",
  state: "open",
  assignee: { id: 42, login: "ve-bot" },
  labels: [{ name: "backend" }, { name: "virtual-engineer" }],
  html_url: "https://github.com/octocat/hello-world/issues/7",
};

const githubIssuePR = {
  ...githubIssue,
  number: 10,
  pull_request: { url: "https://api.github.com/repos/octocat/hello-world/pulls/10" },
};

const githubIssueNoAssignee = {
  ...githubIssue,
  number: 8,
  assignee: null,
};

describe("GitHubIssueConnector", () => {
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
    it("fetches open issues assigned to the VE account, filtering out PRs", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([githubIssue, githubIssuePR]));

      const tickets = await makeConnector().getAssignedTickets();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toContain("/repos/octocat/hello-world/issues");
      expect(url).toContain("state=open");
      expect(url).toContain("assignee=ve-bot");

      // Should filter out the PR
      expect(tickets).toHaveLength(1);
      expect(tickets[0]?.id).toBe("7");
    });

    it("maps GitHub issues to RedmineTicket shape", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([githubIssue]));

      const tickets = await makeConnector().getAssignedTickets();

      expect(tickets[0]?.subject).toBe("Add logging to service");
      expect(tickets[0]?.description).toContain("structured logging");
      expect(tickets[0]?.status).toBe("open");
      expect(tickets[0]?.assigneeId).toBe(42);
    });

    it("maps labels into customFields", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([githubIssue]));

      const tickets = await makeConnector().getAssignedTickets();
      expect(tickets[0]?.customFields?.["backend"]).toBe("backend");
      expect(tickets[0]?.customFields?.["virtual-engineer"]).toBe("virtual-engineer");
    });

    it("sends Authorization Bearer header", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([]));

      await makeConnector().getAssignedTickets();

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = init?.headers as Record<string, string>;
      expect(headers?.["Authorization"]).toBe(`Bearer ${TOKEN}`);
    });

    it("handles null assignee with id=0", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([githubIssueNoAssignee]));

      const tickets = await makeConnector().getAssignedTickets();
      expect(tickets[0]?.assigneeId).toBe(0);
    });

    it("throws GitHubApiError on non-OK response", async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(401, "Unauthorized"));

      await expect(makeConnector().getAssignedTickets()).rejects.toThrow(GitHubApiError);
    });

    it("resolves login via GET /user when virtualEngineerUserLogin is not configured", async () => {
      // First call: GET /user; second call: GET /repos/.../issues
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ login: "resolved-bot", id: 99 }))
        .mockResolvedValueOnce(jsonResponse([githubIssue]));

      const connector = makeConnector({ virtualEngineerUserLogin: undefined });
      const tickets = await connector.getAssignedTickets();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [userUrl] = fetchMock.mock.calls[0] as [string];
      expect(userUrl).toContain("/user");
      const [issuesUrl] = fetchMock.mock.calls[1] as [string];
      expect(issuesUrl).toContain("assignee=resolved-bot");
      expect(tickets).toHaveLength(1);
    });

    it("caches the resolved login across multiple calls", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ login: "resolved-bot", id: 99 }))
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(jsonResponse([]));

      const connector = makeConnector({ virtualEngineerUserLogin: undefined });
      await connector.getAssignedTickets();
      await connector.getAssignedTickets();

      // GET /user should only be called once despite two getAssignedTickets calls
      const userCalls = (fetchMock.mock.calls as [string][]).filter(([url]) => url.endsWith("/user"));
      expect(userCalls).toHaveLength(1);
    });
  });

  // ─── getTicket ─────────────────────────────────────────────────────────────

  describe("getTicket", () => {
    it("fetches a single issue by number", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(githubIssue));

      const ticket = await makeConnector().getTicket(makeTicketId("7"));

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toContain("/issues/7");
      expect(ticket.id).toBe("7");
      expect(ticket.subject).toBe(githubIssue.title);
    });

    it("throws a shared missing-ticket error on 404", async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(404, "Not Found"));
      const error = await makeConnector().getTicket(makeTicketId("999")).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(TicketNotFoundError);
      expect(error).toBeInstanceOf(TicketApiError);
      expect(error).toMatchObject({
        name: "GitHubNotFoundError",
        statusCode: 404,
        url: `${API_BASE_URL}/repos/${OWNER}/${REPO}/issues/999`,
        body: "Not Found",
      });
    });
  });

  // ─── claimTicket ──────────────────────────────────────────────────────────

  describe("claimTicket", () => {
    it("adds in-progress label and assigns the VE user", async () => {
      // addLabel call
      fetchMock.mockResolvedValueOnce(jsonResponse([{ name: "in-progress" }]));
      // assignUser call
      fetchMock.mockResolvedValueOnce(jsonResponse({ assignees: ["ve-bot"] }));

      await makeConnector().claimTicket(makeTicketId("7"));

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [labelUrl, labelInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(labelUrl).toContain("/issues/7/labels");
      expect(labelInit.method).toBe("POST");
      expect(JSON.parse(labelInit.body as string).labels).toContain("in-progress");

      const [assignUrl, assignInit] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(assignUrl).toContain("/issues/7/assignees");
      expect(assignInit.method).toBe("POST");
      expect(JSON.parse(assignInit.body as string).assignees).toContain("ve-bot");
    });
  });

  // ─── releaseTicket ────────────────────────────────────────────────────────

  describe("releaseTicket", () => {
    it("removes in-progress label and unassigns VE user", async () => {
      // removeLabel call
      fetchMock.mockResolvedValueOnce(jsonResponse([]));
      // unassignUser call
      fetchMock.mockResolvedValueOnce(jsonResponse({}));

      await makeConnector().releaseTicket(makeTicketId("7"));

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [labelUrl, labelInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(labelUrl).toContain("/issues/7/labels/in-progress");
      expect(labelInit.method).toBe("DELETE");

      const [assignUrl, assignInit] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(assignUrl).toContain("/issues/7/assignees");
      expect(assignInit.method).toBe("DELETE");
    });
  });

  // ─── addNote (postComment) ────────────────────────────────────────────────

  describe("addNote", () => {
    it("posts a comment to the issue", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1, body: "hello" }));

      await makeConnector().addNote(makeTicketId("7"), "hello world");

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/issues/7/comments");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string).body).toBe("hello world");
    });
  });

  // ─── closeTicket ──────────────────────────────────────────────────────────

  describe("closeTicket", () => {
    it("adds a closing comment then closes the issue", async () => {
      // addNote → POST /comments
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1 }));
      // transitionStatus → PATCH /issues/7
      fetchMock.mockResolvedValueOnce(jsonResponse({ number: 7, state: "closed" }));

      await makeConnector().closeTicket(makeTicketId("7"), "Done!");

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [commentUrl] = fetchMock.mock.calls[0] as [string];
      expect(commentUrl).toContain("/comments");
      const [closeUrl, closeInit] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(closeUrl).toContain("/issues/7");
      expect(JSON.parse(closeInit.body as string)).toMatchObject({ state: "closed" });
    });

    it.each(["POST", "PATCH"])("propagates a missing-ticket error from the %s request", async (method) => {
      fetchMock.mockImplementation((_url: unknown, init?: RequestInit) =>
        Promise.resolve(init?.method === method ? errorResponse(404, "Not Found") : jsonResponse({}))
      );

      const error = await makeConnector().closeTicket(makeTicketId("7"), "Done!")
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(TicketNotFoundError);
      expect(error).toBeInstanceOf(TicketApiError);
      expect(error).toMatchObject({ name: "GitHubNotFoundError", statusCode: 404 });
      expect(fetchMock).toHaveBeenCalledTimes(method === "POST" ? 1 : 2);
    });
  });

  describe.each([
    {
      operation: "getTicket",
      request: (connector: GitHubIssueConnector) => connector.getTicket(makeTicketId("7")),
    },
    {
      operation: "addNote",
      request: (connector: GitHubIssueConnector) => connector.addNote(makeTicketId("7"), "note"),
    },
  ])("$operation HTTP failures", ({ operation, request }) => {
    it.each([401, 403, 410, 429, 500])("keeps HTTP %i as a non-missing ticket API error", async (statusCode) => {
      fetchMock.mockResolvedValueOnce(errorResponse(statusCode, "request failed"));

      const error = await request(makeConnector()).catch((err: unknown) => err);
      const url = `${API_BASE_URL}/repos/${OWNER}/${REPO}/issues/7${operation === "addNote" ? "/comments" : ""}`;

      expect(error).toBeInstanceOf(GitHubApiError);
      expect(error).toBeInstanceOf(TicketApiError);
      expect(error).not.toBeInstanceOf(TicketNotFoundError);
      expect(error).toMatchObject({
        name: "GitHubApiError",
        statusCode,
        url,
        body: "request failed",
        message: `GitHub API error ${statusCode} on ${url}: request failed`,
      });
    });

    it("preserves transport rejections", async () => {
      const error = new TypeError("fetch failed");
      fetchMock.mockRejectedValueOnce(error);

      await expect(request(makeConnector())).rejects.toBe(error);
    });

    it.each([403, 404])("redacts and bounds diagnostics for HTTP %i", async (statusCode) => {
      const path = "p".repeat(1100);
      const padding = "b".repeat(600);
      const url = `https://<redacted>@api.github.com/${path}`.slice(0, 1000);
      const body = `token=<redacted> ${padding}`.slice(0, 500);
      fetchMock.mockResolvedValueOnce(errorResponse(statusCode, `token=test-secret ${padding}`));

      const error = await request(makeConnector({
        apiBaseUrl: `https://test-user:test-password@api.github.com/${path}`,
      })).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(TicketApiError);
      expect(error).toMatchObject({
        name: statusCode === 404 ? "GitHubNotFoundError" : "GitHubApiError",
        statusCode,
        url,
        body,
        message: `GitHub API error ${statusCode} on ${url}: ${body}`,
      });
    });
  });

  // ─── GitHubApiError ───────────────────────────────────────────────────────

  describe("GitHubApiError", () => {
    it("includes status code, url, and body in message", () => {
      const err = new GitHubApiError(403, "https://api.github.com/repos/x/y/issues", "Forbidden");
      expect(err.message).toContain("403");
      expect(err.message).toContain("https://api.github.com/repos/x/y/issues");
      expect(err.message).toContain("Forbidden");
      expect(err.name).toBe("GitHubApiError");
    });
  });
});
