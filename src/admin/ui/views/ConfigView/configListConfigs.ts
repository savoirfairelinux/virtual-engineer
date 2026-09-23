import { promptLabel } from "./promptLabel.ts";
import type { ListConfig, ListFilterDefinition, ListOption } from "./listFilters.ts";
import type {
  ApiAgent,
  ApiGroup,
  ApiIntegration,
  ApiPlugin,
  ApiPolicy,
  ApiProject,
  ApiPrompt,
  ApiUser,
  DomainCapability,
} from "../../types.ts";

const NONE_VALUE = "none";

const DOMAIN_CAPABILITY_LABELS: Record<DomainCapability, string> = {
  issue_tracking: "Tickets",
  code_review: "Review",
  source_control: "VCS",
  agent_execution: "Agent",
};

function statusFilter<T extends { enabled: boolean }>(): ListFilterDefinition<T> {
  return {
    id: "status",
    label: "Status",
    allLabel: "Any status",
    options: [{ value: "enabled", label: "Enabled" }, { value: "disabled", label: "Disabled" }],
    value: (item) => (item.enabled ? "enabled" : "disabled"),
  };
}

function workflowTypeFilter<T extends { type: "coding" | "review" }>(): ListFilterDefinition<T> {
  return {
    id: "type",
    label: "Type",
    allLabel: "All types",
    options: [{ value: "coding", label: "Coding" }, { value: "review", label: "Review" }],
    value: (item) => item.type,
  };
}

function sortedOptions(entries: Iterable<[string, string]>): ListOption[] {
  return [...new Map(entries)]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}

function providerLabeler(plugins: readonly ApiPlugin[]): (provider: string) => string {
  const names = new Map(plugins.map((plugin) => [plugin.provider, plugin.name]));
  return (provider) => names.get(provider) ?? provider;
}

export function integrationListConfig(items: readonly ApiIntegration[], plugins: readonly ApiPlugin[]): ListConfig<ApiIntegration> {
  const providerLabel = providerLabeler(plugins);
  const capabilities = new Set(items.flatMap((item) => item.domainCapabilities));
  return {
    search: (item) => [item.name, item.provider, providerLabel(item.provider), item.id],
    name: (item) => item.name,
    updatedAt: (item) => item.updatedAt,
    createdAt: (item) => item.createdAt,
    filters: [
      {
        id: "provider",
        label: "Provider",
        allLabel: "All providers",
        options: sortedOptions(items.map((item) => [item.provider, providerLabel(item.provider)])),
        value: (item) => item.provider,
      },
      {
        id: "capability",
        label: "Capability",
        allLabel: "All capabilities",
        options: (Object.keys(DOMAIN_CAPABILITY_LABELS) as DomainCapability[])
          .filter((capability) => capabilities.has(capability))
          .map((capability) => ({ value: capability, label: DOMAIN_CAPABILITY_LABELS[capability] })),
        value: (item) => item.domainCapabilities,
      },
      statusFilter(),
    ],
  };
}

export function agentListConfig(
  items: readonly ApiAgent[],
  integrations: readonly ApiIntegration[],
  plugins: readonly ApiPlugin[],
): ListConfig<ApiAgent> {
  const providerLabel = providerLabeler(plugins);
  const providerByIntegration = new Map(integrations.map((integration) => [integration.id, integration.provider]));
  const engine = (item: ApiAgent) => (item.integrationId ? providerByIntegration.get(item.integrationId) : undefined) ?? NONE_VALUE;
  const engines = items.map(engine);
  return {
    search: (item) => {
      const provider = engine(item);
      return [item.name, item.model, item.id, ...(provider === NONE_VALUE ? [] : [provider, providerLabel(provider)])];
    },
    name: (item) => item.name,
    updatedAt: (item) => item.updatedAt,
    createdAt: (item) => item.createdAt,
    filters: [
      workflowTypeFilter(),
      {
        id: "engine",
        label: "Engine",
        allLabel: "All engines",
        options: [
          ...sortedOptions(engines.filter((value) => value !== NONE_VALUE).map((value) => [value, providerLabel(value)])),
          ...(engines.includes(NONE_VALUE) ? [{ value: NONE_VALUE, label: "Unassigned" }] : []),
        ],
        value: engine,
      },
      statusFilter(),
    ],
  };
}

