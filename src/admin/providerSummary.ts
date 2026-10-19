/**
 * Admin UI provider summary construction.
 *
 * Builds the list of `AdminProviderSummary` entries displayed in the admin
 * dashboard's provider panel, extracted from the main entry point to keep
 * `src/index.ts` focused on bootstrap orchestration.
 */
import { PluginManager } from "../plugins/pluginManager.js";
import { getProviderDescriptor, getProviderDomainCapabilities, getCapabilityIntake } from "../plugins/registry.js";
import { parseIntegrationConfig } from "../bootstrap/runtimeBuilder.js";
import type { AdminProviderSummary } from "./adminServer.js";
import type { DomainCapability, Integration } from "../interfaces.js";
import type { getConfig } from "../config.js";

/** Build the list of `AdminProviderSummary` entries shown in the admin UI's provider panel. */
export function buildAdminProviderSummaries(
  config: ReturnType<typeof getConfig>,
  pluginManager?: PluginManager
): AdminProviderSummary[] {
  const summaries: AdminProviderSummary[] = [
    {
      id: "admin-api",
      name: "Admin API",
      category: "runtime",
      domainCapabilities: [],
      intake: {},
      enabled: config.adminApiEnabled,
      configured: true,
      status: config.adminApiEnabled ? "ready" : "disabled",
      details: [`Bound to ${config.adminApiHost}:${config.adminApiPort}`],
    },
  ];

  if (!pluginManager) {
    return summaries;
  }

  const activeIntegrations = [
    ...pluginManager.getActiveIntegrationsByCapability("issue_tracking"),
    ...pluginManager.getActiveIntegrationsByCapability("code_review"),
    ...pluginManager.getActiveIntegrationsByCapability("agent_execution"),
  ];

  const failures = new Map(pluginManager.getActivationFailures().map((failure) => [failure.integration.id, failure]));
  for (const integration of activeIntegrations) {
    if (summaries.some((s) => s.id === integration.id)) continue;
    const summary = buildAdminProviderSummaryForIntegration(integration, config);
    const failure = failures.get(integration.id);
    summaries.push(failure && failure.failedCapabilities.length > 0
      ? { ...summary, status: "error", details: [`Connector failed: ${failure.failedCapabilities.join(", ")}`, ...summary.details] }
      : summary);
  }
  for (const failure of failures.values()) {
    if (failure.active || summaries.some((s) => s.id === failure.integration.id)) continue;
    summaries.push(buildFailedIntegrationSummary(failure.integration));
  }

  return summaries;
}

/** Summary for an enabled integration that could not be activated at runtime. */
function buildFailedIntegrationSummary(integration: Integration): AdminProviderSummary {
  const descriptor = getProviderDescriptor(integration.provider);
  const domainCapabilities = descriptor ? getProviderDomainCapabilities(descriptor) : [];
  return {
    id: integration.id,
    name: integration.name,
    category: domainCapabilities.includes("issue_tracking")
      ? "ticketing"
      : domainCapabilities.includes("code_review") ? "review" : "agent",
    domainCapabilities,
    intake: {},
    enabled: integration.enabled,
    configured: true,
    status: "error",
    details: ["Not active: activation failed; check the integration configuration and orchestrator logs"],
  };
}

/** Build a single `AdminProviderSummary` for an active integration, with type-specific detail lines. */
function buildAdminProviderSummaryForIntegration(
  integration: Integration,
  config: ReturnType<typeof getConfig>
): AdminProviderSummary {
  const parsed = parseIntegrationConfig(integration) ?? {};
  const descriptor = getProviderDescriptor(integration.provider);
  if (!descriptor) {
    throw new Error(`No descriptor registered for active integration provider '${integration.provider}' (id: ${integration.id})`);
  }
  const domainCapabilities = getProviderDomainCapabilities(descriptor);
  const intake: Partial<Record<DomainCapability, Array<"polling" | "webhook" | "stream">>> = {};
  for (const capability of domainCapabilities) {
    const mechanisms = getCapabilityIntake(descriptor, capability);
    if (mechanisms.length > 0) {
      intake[capability] = mechanisms;
    }
  }
  const summaryCategory: AdminProviderSummary["category"] = domainCapabilities.includes("issue_tracking")
    ? "ticketing"
    : domainCapabilities.includes("code_review")
      ? "review"
      : "agent";
  return {
    id: integration.id,
    name: integration.name,
    category: summaryCategory,
    domainCapabilities,
    intake,
    enabled: integration.enabled,
    configured: true,
    status: "ready",
    details: [
      ...descriptor.getSummaryDetails(parsed),
      ...(domainCapabilities.includes("issue_tracking") ? [`Polling every ${config.pollingIntervalMs} ms`] : []),
    ],
  };
}
