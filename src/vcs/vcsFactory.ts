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
import { getProviderDescriptor } from "../plugins/registry.js";
import { decryptToken } from "../utils/encryption.js";
import type { GitRunner } from "./gitRunner.js";
import { NodeGitRunner } from "./nodeGitRunner.js";
import type { SourceControlRuntimeContext } from "../plugins/registry.js";

/**
 * Parse and fully validate an integration's configJson through its descriptor's
 * Zod schema. Defaults (e.g. sshKeyPath, gitAuthorName) are applied here.
 * Password fields are decrypted when adminAuthSecret is provided.
 */
function parseConfig(integration: Integration, adminAuthSecret?: string): Record<string, unknown> {
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(integration.configJson);
  } catch {
    throw new Error(`Integration ${integration.id}: invalid configJson (not valid JSON)`);
  }

  const descriptor = getProviderDescriptor(integration.provider);
  if (!descriptor) {
    throw new Error(
      `Integration ${integration.id}: no descriptor registered for provider "${integration.provider}"`
    );
  }

  const result = descriptor.configSchema.safeParse(rawJson);
  if (!result.success) {
    throw new Error(
      `Integration ${integration.id}: invalid config: ${result.error.message}`
    );
  }

  const cfg = result.data as Record<string, unknown>;

  // Decrypt password fields so connectors always receive plaintext credentials.
  if (adminAuthSecret !== undefined) {
    for (const field of descriptor.requiredFields.filter((f) => f.type === "password")) {
      const raw = cfg[field.key];
      if (typeof raw === "string" && raw.length > 0) {
        try {
          cfg[field.key] = decryptToken(raw, adminAuthSecret);
        } catch {
          // Already plaintext — leave as-is
        }
      }
    }
  }

  // Apply provider-specific config preprocessing (e.g. SSH key resolution).
  if (descriptor.preprocessConfig) {
    const extra = descriptor.preprocessConfig(cfg, adminAuthSecret, integration.id);
    Object.assign(cfg, extra);
  }

  return cfg;
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
export function createVcsConnectorForIntegration(
  integration: Integration,
  context?: IntegrationBindingContext,
  adminAuthSecret?: string,
  runtime?: SourceControlRuntimeContext
): VcsConnector {
  const descriptor = getProviderDescriptor(integration.provider);
  const createVcsConnector = descriptor?.capabilities.source_control?.createVcsConnector;

  if (!createVcsConnector) {
    throw new Error(
      `Integration ${integration.id} has provider "${integration.provider}" which is not a VCS push target.`
    );
  }

  const cfg = parseConfig(integration, adminAuthSecret);
  return createVcsConnector(cfg, integration, context, runtime);
}

/**
 * Per-integration VCS connector factory with connector caching.
 * Use this class in the orchestrator to avoid re-creating connectors on every cycle.
 */
export class VcsConnectorFactory {
  private readonly cache = new Map<string, VcsConnector>();
  private readonly gitRunner: GitRunner;

  constructor(private readonly options: {
    adminAuthSecret?: string | undefined;
    gitRunner?: GitRunner | undefined;
  } = {}) {
    this.gitRunner = options.gitRunner ?? new NodeGitRunner();
  }

  /**
   * Get (or create) a VcsConnector for the given Integration.
   * The connector is cached by integration id. If the integration config changes,
   * call `invalidate(integrationId)` to force recreation.
   */
  getConnector(integration: Integration, context?: IntegrationBindingContext): VcsConnector {
    if (context !== undefined) {
      return createVcsConnectorForIntegration(
        integration,
        context,
        this.options.adminAuthSecret,
        { gitRunner: this.gitRunner }
      );
    }

    const cached = this.cache.get(integration.id);
    if (cached) return cached;

    const connector = createVcsConnectorForIntegration(
      integration,
      undefined,
      this.options.adminAuthSecret,
      { gitRunner: this.gitRunner }
    );
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
