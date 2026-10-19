import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAdminProviderSummaries } from "../../src/admin/providerSummary.js";
import { PluginManager } from "../../src/plugins/pluginManager.js";
import { registerBuiltinPlugins } from "../../src/plugins/init.js";
import type { getConfig } from "../../src/config.js";
import type { Integration, IntegrationStore } from "../../src/interfaces.js";

const config = {
  adminApiEnabled: true,
  adminApiHost: "127.0.0.1",
  adminApiPort: 3000,
  pollingIntervalMs: 30000,
} as unknown as ReturnType<typeof getConfig>;

function redmine(id: string, configJson: Record<string, unknown>): Integration {
  return { id, provider: "redmine", name: id, configJson: JSON.stringify(configJson), enabled: true, createdAt: new Date(), updatedAt: new Date() };
}

function storeOf(integrations: Integration[]): IntegrationStore {
  return {
    getIntegrations: vi.fn(async () => integrations),
    getIntegration: vi.fn(async (id: string) => integrations.find((integration) => integration.id === id) ?? null),
  } as unknown as IntegrationStore;
}

describe("buildAdminProviderSummaries health", () => {
  beforeEach(() => {
    registerBuiltinPlugins();
  });

  it("reports degraded and inactive enabled integrations as errors instead of ready or omitting them", async () => {
    const manager = new PluginManager(storeOf([
      redmine("healthy", { baseUrl: "https://redmine.example.com", apiKey: "key", virtualEngineerUserLogin: "ve" }),
      redmine("degraded", { baseUrl: "not-a-url" }),
      redmine("inactive", { baseUrl: "https://redmine.example.com", apiKey: "veenc:v1:not-valid-ciphertext", virtualEngineerUserLogin: "ve" }),
    ]), { adminAuthSecret: "current-secret" });
    await manager.loadFromDatabase();

    const byId = new Map(buildAdminProviderSummaries(config, manager).map((summary) => [summary.id, summary]));

    expect(byId.get("healthy")?.status).toBe("ready");
    expect(byId.get("degraded")?.status).toBe("error");
    expect(byId.get("degraded")?.details[0]).toContain("Connector failed: issue_tracking");
    expect(byId.get("inactive")).toMatchObject({ status: "error", category: "ticketing" });
    expect(byId.get("inactive")?.details[0]).toContain("Not active");
  });
});
