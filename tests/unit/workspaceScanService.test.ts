import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Integration } from "../../src/interfaces.js";
import { registerBuiltinPlugins } from "../../src/plugins/init.js";
import type { PluginManager } from "../../src/plugins/pluginManager.js";
import { scanIntegrationWorkspace } from "../../src/workspace/workspaceScanService.js";

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
});