import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Integration } from "../../src/interfaces.js";
import { registerBuiltinPlugins } from "../../src/plugins/init.js";
import type { PluginManager } from "../../src/plugins/pluginManager.js";
import { getProviderDescriptor, registerPlugin } from "../../src/plugins/registry.js";
import { scanIntegrationWorkspace, scanProjectWorkspace } from "../../src/workspace/workspaceScanService.js";

const integration: Integration = {
  id: "gitlab-1",
  provider: "gitlab",
  name: "GitLab",
  configJson: "{}",
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("workspace scan service", () => {
  beforeAll(() => {
    registerBuiltinPlugins();
  });

  it("reports integration config read failures without mislabeling decryption as invalid JSON", async () => {
    const pluginManager = {
      decryptIntegrationConfig: vi.fn(() => {
        throw new Error("Unable to decrypt integration credential");
      }),
    } as unknown as PluginManager;

    await expect(scanIntegrationWorkspace({
      integration,
      pluginManager,
      repoKey: "platform/root",
      cloneUrl: "https://gitlab.test/platform/root.git",
    })).rejects.toThrow("Unable to read stored integration config: Unable to decrypt integration credential");
  });

  it("scans the same matched repository separately at different revisions", async () => {
    const originalDescriptor = getProviderDescriptor("gitlab")!;
    const readWorkspaceManifestFiles = vi.fn(async (_config: unknown, repoKey: string, _revision?: string) => {
      if (repoKey === "platform/root") {
        return [{
          path: ".gitmodules",
          content: `
[submodule "shared-v1"]
  path = deps/shared-v1
  url = https://gitlab.test/platform/shared.git
  branch = v1
[submodule "shared-v2"]
  path = deps/shared-v2
  url = https://gitlab.test/platform/shared.git
  branch = v2
`,
        }];
      }
      expect(repoKey).toBe("platform/shared");
      return [{ path: "workspace.repos", content: "repositories: {}\n" }];
    });
    registerPlugin({ ...originalDescriptor, readWorkspaceManifestFiles });
    const discoveredResourcesJson = JSON.stringify({
      repositories: [{
        key: "platform/shared",
        name: "Shared",
        cloneUrlHttp: "https://gitlab.test/platform/shared.git",
      }],
    });

    try {
      await scanProjectWorkspace({
        rootIntegration: { ...integration, discoveredResourcesJson },
        integrations: [{ ...integration, discoveredResourcesJson }],
        repoKey: "platform/root",
        cloneUrl: "https://gitlab.test/platform/root.git",
        revision: "main",
      });
    } finally {
      registerPlugin(originalDescriptor);
    }

    expect(readWorkspaceManifestFiles.mock.calls
      .filter((call) => call[1] === "platform/shared")
      .map((call) => call[2])).toEqual(["v1", "v2"]);
  });

  it("classifies scanned repositories by whether VE can push to them", async () => {
    const originalDescriptor = getProviderDescriptor("gitlab")!;
    const readWorkspaceManifestFiles = vi.fn(async (_config: unknown, repoKey: string, _revision?: string) => {
      if (repoKey !== "platform/root") return [];
      return [{
        path: "kas/config.yaml",
        content: `
header:
  version: 14
repos:
  meta-product:
  shared:
    url: https://gitlab.test/platform/shared.git
    refspec: main
    path: layers/shared
  upstream:
    url: https://git.yoctoproject.org/git/poky
    refspec: kirkstone
    path: layers/poky
`,
      }];
    });
    registerPlugin({ ...originalDescriptor, readWorkspaceManifestFiles });
    const discoveredResourcesJson = JSON.stringify({
      repositories: [{
        key: "platform/shared",
        name: "Shared",
        cloneUrlHttp: "https://gitlab.test/platform/shared.git",
      }],
    });

    try {
      const scan = await scanProjectWorkspace({
        rootIntegration: { ...integration, discoveredResourcesJson },
        integrations: [{ ...integration, discoveredResourcesJson }],
        repoKey: "platform/root",
        cloneUrl: "https://gitlab.test/platform/root.git",
      });

      expect(scan.repositories.map((repository) => [repository.localPath, repository.origin])).toEqual([
        ["meta-product", "internal"],
        ["layers/shared", "fork_pushable"],
        ["layers/poky", "patch_required"],
      ]);
    } finally {
      registerPlugin(originalDescriptor);
    }
  });

  it("classifies repositories of disabled matching integrations as patch targets", async () => {
    const originalDescriptor = getProviderDescriptor("gitlab")!;
    const readWorkspaceManifestFiles = vi.fn(async () => [{
      path: "kas/config.yaml",
      content: "header:\n  version: 14\nrepos:\n  shared:\n    url: https://gitlab.test/platform/shared.git\n",
    }]);
    registerPlugin({ ...originalDescriptor, readWorkspaceManifestFiles });
    const discoveredResourcesJson = JSON.stringify({
      repositories: [{
        key: "platform/shared",
        name: "Shared",
        cloneUrlHttp: "https://gitlab.test/platform/shared.git",
      }],
    });

    try {
      const scan = await scanProjectWorkspace({
        rootIntegration: { ...integration, discoveredResourcesJson },
        integrations: [{ ...integration, discoveredResourcesJson, enabled: false }],
        repoKey: "platform/root",
        cloneUrl: "https://gitlab.test/platform/root.git",
      });

      expect(scan.repositories.map((repository) => repository.origin)).toEqual(["patch_required"]);
    } finally {
      registerPlugin(originalDescriptor);
    }
  });
});