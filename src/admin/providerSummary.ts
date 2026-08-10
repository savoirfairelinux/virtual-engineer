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

  for (const integration of activeIntegrations) {
    if (summaries.some((s) => s.id === integration.id)) continue;
    summaries.push(buildAdminProviderSummaryForIntegration(integration, config));
  }

  return summaries;
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
