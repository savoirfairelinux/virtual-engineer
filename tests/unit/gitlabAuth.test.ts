import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildGitLabApiHeaders,
  buildGitLabAuthHeaders,
  fetchGitLabCurrentUser,
  getGitLabAccessToken,
  getGitLabBaseUrl,
  getGitLabRequiredConfigString,
  isAllowedGitLabProxyTarget,
  rewriteGitLabUploadUrl,
} from "../../src/utils/gitlabAuth.js";

const BASE = "https://gitlab.example.com";
const SECRET = "0123456789abcdef0123456789abcdef";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("rewriteGitLabUploadUrl", () => {
  it("rewrites a project upload URL to its REST API form", () => {
    const target = `${BASE}/group/project/uploads/${SECRET}/image.png`;
    expect(rewriteGitLabUploadUrl(target, BASE)).toBe(
      `${BASE}/api/v4/projects/${encodeURIComponent("group/project")}/uploads/${SECRET}/image.png`
    );
  });

  it("encodes nested namespace project paths", () => {
    const target = `${BASE}/group/sub/project/uploads/${SECRET}/diagram.svg`;
    expect(rewriteGitLabUploadUrl(target, BASE)).toBe(
      `${BASE}/api/v4/projects/${encodeURIComponent("group/sub/project")}/uploads/${SECRET}/diagram.svg`
    );
  });

  it("tolerates a trailing slash on the base URL", () => {
    const target = `${BASE}/group/project/uploads/${SECRET}/image.png`;
    expect(rewriteGitLabUploadUrl(target, `${BASE}/`)).toBe(
      `${BASE}/api/v4/projects/${encodeURIComponent("group/project")}/uploads/${SECRET}/image.png`
    );
  });

  it("leaves instance/group-level uploads unchanged", () => {
    const target = `${BASE}/-/project/42/uploads/${SECRET}/image.png`;
    expect(rewriteGitLabUploadUrl(target, BASE)).toBe(target);
  });

  it("leaves non-upload URLs unchanged", () => {
    const target = `${BASE}/group/project/-/raw/main/README.md`;
    expect(rewriteGitLabUploadUrl(target, BASE)).toBe(target);
  });

  it("leaves URLs outside the base URL unchanged", () => {
    const target = `https://evil.example.com/group/project/uploads/${SECRET}/image.png`;
    expect(rewriteGitLabUploadUrl(target, BASE)).toBe(target);
  });

  it("ignores upload paths with a non-hex secret", () => {
    const target = `${BASE}/group/project/uploads/not-a-secret/image.png`;
    expect(rewriteGitLabUploadUrl(target, BASE)).toBe(target);
  });
});

describe("isAllowedGitLabProxyTarget", () => {
  it("accepts same-origin upload paths", () => {
    expect(isAllowedGitLabProxyTarget(`${BASE}/uploads/${SECRET}/image.png`, BASE)).toBe(true);
    expect(isAllowedGitLabProxyTarget(`${BASE}/group/project/uploads/${SECRET}/image.png`, BASE)).toBe(true);
    expect(isAllowedGitLabProxyTarget(`${BASE}/api/v4/projects/group%2Fproject/uploads/${SECRET}/image.png`, BASE)).toBe(true);
  });

  it("rejects same-origin paths that are not uploads", () => {
    expect(isAllowedGitLabProxyTarget(`${BASE}/group/project/-/raw/main/secret.txt`, BASE)).toBe(false);
  });

  it.each([
    `${BASE}/group/project/-/raw/main/uploads/${SECRET}/secret.txt`,
    `${BASE}/group/project/%2D/raw/main/uploads/${SECRET}/secret.txt`,
    `${BASE}/api/v4/projects/group%2Fproject/repository/files/uploads/${SECRET}/secret.txt`,
    `${BASE}/group/project/uploads/not-a-secret/image.png`,
    `${BASE}/project/uploads/${SECRET}/image.png`,
    `${BASE}/group/project/uploads/${SECRET}/nested/image.png`,
  ])("rejects upload-shaped non-upload target %s", (target) => {
    expect(isAllowedGitLabProxyTarget(target, BASE)).toBe(false);
  });

  it.each([
    `https://gitlab.example.com.attacker.test/uploads/${SECRET}/image.png`,
    `http://gitlab.example.com/uploads/${SECRET}/image.png`,
    `https://gitlab.example.com:8443/uploads/${SECRET}/image.png`,
    `https://user:password@gitlab.example.com/uploads/${SECRET}/image.png`,
    "not-a-url",
  ])("rejects unsafe target %s", (target) => {
    expect(isAllowedGitLabProxyTarget(target, BASE)).toBe(false);
  });
});

describe("GitLab authentication helpers", () => {
  it("normalizes required configuration strings", () => {
    expect(getGitLabBaseUrl({ baseUrl: ` ${BASE}/ ` })).toBe(BASE);
    expect(getGitLabAccessToken({ token: " token " })).toBe("token");
    expect(getGitLabRequiredConfigString({ project: " group/project " }, "project", "Project"))
      .toBe("group/project");
  });

  it("rejects missing required configuration strings", () => {
    expect(() => getGitLabBaseUrl({ baseUrl: " " })).toThrow("GitLab baseUrl is required");
    expect(() => getGitLabAccessToken({})).toThrow("GitLab access token is required");
    expect(() => getGitLabRequiredConfigString({}, "project", "Project"))
      .toThrow("Project is required");
  });

  it("replaces caller auth headers and normalizes API content type", () => {
    expect(buildGitLabAuthHeaders("token", {
      authorization: "Bearer stale",
      "x-request-id": "request-1",
    })).toEqual({
      Authorization: "Bearer token",
      "x-request-id": "request-1",
    });
    expect(buildGitLabApiHeaders("token", {
      "content-type": "text/plain",
    })).toEqual({
      Authorization: "Bearer token",
      "Content-Type": "application/json",
    });
  });

  it("fetches the authenticated GitLab user", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 42, username: "ve" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchGitLabCurrentUser({ baseUrl: `${BASE}/`, token: "token" }))
      .resolves.toEqual({ id: 42, username: "ve" });
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/v4/user`, {
      headers: {
        Authorization: "Bearer token",
        "Content-Type": "application/json",
      },
    });
  });

  it("surfaces authentication failures and malformed user responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("denied", { status: 401 })));
    await expect(fetchGitLabCurrentUser({ baseUrl: BASE, token: "token" }))
      .rejects.toThrow("GitLab authentication failed: denied");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    await expect(fetchGitLabCurrentUser({ baseUrl: BASE, token: "token" }))
      .rejects.toThrow("Invalid GitLab response: missing user data");
  });
});
