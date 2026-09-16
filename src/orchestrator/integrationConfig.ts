import type { Integration } from "../interfaces.js";
import type { ProjectModeDeps } from "./projectMode.js";

/**
 * Resolve an integration's decrypted configuration.
 *
 * Prefers the plugin manager's decryption hook so encrypted-at-rest secrets are
 * materialized, and falls back to parsing the raw `configJson` when the hook is
 * unavailable (e.g. bare project mode in tests).
 */
export function resolveIntegrationConfig(
  projectMode: ProjectModeDeps,
  integration: Integration,
): Record<string, unknown> {
  return projectMode.pluginManager.decryptIntegrationConfig?.(integration)
    ?? JSON.parse(integration.configJson) as Record<string, unknown>;
}
