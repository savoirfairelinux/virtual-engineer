import { describe, expect, it } from "vitest";
import { scanWorkspaceManifests, WORKSPACE_MANIFEST_MAX_FILES } from "../../src/workspace/workspaceManifestScanner.js";

describe("scanWorkspaceManifests", () => {
  it("parses Git submodules and resolves relative URLs", () => {
    const result = scanWorkspaceManifests({
      rootCloneUrl: "https://git.example.com/platform/root.git",
      files: [{
        path: ".gitmodules",
        content: `
[submodule "libs/runtime"]
  path = libs/runtime
  url = ../runtime.git
  branch = stable
`,
      }],
    });

    expect(result.repositories).toEqual([{
      cloneUrl: "https://git.example.com/platform/runtime.git",
      localPath: "libs/runtime",
      revision: "stable",
      relation: "gitlink",
      sourcePath: ".gitmodules",
    }]);
    expect(result.diagnostics).toEqual([]);
  });

  it("parses west manifests with remotes and explicit URLs", () => {
    const result = scanWorkspaceManifests({
      rootCloneUrl: "https://git.example.com/platform/root.git",
      files: [{
        path: "west.yml",
        content: `
manifest:
  remotes:
    - name: upstream
      url-base: https://git.example.com/zephyr
  defaults:
    remote: upstream
    revision: main
  projects:
    - name: kernel
      path: deps/kernel
      repo-path: core/kernel
      revision: v3.7
    - name: tools
      url: ssh://git@git.example.com:29418/tools.git
`,
      }],
    });

    expect(result.repositories).toEqual([
      {
        cloneUrl: "https://git.example.com/zephyr/core/kernel",
        localPath: "deps/kernel",
        revision: "v3.7",
        relation: "manifest_member",
        sourcePath: "west.yml",
      },
      {
        cloneUrl: "ssh://git@git.example.com:29418/tools.git",
        localPath: "tools",
        revision: "main",
        relation: "manifest_member",
        sourcePath: "west.yml",
      },
    ]);
  });

  it("parses Google repo XML defaults and project overrides", () => {
    const result = scanWorkspaceManifests({
      rootCloneUrl: "https://git.example.com/manifests/platform.git",
      files: [{
        path: "manifest.xml",
        content: `
<manifest>
  <remote name="origin" fetch="https://git.example.com/platform" revision="refs/heads/stable" />
  <default remote="origin" revision="main" />
  <project name="apps/api.git" path="services/api" />
  <project name="libs/common" path="libs/common" revision="v2" />
</manifest>
`,
      }],
    });

    expect(result.repositories).toEqual([
      {
        cloneUrl: "https://git.example.com/platform/apps/api.git",
        localPath: "services/api",
        revision: "refs/heads/stable",
        relation: "manifest_member",
        sourcePath: "manifest.xml",
      },
      {
        cloneUrl: "https://git.example.com/platform/libs/common",
        localPath: "libs/common",
        revision: "v2",
        relation: "manifest_member",
        sourcePath: "manifest.xml",
      },
    ]);
  });

  it("parses vcstool .repos files and ignores non-Git entries", () => {
    const result = scanWorkspaceManifests({
      rootCloneUrl: "https://git.example.com/platform/root.git",
      files: [{
        path: "workspace.repos",
        content: `
repositories:
  src/api:
    type: git
    url: https://git.example.com/services/api.git
    version: release/1
  src/generated:
    type: tar
    url: https://artifacts.example.com/generated.tar
`,
      }],
    });

    expect(result.repositories).toEqual([{
      cloneUrl: "https://git.example.com/services/api.git",
      localPath: "src/api",
      revision: "release/1",
      relation: "manifest_member",
      sourcePath: "workspace.repos",
    }]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      sourcePath: "workspace.repos",
      severity: "info",
    }));
  });

  it("anchors repositories from nested contrib manifests under their directory", () => {
    const result = scanWorkspaceManifests({
      rootCloneUrl: "https://git.example.com/platform/root.git",
      files: [{
        path: "contrib/workspace.repos",
        content: `
repositories:
  src/codec:
    type: git
    url: https://git.example.com/contrib/codec.git
    version: stable
`,
      }],
    });

    expect(result.repositories).toEqual([{
      cloneUrl: "https://git.example.com/contrib/codec.git",
      localPath: "contrib/src/codec",
      revision: "stable",
      relation: "manifest_member",
      sourcePath: "contrib/workspace.repos",
    }]);
  });

  it("parses Jami contrib package metadata into repository dependencies", () => {
    const result = scanWorkspaceManifests({
      rootCloneUrl: "https://git.jami.net/savoirfairelinux/jami-daemon.git",
      files: [{
        path: "contrib/src/opendht/package.json",
        content: JSON.stringify({
          name: "opendht",
          version: "4.2.0",
          url: "https://github.com/savoirfairelinux/opendht/archive/v__VERSION__.tar.gz",
        }),
      }],
    });

    expect(result.repositories).toEqual([{
      cloneUrl: "https://github.com/savoirfairelinux/opendht.git",
      localPath: ".ve-deps/opendht",
      revision: "4.2.0",
      relation: "manifest_member",
      sourcePath: "contrib/src/opendht/package.json",
    }]);
  });

  it("parses static CMake FetchContent Git repositories and archive URLs", () => {
    const result = scanWorkspaceManifests({
      rootCloneUrl: "https://git.example.com/platform/root.git",
      files: [{
        path: "tests/CMakeLists.txt",
        content: `
FetchContent_Declare(simdutf
  GIT_REPOSITORY "https://github.com/simdutf/simdutf.git"
  GIT_TAG "v8.0.0"
)
FetchContent_Declare(
  googletest
  URL https://github.com/google/googletest/archive/refs/tags/release-1.11.0.zip
)
FetchContent_Declare(dynamic_dep GIT_REPOSITORY \${DYNAMIC_URL})
`,
      }],
    });

    expect(result.repositories).toEqual([
      {
        cloneUrl: "https://github.com/simdutf/simdutf.git",
        localPath: ".ve-deps/simdutf",
        revision: "v8.0.0",
        relation: "manifest_member",
        sourcePath: "tests/CMakeLists.txt",
      },
      {
        cloneUrl: "https://github.com/google/googletest.git",
        localPath: ".ve-deps/googletest",
        revision: "release-1.11.0",
        relation: "manifest_member",
        sourcePath: "tests/CMakeLists.txt",
      },
    ]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      sourcePath: "tests/CMakeLists.txt",
      message: expect.stringContaining("dynamic_dep"),
    }));
  });

  it("parses JSONC VS Code workspaces without inventing remotes", () => {
    const result = scanWorkspaceManifests({
      rootCloneUrl: "https://git.example.com/platform/root.git",
      files: [{
        path: "platform.code-workspace",
        content: `{
          // Multi-root IDE layout
          "folders": [
            { "path": "." },
            { "path": "services/api", "name": "API" },
            { "uri": "https://git.example.com/tools/cli.git", "name": "CLI" }
          ]
        }`,
      }],
    });

    expect(result.repositories).toEqual([
      {
        cloneUrl: null,
        localPath: "services/api",
        revision: null,
        relation: "contains",
        sourcePath: "platform.code-workspace",
      },
      {
        cloneUrl: "https://git.example.com/tools/cli.git",
        localPath: "CLI",
        revision: null,
        relation: "contains",
        sourcePath: "platform.code-workspace",
      },
    ]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      message: expect.stringContaining("does not declare a repository URL"),
      sourcePath: "platform.code-workspace",
      severity: "warning",
    }));
  });

  it("does not expose local or unsupported workspace URIs as clone URLs", () => {
    const result = scanWorkspaceManifests({
      rootCloneUrl: "https://git.example.com/platform/root.git",
      files: [{
        path: "platform.code-workspace",
        content: JSON.stringify({
          folders: [
            { uri: "file:///home/user/private-project", name: "Local project" },
            { uri: "vscode-remote://ssh-remote+host/home/user/remote-project", name: "Remote project" },
          ],
        }),
      }],
    });

    expect(result.repositories).toEqual([
      expect.objectContaining({ cloneUrl: null, localPath: "Local project" }),
      expect.objectContaining({ cloneUrl: null, localPath: "Remote project" }),
    ]);
    expect(result.repositories.every((repository) => !repository.cloneUrl?.includes("/home/user/"))).toBe(true);
  });

  it("ignores submodules that use unsupported clone URL schemes", () => {
    const result = scanWorkspaceManifests({
      rootCloneUrl: "https://git.example.com/platform/root.git",
      files: [{
        path: ".gitmodules",
        content: `[submodule "local"]\n  path = deps/local\n  url = file:///home/user/private.git\n`,
      }],
    });

    expect(result.repositories).toEqual([]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      message: expect.stringContaining("unsupported repository URL"),
    }));
  });

  it("reports malformed manifests without throwing or returning partial garbage", () => {
    const result = scanWorkspaceManifests({
      rootCloneUrl: "https://git.example.com/platform/root.git",
      files: [
        { path: "west.yml", content: "manifest: [" },
        { path: "manifest.xml", content: "<manifest><project" },
        { path: "bad.code-workspace", content: "{ folders: [" },
      ],
    });

    expect(result.repositories).toEqual([]);
    expect(result.diagnostics).toHaveLength(3);
    expect(result.diagnostics.every((diagnostic) => diagnostic.severity === "error")).toBe(true);
  });

  it("rejects XML manifests containing a DOCTYPE declaration", () => {
    const result = scanWorkspaceManifests({
      rootCloneUrl: "https://git.example.com/platform/root.git",
      files: [{
        path: "manifest.xml",
        content: "<!DOCTYPE manifest [<!ENTITY x 'value'>]><manifest><project name='&x;'/></manifest>",
      }],
    });

    expect(result.repositories).toEqual([]);
    expect(result.diagnostics).toEqual([expect.objectContaining({
      severity: "error",
      message: expect.stringContaining("DOCTYPE"),
    })]);
  });

  it("reports and enforces the manifest-count limit", () => {
    const result = scanWorkspaceManifests({
      rootCloneUrl: "https://git.example.com/platform/root.git",
      files: Array.from({ length: WORKSPACE_MANIFEST_MAX_FILES + 1 }, (_, index) => ({ path: `unknown-${index}`, content: "" })),
    });

    expect(result.repositories).toEqual([]);
    expect(result.diagnostics).toEqual([expect.objectContaining({
      severity: "error",
      message: expect.stringContaining(`first ${WORKSPACE_MANIFEST_MAX_FILES} of ${WORKSPACE_MANIFEST_MAX_FILES + 1}`),
    })]);
  });
});