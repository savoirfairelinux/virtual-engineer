/**
 * VCS Connector Factory — create the appropriate VCS connector based on configuration.
 *
 * This factory centralizes all VCS instantiation logic, allowing the rest of the
 * application to remain agnostic about which VCS is in use.
 *
 * Per-integration: `VcsConnectorFactory.getConnector(integration)` — DB-driven config
 */

import type { Integration, IntegrationBindingContext } from "../interfaces.js";
import type { VcsConnector } from "./vcsConnector.js";
import { getPluginDescriptor } from "../plugins/registry.js";

/**
 * Parse and fully validate an integration's configJson through its descriptor's
 * Zod schema. Defaults (e.g. sshKeyPath, gitAuthorName) are applied here.
 */
function parseConfig(integration: Integration): Record<string, unknown> {
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(integration.configJson);
  } catch {
    throw new Error(`Integration ${integration.id}: invalid configJson (not valid JSON)`);
  }

  const descriptor = getPluginDescriptor(integration.type);
  if (!descriptor) {
    throw new Error(
      `Integration ${integration.id}: no descriptor registered for type "${integration.type}"`
    );
  }

  const result = descriptor.configSchema.safeParse(rawJson);
  if (!result.success) {
    throw new Error(
      `Integration ${integration.id}: invalid config: ${result.error.message}`
    );
  }

  return result.data as Record<string, unknown>;
}

/**
 * Create a VcsConnector from a persisted Integration record.
 * Delegates to the descriptor's `createVcsConnector` hook — no type-specific
 * logic lives here. Adding a new VCS integration only requires implementing
 * `createVcsConnector` on its descriptor.
 *
 * @throws {Error} If the integration type has no `createVcsConnector` hook
 * @throws {Error} If configJson is not valid JSON or fails schema validation
 */
export function createVcsConnectorForIntegration(integration: Integration, context?: IntegrationBindingContext): VcsConnector {
  const descriptor = getPluginDescriptor(integration.type);

  if (!descriptor?.createVcsConnector) {
    throw new Error(
      `Integration ${integration.id} has type "${integration.type}" which is not a VCS push target.`
    );
  }

  const cfg = parseConfig(integration);
  return descriptor.createVcsConnector(cfg, integration, context);
}

/**
 * Per-integration VCS connector factory with connector caching.
 * Use this class in the orchestrator to avoid re-creating connectors on every cycle.
 */
export class VcsConnectorFactory {
  private readonly cache = new Map<string, VcsConnector>();

  /**
   * Get (or create) a VcsConnector for the given Integration.
   * The connector is cached by integration id. If the integration config changes,
   * call `invalidate(integrationId)` to force recreation.
   */
  getConnector(integration: Integration, context?: IntegrationBindingContext): VcsConnector {
    if (context !== undefined) {
      return createVcsConnectorForIntegration(integration, context);
    }

    const cached = this.cache.get(integration.id);
    if (cached) return cached;

    const connector = createVcsConnectorForIntegration(integration);
    this.cache.set(integration.id, connector);
    return connector;
  }

  /**
   * Invalidate the cached connector for an integration (e.g., after config update).
   */
  invalidate(integrationId: string): void {
    this.cache.delete(integrationId);
  }

  /** Clear all cached connectors. */
  clear(): void {
    this.cache.clear();
  }
}
