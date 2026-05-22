import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  HttpRedmineConnector,
  RedmineApiError,
} from "../../src/connectors/redmineConnector.js";
import { jsonResponse, errorResponse } from "./helpers/fixtures.js";

const BASE_URL = "http://redmine.test";

function makeConnector() {
  return new HttpRedmineConnector({
    baseUrl: BASE_URL,
    apiKey: "test-api-key",
    virtualEngineerUserLogin: "ve",
    closedStatusId: 5,
    inProgressStatusId: 2,
    inReviewStatusId: 4,
  });
}

describe("HttpRedmineConnector.listProjects", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes a single page of projects", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        projects: [
          { id: 1, identifier: "demo", name: "Demo Project" },
          { id: 2, identifier: "infra", name: "Infrastructure" },
        ],
        total_count: 2,
      })
    );

    const projects = await makeConnector().listProjects();

    expect(projects).toEqual([
      { key: "demo", name: "Demo Project", url: `${BASE_URL}/projects/demo` },
      { key: "infra", name: "Infrastructure", url: `${BASE_URL}/projects/infra` },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/projects.json");
    expect(url).toContain("limit=100");
    expect(url).toContain("offset=0");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Redmine-API-Key"]).toBe("test-api-key");
  });

  it("returns an empty array when no projects exist", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ projects: [], total_count: 0 }));
    const projects = await makeConnector().listProjects();
    expect(projects).toEqual([]);
  });

  it("paginates until total_count is reached", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          projects: Array.from({ length: 100 }, (_, i) => ({
            id: i + 1,
            identifier: `p${i + 1}`,
            name: `Project ${i + 1}`,
          })),
          total_count: 102,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          projects: [
            { id: 101, identifier: "p101", name: "Project 101" },
            { id: 102, identifier: "p102", name: "Project 102" },
          ],
          total_count: 102,
        })
      );

    const projects = await makeConnector().listProjects();
    expect(projects).toHaveLength(102);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, init1] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    const [url2] = fetchMock.mock.calls[1] as [string, RequestInit | undefined];
    expect(url2).toContain("offset=100");
    void init1;
  });

  it("throws RedmineApiError on 401", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(401, "unauthorized"));
    await expect(makeConnector().listProjects()).rejects.toBeInstanceOf(RedmineApiError);
  });

  it("throws RedmineApiError on 403", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(403, "forbidden"));
    await expect(makeConnector().listProjects()).rejects.toBeInstanceOf(RedmineApiError);
  });
});
