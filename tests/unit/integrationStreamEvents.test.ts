import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Integration } from "../../src/interfaces.js";
import { registerBuiltinPlugins } from "../../src/plugins/init.js";
import { getPluginDescriptor, registerPlugin, type PluginDescriptor } from "../../src/plugins/registry.js";
import { PluginIntegrationStreamEventsManager, type IntegrationEventStreamManager } from "../../src/connectors/integrationStreamEvents.js";

function makeIntegration(type: Integration["type"], id: string): Integration {
  return {
    id,
    type,
    name: id,
    configJson: JSON.stringify({}),
    enabled: true,
    createdAt: new Date("2026-05-01T10:00:00.000Z"),
    updatedAt: new Date("2026-05-01T10:00:00.000Z"),
  };
}

describe("PluginIntegrationStreamEventsManager", () => {
  afterEach(() => {
    registerBuiltinPlugins();
  });

  it("routes stream-capable integrations by descriptor instead of hard-coding Gerrit", async () => {
    registerBuiltinPlugins();

    const original = getPluginDescriptor("gitlab-merge-request");
    if (!original) {
      throw new Error("expected builtin gitlab-merge-request descriptor");
    }

    const listStatuses = vi.fn(() => [{
      integrationId: "gitlab-stream",
      integrationName: "gitlab-stream",
      integrationType: "gitlab-merge-request" as const,
      state: "connected" as const,
      reconnectCount: 0,
      lastEventType: "merge-request-updated",
      lastEventAt: "2026-05-01T10:00:00.000Z",
      lastError: null,
    }]);
    const streamManager: IntegrationEventStreamManager = {
      reconcile: vi.fn(async () => undefined),
      getStatus: vi.fn((integrationId: string) =>
        integrationId === "gitlab-stream"
          ? listStatuses()[0] ?? null
          : null
      ),
      listStatuses,
      stopAll: vi.fn(async () => undefined),
    };
    const createManager = vi.fn(() => streamManager);

    registerPlugin({
      ...original,
      configSchema: z.object({}),
      streamEvents: {
        createManager,
      },
    } satisfies PluginDescriptor);

    const manager = new PluginIntegrationStreamEventsManager({
      orchestrator: {
        triggerFeedbackForChange: vi.fn(async () => undefined),
        markChangeMerged: vi.fn(async () => undefined),
        markChangeAbandoned: vi.fn(async () => undefined),
      },
      getReviewTrigger: () => undefined,
    });

    const gitlabIntegration = makeIntegration("gitlab-merge-request", "gitlab-stream");
    const redmineIntegration = makeIntegration("redmine", "redmine-webhook");

    await manager.reconcile([gitlabIntegration, redmineIntegration]);

    expect(createManager).toHaveBeenCalledTimes(1);
    expect(streamManager.reconcile).toHaveBeenCalledWith([gitlabIntegration]);
    expect(manager.getStatus("gitlab-stream")).toEqual(expect.objectContaining({
      integrationType: "gitlab-merge-request",
      state: "connected",
    }));
    expect(manager.listStatuses()).toEqual([
      expect.objectContaining({
        integrationId: "gitlab-stream",
        integrationType: "gitlab-merge-request",
      }),
    ]);

    await manager.reconcile([]);

    expect(streamManager.stopAll).toHaveBeenCalledTimes(1);
  });
});