import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isWorkspaceManifestPath,
  readGitHubWorkspaceManifestFiles,
  readGitLabWorkspaceManifestFiles,
} from "../../src/workspace/repositoryManifestAccess.js";
import { WORKSPACE_MANIFEST_MAX_BYTES } from "../../src/workspace/workspaceManifestScanner.js";

describe("repository manifest access", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("allows supported manifests at bounded nested paths", () => {
    expect([
      ".gitmodules",
      "west.yml",
      "manifest.xml",
      "default.xml",
      "workspace.repos",
      "platform.code-workspace",
      "contrib/workspace.repos",
      "deps/platform/west.yml",
      "daemon/contrib/src/opendht/package.json",
      "tests/CMakeLists.txt",
      "src/modules/media/tests/fixtures/CMakeLists.txt",
    ].every(isWorkspaceManifestPath)).toBe(true);
    expect([
      "README.md",
      "../workspace.repos",
      "contrib/../../workspace.repos",
      "one/two/three/four/five/west.yml",
      "manifest.yaml",
      "src/package.json",
      "build/_deps/googletest/CMakeLists.txt",
      "cmake-build-debug/generated/CMakeLists.txt",
    ].some(isWorkspaceManifestPath)).toBe(false);
  });

  it("recursively lists, filters, and decodes GitHub manifests at the requested revision", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        truncated: false,
        tree: [
          { type: "blob", path: ".gitmodules" },
          { type: "blob", path: "contrib/workspace.repos" },
          { type: "blob", path: "README.md" },
          { type: "tree", path: "contrib" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        encoding: "base64",
        content: Buffer.from("[submodule \"api\"]\npath=api\nurl=https://example.com/api.git\n").toString("base64"),
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        encoding: "base64",
        content: Buffer.from("repositories: {}\n").toString("base64"),
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const files = await readGitHubWorkspaceManifestFiles({
      apiBaseUrl: "https://api.github.test",
      token: "secret",
      repoKey: "platform/root",
      revision: "stable",
    });

    expect(files).toEqual([
      {
        path: ".gitmodules",
        content: "[submodule \"api\"]\npath=api\nurl=https://example.com/api.git\n",
      },
      {
        path: "contrib/workspace.repos",
        content: "repositories: {}\n",
      },
    ]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/repos/platform/root/git/trees/stable?recursive=1");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/contents/.gitmodules?ref=stable");
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("/contents/contrib/workspace.repos?ref=stable");
  });

  it("requests a recursive GitLab tree and reads nested manifests", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { type: "blob", path: "contrib/workspace.repos" },
        { type: "blob", path: "contrib/README.md" },
      ]), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response("repositories: {}\n", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const files = await readGitLabWorkspaceManifestFiles({
      baseUrl: "https://gitlab.test",
      token: "secret",
      repoKey: "platform/root",
      revision: "stable",
    });

    expect(files).toEqual([{ path: "contrib/workspace.repos", content: "repositories: {}\n" }]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("recursive=true");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("contrib%2Fworkspace.repos/raw");
  });

  it("rejects decoded manifests above the byte limit", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        truncated: false,
        tree: [{ type: "blob", path: "workspace.repos" }],
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        encoding: "base64",
        content: Buffer.alloc(WORKSPACE_MANIFEST_MAX_BYTES + 1, "a").toString("base64"),
      }), { status: 200, headers: { "content-type": "application/json" } })));

    await expect(readGitHubWorkspaceManifestFiles({
      apiBaseUrl: "https://api.github.test",
      token: "secret",
      repoKey: "platform/root",
    })).rejects.toThrow("exceeds the 256 KiB limit");
  });
});