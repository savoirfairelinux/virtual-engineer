import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getAgentTokenForReview } from "../../src/review/reviewBootstrap.js";
import { encryptToken } from "../../src/utils/encryption.js";
import { resetConfig } from "../../src/config.js";
import type { Integration, ProviderId } from "../../src/interfaces.js";
import type { PluginManager } from "../../src/plugins/pluginManager.js";

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