export function projectListConfig(items: readonly ApiProject[], agents: readonly ApiAgent[]): ListConfig<ApiProject> {
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));
  const agentValue = (item: ApiProject) => item.agentId ?? NONE_VALUE;
  return {
    search: (item) => [item.name, item.id, item.agentId ? agentNames.get(item.agentId) : undefined],
    name: (item) => item.name,
    updatedAt: (item) => item.updatedAt,
    createdAt: (item) => item.createdAt,
    filters: [
      workflowTypeFilter(),
      {
        id: "agent",
        label: "Agent",
        allLabel: "All agents",
        options: [
          ...sortedOptions(items.flatMap((item) => item.agentId ? [[item.agentId, agentNames.get(item.agentId) ?? item.agentId.slice(0, 12)] as [string, string]] : [])),
          ...(items.some((item) => !item.agentId) ? [{ value: NONE_VALUE, label: "No agent" }] : []),
        ],
        value: agentValue,
      },
      statusFilter(),
    ],
  };
}

export function promptListConfig(items: readonly ApiPrompt[]): ListConfig<ApiPrompt> {
  return {
    search: (item) => [promptLabel(item, items), item.id, item.content],
    name: (item) => promptLabel(item, items),
    updatedAt: (item) => item.updatedAt,
    filters: [
      {
        id: "type",
        label: "Type",
        allLabel: "All prompts",
        options: [{ value: "system", label: "System Prompt" }, { value: "instructions", label: "Instructions Prompt" }],
        value: (item) => item.promptType,
      },
      {
        id: "origin",
        label: "Origin",
        allLabel: "Any origin",
        options: [{ value: "builtin", label: "Built-in" }, { value: "custom", label: "Custom" }],
        value: (item) => (item.builtin ? "builtin" : "custom"),
      },
      {
        id: "usage",
        label: "Usage",
        allLabel: "Any usage",
        options: [{ value: "used", label: "Used by agents" }, { value: "unused", label: "Unused" }],
        value: (item) => ((item.usedByCount ?? 0) > 0 ? "used" : "unused"),
      },
    ],
  };
}

export function userListConfig(): ListConfig<ApiUser> {
  return {
    search: (item) => [item.username, item.id],
    name: (item) => item.username,
    updatedAt: (item) => item.updatedAt,
    createdAt: (item) => item.createdAt,
    filters: [
      {
        id: "role",
        label: "Role",
        allLabel: "All roles",
        options: [{ value: "admin", label: "Admin" }, { value: "operator", label: "Operator" }, { value: "viewer", label: "Viewer" }],
        value: (item) => item.role,
      },
      statusFilter(),
    ],
  };
}

export function groupListConfig(): ListConfig<ApiGroup> {
  return {
    search: (item) => [item.name, item.description, item.id],
    name: (item) => item.name,
    updatedAt: (item) => item.updatedAt,
    createdAt: (item) => item.createdAt,
    filters: [
      {
        id: "members",
        label: "Members",
        allLabel: "Any members",
        options: [{ value: "has", label: "Has members" }, { value: "empty", label: "Empty" }],
        value: (item) => ((item.memberCount ?? 0) > 0 ? "has" : "empty"),
      },
    ],
  };
}

export function policyListConfig(): ListConfig<ApiPolicy> {
  return {
    search: (item) => [item.name, item.description, item.id],
    name: (item) => item.name,
    updatedAt: (item) => item.updatedAt,
    createdAt: (item) => item.createdAt,
    filters: [
      {
        id: "origin",
        label: "Origin",
        allLabel: "Any origin",
        options: [{ value: "builtin", label: "Built-in" }, { value: "custom", label: "Custom" }],
        value: (item) => (item.builtin ? "builtin" : "custom"),
      },
      {
        id: "assignment",
        label: "Assignment",
        allLabel: "Any assignment",
        options: [{ value: "assigned", label: "Assigned" }, { value: "unassigned", label: "Unassigned" }],
        value: (item) => ((item.bindingCount ?? 0) > 0 ? "assigned" : "unassigned"),
      },
    ],
  };
}
