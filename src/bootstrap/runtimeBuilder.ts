/**
 * Runtime dependency construction.
 *
 * Assembles the agent adapter and builds the orchestrator configuration
 * from the current plugin manager state. Also exports shared low-level
 * helpers used by the review and admin bootstrap modules.
 */
import { MockAgentAdapter } from "../agents/mockAgentAdapter.js";
import { DockerWorkspaceRunner } from "../workspace/workspaceRunner.js";
import { PluginManager } from "../plugins/pluginManager.js";
import { getProviderDescriptor } from "../plugins/registry.js";
import { createVcsConnectorForIntegration } from "../vcs/vcsFactory.js";
import type { AgentAdapter, ConfigurableAdapter, Integration, ProviderId } from "../interfaces.js";
import type { SqliteStateStore } from "../state/stateStore.js";
import type { AppConfig } from "../config.js";

// ─── Shared low-level helpers ────────────────────────────────────────────────

/** Return `value` as a string if it is a non-empty string, otherwise undefined. */
export function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Parse an integration's `configJson` into a plain-object record; returns null on error or non-object. */
export function parseIntegrationConfig(integration: Integration | null): Record<string, unknown> | null {
  if (!integration) {
    return null;
  }

  try {
    const parsed = JSON.parse(integration.configJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Return all active integrations of `provider`, sorted newest-first. */
export function getActiveIntegrationsByType(pluginManager: PluginManager, provider: ProviderId): Integration[] {
  return pluginManager
    .getActiveIntegrationsByProvider(provider)
    .slice()
    .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
}

/** Return the most-recently-updated active integration of `provider`, or null. */
export function getPrimaryActiveIntegration(pluginManager: PluginManager, provider: ProviderId): Integration | null {
  return getActiveIntegrationsByType(pluginManager, provider)[0] ?? null;
}

// ─── Agent adapter ───────────────────────────────────────────────────────────

/** Return the first active agent-adapter connector found in the plugin manager, or null. */
function getDatabaseAgentAdapter(pluginManager: PluginManager): AgentAdapter | null {
  // Any provider that declares agent_execution qualifies — copilot, claude,
  // aider, mock, and future AI providers are all picked up automatically.
  for (const integration of pluginManager.getActiveIntegrationsByCapability("agent_execution")) {
    const connector = pluginManager.getConnectorForCapability<AgentAdapter>(integration.id, "agent_execution");
    if (connector) {
      return connector;
    }
  }
  return null;
}

export interface RuntimeDependencies {
  agentAdapter: AgentAdapter;
}

/** Assemble the mutable runtime dependencies (agent adapter) from the current plugin state. */
export function buildRuntimeDependencies(pluginManager: PluginManager): RuntimeDependencies {
  return {
    agentAdapter: getDatabaseAgentAdapter(pluginManager) ?? new MockAgentAdapter(),
  };
}

// ─── Orchestrator config ─────────────────────────────────────────────────────

/** Build the `OrchestratorConfig` by merging app config with VCS integration settings. */
export async function buildOrchestratorConfig(
  config: AppConfig,
  pluginManager: PluginManager
): Promise<import("../orchestrator/orchestrator.js").OrchestratorConfig> {
  // Resolve gitAuthorName/gitAuthorEmail through the descriptor Zod schemas so
  // that defaults declared in the schema apply even for DB rows that predate
  // this field (i.e. rows stored without the key).
  const gitLabIntegration = getPrimaryActiveIntegration(pluginManager, "gitlab");
  const gerritIntegration = getPrimaryActiveIntegration(pluginManager, "gerrit");

  let gitAuthorName: string | undefined;
  let gitAuthorEmail: string | undefined;

  // Prefer the real identity the pushing account is registered under in the
  // VCS itself (e.g. Gerrit's own account DB, looked up over the SSH
  // credentials already configured for the source_control capability) over
  // any stored config value or hardcoded placeholder. This keeps commit
  // authorship correct automatically, without a new credential type, a new
  // admin-UI field, or manual per-integration DB edits.
  //
  // Try every active integration of each provider (not just the "primary"
  // one) since the account whose commits actually need attribution may not
  // be the most-recently-updated one — e.g. a review-only Gerrit account
  // (virtual-reviewer) never owns a change, so its lookup always misses and
  // the loop must still reach the coding account (virtual-engineer).
  for (const provider of ["gerrit"] as const) {
    if (gitAuthorName && gitAuthorEmail) break;
    for (const integration of getActiveIntegrationsByType(pluginManager, provider)) {
      let connector: import("../vcs/vcsConnector.js").VcsConnector | undefined;
      try {
        connector = createVcsConnectorForIntegration(integration, undefined, config.adminAuthSecret);
      } catch {
        continue;
      }
      const identity = await connector.queryAuthorIdentity?.().catch(() => undefined);
      if (identity) {
        gitAuthorName ??= identity.name;
        gitAuthorEmail ??= identity.email;
        break;
      }
    }
  }

  for (const integration of [gitLabIntegration, gerritIntegration]) {
    if (gitAuthorName && gitAuthorEmail) break;
    if (!integration) continue;
    const raw = parseIntegrationConfig(integration);
    const descriptor = getProviderDescriptor(integration.provider);
    const result = descriptor?.configSchema.safeParse(raw ?? {});
    if (result?.success) {
      const data = result.data as Record<string, unknown>;
      gitAuthorName ??= typeof data["gitAuthorName"] === "string" ? data["gitAuthorName"] : undefined;
      gitAuthorEmail ??= typeof data["gitAuthorEmail"] === "string" ? data["gitAuthorEmail"] : undefined;
    }
  }

  return {
    maxAgentCycles: config.maxAgentCycles,
    maxRetryAttempts: config.maxRetryAttempts,
    agentTimeoutMs: config.agentTimeoutMs,
    gitAuthorName: gitAuthorName ?? "Virtual Engineer",
    gitAuthorEmail: gitAuthorEmail ?? "ve@virtual-engineer.local",
    agentContainerImage: config.agentContainerImage,
    ...(config.adminAuthSecret !== undefined ? { adminAuthSecret: config.adminAuthSecret } : {}),
  };
}

// ─── Adapter wiring ──────────────────────────────────────────────────────────

/** Wire the adapter to its runtime dependencies if it implements ConfigurableAdapter. */
export function configureAgentAdapter(
  agentAdapter: AgentAdapter,
  stateStore: SqliteStateStore,
  workspaceRunner: DockerWorkspaceRunner
): void {
  if ("configure" in agentAdapter && typeof (agentAdapter as ConfigurableAdapter).configure === "function") {
    (agentAdapter as ConfigurableAdapter).configure({ store: stateStore, runner: workspaceRunner });
  }
}
