import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  GitLabMergeRequestConnector,
  GitLabMrApiError,
} from "../../src/connectors/gitlabMergeRequestConnector.js";
import { errorResponse } from "./helpers/fixtures.js";

const BASE_URL = "https://gitlab.test";

function makeConnector() {
  return new GitLabMergeRequestConnector({
    baseUrl: BASE_URL,
    projectId: "demo/proj",
    token: "glpat-secret",
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

describe("GitLabMergeRequestConnector.listRepositories", () => {
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
            ssh_url_to_repo: "git@gitlab.test:group/demo.git",
            http_url_to_repo: "https://gitlab.test/group/demo.git",
            default_branch: "main",
            web_url: "https://gitlab.test/group/demo",
          },
        ],
        null
      )
    );
    const repos = await makeConnector().listRepositories();
    expect(repos).toEqual([
      {
        key: "group/demo",
        name: "Demo",
        cloneUrlSsh: "git@gitlab.test:group/demo.git",
        cloneUrlHttp: "https://gitlab.test/group/demo.git",
        defaultBranch: "main",
        webUrl: "https://gitlab.test/group/demo",
      },
    ]);
  });

  it("returns empty array on empty response", async () => {
    fetchMock.mockResolvedValueOnce(pageResponse([], null));
    expect(await makeConnector().listRepositories()).toEqual([]);
  });

  it("paginates via X-Next-Page", async () => {
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
    const repos = await makeConnector().listRepositories();
    expect(repos.map((r) => r.key)).toEqual(["g/a", "g/b"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("omits optional fields when API returns nulls", async () => {
    fetchMock.mockResolvedValueOnce(
      pageResponse(
        [
          {
            id: 5,
            name: "Bare",
            path_with_namespace: "g/bare",
            web_url: "https://gitlab.test/g/bare",
            default_branch: null,
          },
        ],
        null
      )
    );
    const repos = await makeConnector().listRepositories();
    expect(repos[0]).toEqual({
      key: "g/bare",
      name: "Bare",
      webUrl: "https://gitlab.test/g/bare",
    });
  });

  it("throws GitLabMrApiError on 401", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(401, "unauthorized"));
    await expect(makeConnector().listRepositories()).rejects.toBeInstanceOf(GitLabMrApiError);
  });

  it("throws GitLabMrApiError on 403", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(403, "forbidden"));
    await expect(makeConnector().listRepositories()).rejects.toBeInstanceOf(GitLabMrApiError);
  });
});
