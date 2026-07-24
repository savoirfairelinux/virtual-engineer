import { describe, it, expect } from "vitest";
import { isAllowedGitLabProxyTarget, rewriteGitLabUploadUrl } from "../../src/utils/gitlabAuth.js";

const BASE = "https://gitlab.example.com";
const SECRET = "0123456789abcdef0123456789abcdef";

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
    `https://gitlab.example.com.attacker.test/uploads/${SECRET}/image.png`,
    `http://gitlab.example.com/uploads/${SECRET}/image.png`,
    `https://gitlab.example.com:8443/uploads/${SECRET}/image.png`,
    `https://user:password@gitlab.example.com/uploads/${SECRET}/image.png`,
    "not-a-url",
  ])("rejects unsafe target %s", (target) => {
    expect(isAllowedGitLabProxyTarget(target, BASE)).toBe(false);
  });
});
