import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildReviewBundle, getAgentTokenForReview, resolveReviewIntegration } from "../../src/review/reviewBootstrap.js";
import { encryptToken } from "../../src/utils/encryption.js";
import { resetConfig } from "../../src/config.js";
import { ProjectReconfigurationIncompatibleError } from "../../src/domain/projectConfiguration.js";
import { makeExternalChangeId, makeProjectId, makeTaskId, type Integration, type ProviderId, type Task, type WorkspaceRunner } from "../../src/interfaces.js";
import type { PluginManager } from "../../src/plugins/pluginManager.js";
import { registerBuiltinPlugins } from "../../src/plugins/init.js";

const TEST_ADMIN_AUTH_SECRET = "test-secret-32-bytes-min-padding!";

function makeIntegration(provider: ProviderId, configJson: Record<string, unknown>): Integration {
  return {
    id: "int-1",
    provider,
    name: "test",
    configJson: JSON.stringify(configJson),
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeReviewTask(overrides: Partial<Task> = {}): Task {
  return {
    taskId: makeTaskId("review-bootstrap-task"),
    ticketId: "gerrit:42" as Task["ticketId"],
    displayId: "42",
    ticketTitle: "Review change",
    ticketDescription: "",
    state: "REVIEW_PENDING",
    taskType: "code-review",
    ticketSourceLabel: "gerrit:gerrit-old",
    externalChangeId: makeExternalChangeId("project/repo#42"),
    currentPatchset: 1,
    reviewedPatchset: null,
    cycleCount: 0,
    failureReason: null,
    ticketUrl: null,
    reviewUrl: null,
    projectId: makeProjectId("review-project"),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** Minimal PluginManager stub exposing only decryptIntegrationConfig, as used by getAgentTokenForReview. */
function makePluginManager(decrypted: Record<string, unknown>): PluginManager {
  return {
    decryptIntegrationConfig: () => decrypted,
  } as unknown as PluginManager;
}

describe("getAgentTokenForReview", () => {
  beforeEach(() => {
    process.env["ADMIN_AUTH_SECRET"] = TEST_ADMIN_AUTH_SECRET;
    resetConfig();
  });

  afterEach(() => {
    delete process.env["ADMIN_AUTH_SECRET"];
    resetConfig();
  });

  it("reads the codex subscription credential from accessToken, not sessionToken", () => {
    const encrypted = encryptToken("codex-access-xyz", TEST_ADMIN_AUTH_SECRET);
    const integration = makeIntegration("codex", { authMode: "subscription", accessToken: encrypted });
    const pluginManager = makePluginManager({ authMode: "subscription", accessToken: encrypted });

    const token = getAgentTokenForReview(pluginManager, integration);
    expect(token).toBe("codex-access-xyz");
  });

  it("returns null for codex subscription mode when accessToken is absent", () => {
    const integration = makeIntegration("codex", { authMode: "subscription" });
    const pluginManager = makePluginManager({ authMode: "subscription" });

    expect(getAgentTokenForReview(pluginManager, integration)).toBeNull();
  });

  it("reads the codex api_key credential from apiKey", () => {
    const integration = makeIntegration("codex", { authMode: "api_key", apiKey: "sk-openai-key" });
    const pluginManager = makePluginManager({ authMode: "api_key", apiKey: "sk-openai-key" });

    expect(getAgentTokenForReview(pluginManager, integration)).toBe("sk-openai-key");
  });

  it("still reads the claude subscription credential from sessionToken (no regression)", () => {
    const encrypted = encryptToken("sk-ant-oat-xyz", TEST_ADMIN_AUTH_SECRET);
    const integration = makeIntegration("claude", { authMode: "subscription", sessionToken: encrypted });
    const pluginManager = makePluginManager({ authMode: "subscription", sessionToken: encrypted });

    expect(getAgentTokenForReview(pluginManager, integration)).toBe("sk-ant-oat-xyz");
  });

  it("returns null for a null integration", () => {
    expect(getAgentTokenForReview(makePluginManager({}), null)).toBeNull();
  });

  it("fails closed when the managed integration token cannot be decrypted", () => {
    const integration = makeIntegration("aider", {
      aiderBackend: "openai",
      aiderApiKey: "veenc:v1:not-valid-ciphertext",
    });
    const pluginManager = {
      decryptIntegrationConfig: () => {
        throw new Error("Stored token cannot be decrypted; reconnect OAuth.");
      },
    } as unknown as PluginManager;

    expect(() => getAgentTokenForReview(pluginManager, integration)).toThrow(
      "Stored token cannot be decrypted; reconnect OAuth."
    );
  });
});

describe("resolveReviewIntegration", () => {
  it("does not route an old review task to a different active integration", () => {
    registerBuiltinPlugins();
    const replacement = makeIntegration("gerrit", {});
    replacement.id = "gerrit-new";
    const pluginManager = {
      getActiveIntegrationById: () => null,
      getActiveIntegrationsByCapability: () => [replacement],
    } as unknown as PluginManager;

    expect(resolveReviewIntegration(pluginManager, {
      ticketSourceLabel: "gerrit:gerrit-removed",
    } as Task)).toBeNull();
  });
});

describe("buildReviewBundle project binding", () => {
  it("rejects a targeted task when its project now uses another review integration", async () => {
    const pluginManager = {
      getActiveIntegrationById: () => null,
    } as unknown as PluginManager;
    const stateStore = {
      getProjectReviewConfig: async () => ({ integrationId: "gerrit-new", repos: ["project/repo"] }),
    } as unknown as Parameters<typeof buildReviewBundle>[2];

    await expect(buildReviewBundle(
      pluginManager,
      "/workspaces",
      stateStore,
      {} as WorkspaceRunner,
      undefined,
      makeReviewTask(),
    )).rejects.toBeInstanceOf(ProjectReconfigurationIncompatibleError);
  });

  it("keeps a matching task unavailable when its review runtime is inactive", async () => {
    const getActiveIntegrationById = vi.fn(() => null);
    const pluginManager = { getActiveIntegrationById } as unknown as PluginManager;
    const stateStore = {
      getProjectReviewConfig: async () => ({ integrationId: "gerrit-old", repos: ["project/repo"] }),
    } as unknown as Parameters<typeof buildReviewBundle>[2];

    const bundle = await buildReviewBundle(
      pluginManager,
      "/workspaces",
      stateStore,
      {} as WorkspaceRunner,
      undefined,
      makeReviewTask(),
    );

    expect(bundle.orchestrator).toBeNull();
    expect(getActiveIntegrationById).toHaveBeenCalledWith("gerrit-old");
  });

  it("rejects a targeted task when its qualified repository is no longer bound", async () => {
    const pluginManager = {} as PluginManager;
    const stateStore = {
      getProjectReviewConfig: async () => ({ integrationId: "gerrit-old", repos: ["another/repo"] }),
    } as unknown as Parameters<typeof buildReviewBundle>[2];

    await expect(buildReviewBundle(
      pluginManager,
      "/workspaces",
      stateStore,
      {} as WorkspaceRunner,
      undefined,
      makeReviewTask(),
    )).rejects.toBeInstanceOf(ProjectReconfigurationIncompatibleError);
  });
});
