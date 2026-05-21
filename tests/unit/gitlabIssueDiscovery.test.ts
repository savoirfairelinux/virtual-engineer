import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  GitLabIssueConnector,
  GitLabApiError,
} from "../../src/connectors/gitlabIssueConnector.js";
import { jsonResponse, errorResponse } from "./helpers/fixtures.js";

const BASE_URL = "https://gitlab.test";
const IN_PROGRESS_LABEL = "triage";
const IN_REVIEW_LABEL = "review-ready";

function makeConnector() {
  return new GitLabIssueConnector({
    baseUrl: BASE_URL,
    projectId: "demo/proj",
    token: "glpat-secret",
    inProgressLabel: IN_PROGRESS_LABEL,
    inReviewLabel: IN_REVIEW_LABEL,
  });
}

function pageResponse(body: unknown, nextPage: number | null): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "X-Next-Page": nextPage === null ? "" : String(nextPage),
    },
  });
}

describe("GitLabIssueConnector.listProjects", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes a single page", async () => {
    fetchMock.mockResolvedValueOnce(
      pageResponse(
        [
          {
            id: 10,
            name: "Demo",
            path_with_namespace: "group/demo",
            web_url: "https://gitlab.test/group/demo",
          },
        ],
        null
      )
    );
    const projects = await makeConnector().listProjects();
    expect(projects).toEqual([
      { key: "group/demo", name: "Demo", url: "https://gitlab.test/group/demo" },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v4/projects?");
    expect(url).toContain("membership=true");
    expect(url).toContain("simple=true");
    expect(url).toContain("per_page=100");
    expect(url).toContain("page=1");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer glpat-secret");
  });

  it("returns empty array when no projects exist", async () => {
    fetchMock.mockResolvedValueOnce(pageResponse([], null));
    const projects = await makeConnector().listProjects();
    expect(projects).toEqual([]);
  });

  it("follows pagination via X-Next-Page header", async () => {
    fetchMock.mockResolvedValueOnce(
      pageResponse(
        [{ id: 1, name: "A", path_with_namespace: "g/a", web_url: "https://gitlab.test/g/a" }],
        2
      )
    );
    fetchMock.mockResolvedValueOnce(
      pageResponse(
        [{ id: 2, name: "B", path_with_namespace: "g/b", web_url: "https://gitlab.test/g/b" }],
        null
      )
    );
    const projects = await makeConnector().listProjects();
    expect(projects.map((p) => p.key)).toEqual(["g/a", "g/b"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url2] = fetchMock.mock.calls[1] as [string];
    expect(url2).toContain("page=2");
  });

  it("throws GitLabApiError on 401", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(401, "unauthorized"));
    await expect(makeConnector().listProjects()).rejects.toBeInstanceOf(GitLabApiError);
  });

  it("throws GitLabApiError on 403", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(403, "forbidden"));
    await expect(makeConnector().listProjects()).rejects.toBeInstanceOf(GitLabApiError);
  });

  // Sanity: jsonResponse helper still parses
  it("accepts a generic jsonResponse", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    const projects = await makeConnector().listProjects();
    expect(projects).toEqual([]);
  });
});
