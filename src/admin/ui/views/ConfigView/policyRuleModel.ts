import type { ApiAgent, ApiIntegration, ApiOAuthApp, ApiPolicyRule, ApiProject, ApiPrompt } from "../../types.ts";

export type ScopedGroupId = "project" | "task" | "integration" | "agent" | "prompt" | "oauth";
export type ResourceKind = "project" | "integration" | "agent" | "prompt" | "oauth";

export interface PolicyAction {
  permission: string;
  label: string;
  /** Global actions never carry a resource id. */
  global?: boolean;
}

export interface PolicyGroupDef {
  id: ScopedGroupId | "global";
  title: string;
  /** Kind of resource selected for the group's scoped actions; null for the global group. */
  resourceKind: ResourceKind | null;
  actions: readonly PolicyAction[];
}

export const POLICY_GROUPS: readonly PolicyGroupDef[] = [
  {
    id: "project", title: "Projects", resourceKind: "project", actions: [
      { permission: "project.read", label: "Read" },
      { permission: "project.write", label: "Edit" },
      { permission: "project.delete", label: "Delete" },
      { permission: "project.operate", label: "Enable / disable" },
      { permission: "project.owner", label: "Manage access" },
      { permission: "project.statistics.read", label: "Statistics" },
      { permission: "project.create", label: "Create", global: true },
    ],
  },
  {
    id: "task", title: "Tasks (by project)", resourceKind: "project", actions: [
      { permission: "task.read", label: "Read" },
      { permission: "task.operate", label: "Operate (pause, resume, retry, abandon)" },
      { permission: "task.delete", label: "Delete" },
    ],
  },
  {
    id: "integration", title: "Integrations", resourceKind: "integration", actions: [
      { permission: "integration.read", label: "Read" },
      { permission: "integration.write", label: "Edit" },
      { permission: "integration.delete", label: "Delete" },
      { permission: "integration.operate", label: "Enable / disable" },
      { permission: "integration.create", label: "Create", global: true },
    ],
  },
  {
    id: "agent", title: "Agents", resourceKind: "agent", actions: [
      { permission: "agent.read", label: "Read" },
      { permission: "agent.write", label: "Edit" },
      { permission: "agent.delete", label: "Delete" },
      { permission: "agent.operate", label: "Enable / disable" },
      { permission: "agent.create", label: "Create", global: true },
    ],
  },
  {
    id: "prompt", title: "Prompts", resourceKind: "prompt", actions: [
      { permission: "prompt.read", label: "Read" },
      { permission: "prompt.write", label: "Edit" },
      { permission: "prompt.delete", label: "Delete" },
      { permission: "prompt.create", label: "Create", global: true },
    ],
  },
  {
    id: "oauth", title: "OAuth apps", resourceKind: "oauth", actions: [
      { permission: "oauth.read", label: "Read" },
      { permission: "oauth.write", label: "Edit" },
      { permission: "oauth.delete", label: "Delete" },
      { permission: "oauth.create", label: "Create", global: true },
      { permission: "oauth.manage", label: "Provider sign-in flows", global: true },
    ],
  },
  {
    id: "global", title: "Global", resourceKind: null, actions: [
      { permission: "overview.read", label: "Overview", global: true },
      { permission: "concurrency.read", label: "Concurrency", global: true },
      { permission: "system.read", label: "Read system settings", global: true },
      { permission: "system.write", label: "Edit system settings", global: true },
      { permission: "user.manage", label: "Manage users", global: true },
      { permission: "audit.read", label: "Audit log", global: true },
      { permission: "policy.manage", label: "Manage groups & policies", global: true },
    ],
  },
];

export const SCOPED_GROUP_IDS: readonly ScopedGroupId[] = ["project", "task", "integration", "agent", "prompt", "oauth"];

const ACTION_BY_PERMISSION = new Map<string, { group: PolicyGroupDef; action: PolicyAction }>(
  POLICY_GROUPS.flatMap((group) => group.actions.map((action) => [action.permission, { group, action }] as const)),
);

export function permissionLabel(permission: string): string {
  const entry = ACTION_BY_PERMISSION.get(permission);
  return entry ? `${entry.group.title} · ${entry.action.label}` : permission;
}

export interface PolicyGroupDraft {
  actions: string[];
  resourceIds: string[];
}

export interface PolicyDraft {
  groups: Record<ScopedGroupId, PolicyGroupDraft>;
  globalPermissions: string[];
  /** Scoped permissions granted on every resource (null id); kept until explicitly removed. */
  legacyGlobalRules: ApiPolicyRule[];
  /** Rules outside the catalog, preserved verbatim. */
  unknownRules: ApiPolicyRule[];
  /** True when some group's stored rules are not a full actions × resources product. */
  nonUniform: boolean;
}

export function emptyDraft(): PolicyDraft {
  const groups = Object.fromEntries(SCOPED_GROUP_IDS.map((id) => [id, { actions: [], resourceIds: [] }])) as unknown as Record<ScopedGroupId, PolicyGroupDraft>;
  return { groups, globalPermissions: [], legacyGlobalRules: [], unknownRules: [], nonUniform: false };
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

export function rulesToDraft(rules: readonly ApiPolicyRule[]): PolicyDraft {
  const draft = emptyDraft();
  const pairs = new Map<ScopedGroupId, Set<string>>();
  for (const rule of rules) {
    const entry = ACTION_BY_PERMISSION.get(rule.permission);
    if (!entry) {
      draft.unknownRules.push({ permission: rule.permission, resourceId: rule.resourceId });
      continue;
    }
    if (entry.action.global) {
      pushUnique(draft.globalPermissions, rule.permission);
      continue;
    }
    if (rule.resourceId === null) {
      draft.legacyGlobalRules.push({ permission: rule.permission, resourceId: null });
      continue;
    }
    const groupId = entry.group.id as ScopedGroupId;
    const group = draft.groups[groupId];
    pushUnique(group.actions, rule.permission);
    pushUnique(group.resourceIds, rule.resourceId);
    const set = pairs.get(groupId) ?? new Set<string>();
    set.add(`${rule.permission}\u0000${rule.resourceId}`);
    pairs.set(groupId, set);
  }
  draft.nonUniform = SCOPED_GROUP_IDS.some((id) => {
    const group = draft.groups[id];
    return (pairs.get(id)?.size ?? 0) !== group.actions.length * group.resourceIds.length;
  });
  return draft;
}

export function draftToRules(draft: PolicyDraft): ApiPolicyRule[] {
  const seen = new Set<string>();
  const out: ApiPolicyRule[] = [];
  const add = (permission: string, resourceId: string | null): void => {
    const key = `${permission}\u0000${resourceId ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ permission, resourceId });
  };
  for (const id of SCOPED_GROUP_IDS) {
    const group = draft.groups[id];
    for (const permission of group.actions) {
      for (const resourceId of group.resourceIds) add(permission, resourceId);
    }
  }
  for (const permission of draft.globalPermissions) add(permission, null);
  for (const rule of draft.legacyGlobalRules) add(rule.permission, null);
  for (const rule of draft.unknownRules) add(rule.permission, rule.resourceId);
  return out;
}

export interface DraftIssues {
  /** Groups with checked actions but no resource: saving would grant nothing. */
  missingResources: ScopedGroupId[];
  /** Groups with resources but no checked action. */
  missingActions: ScopedGroupId[];
}

export function draftIssues(draft: PolicyDraft): DraftIssues {
  return {
    missingResources: SCOPED_GROUP_IDS.filter((id) => draft.groups[id].actions.length > 0 && draft.groups[id].resourceIds.length === 0),
    missingActions: SCOPED_GROUP_IDS.filter((id) => draft.groups[id].resourceIds.length > 0 && draft.groups[id].actions.length === 0),
  };
}

export function formatNameWithId(name: string | null | undefined, id: string): string {
  return name && name !== id ? `${name} (${id})` : id;
}

export interface ResourceOption {
  id: string;
  label: string;
}

export interface PolicyResourceData {
  projects: readonly ApiProject[];
  integrations: readonly ApiIntegration[];
  agents: readonly ApiAgent[];
  prompts: readonly ApiPrompt[];
  oauthApps: readonly ApiOAuthApp[];
}

export function resourceOptions(kind: ResourceKind, data: PolicyResourceData): ResourceOption[] {
  switch (kind) {
    case "project": return data.projects.map((p) => ({ id: p.id, label: formatNameWithId(p.name, p.id) }));
    case "integration": return data.integrations.map((i) => ({ id: i.id, label: formatNameWithId(i.name, i.id) }));
    case "agent": return data.agents.map((a) => ({ id: a.id, label: formatNameWithId(a.name, a.id) }));
    case "prompt": return data.prompts.map((p) => ({ id: p.id, label: formatNameWithId(p.label, p.id) }));
    case "oauth": return data.oauthApps.map((app) => {
      const id = `${app.provider}|${app.baseUrl}`;
      return { id, label: formatNameWithId(`${app.provider} ${app.baseUrl}`, id) };
    });
  }
}

/** Subset of the project detail payload that references other resources. */
export interface LinkedProjectDetail {
  agentId: string | null;
  agentOverrideJson?: string | null | undefined;
  ticketSource?: { integration: { id: string } | null } | null | undefined;
  reviewConfig?: { integration: { id: string } | null } | null | undefined;
  pushTargets?: ReadonlyArray<{ integrationId: string | null }> | undefined;
}

export interface LinkedResources {
  agent: string[];
  integration: string[];
  prompt: string[];
}

const PROMPT_FIELDS = ["systemPromptId", "instructionsPromptId", "feedbackInstructionsPromptId"] as const;

function overridePromptIds(json: string | null | undefined): string[] {
  if (!json) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return []; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const record = parsed as Record<string, unknown>;
  return PROMPT_FIELDS.flatMap((field) => {
    const value = record[field];
    return typeof value === "string" && value.length > 0 ? [value] : [];
  });
}

export function linkedResourcesForProject(
  project: LinkedProjectDetail,
  agents: readonly ApiAgent[],
  prompts: readonly ApiPrompt[],
): LinkedResources {
  const linked: LinkedResources = { agent: [], integration: [], prompt: [] };
  const builtinPrompts = new Set(prompts.filter((p) => p.builtin === true).map((p) => p.id));
  const addPrompt = (id: string | null | undefined): void => {
    if (id && !builtinPrompts.has(id)) pushUnique(linked.prompt, id);
  };
  const addIntegration = (id: string | null | undefined): void => {
    if (id) pushUnique(linked.integration, id);
  };

  const agent = project.agentId ? agents.find((a) => a.id === project.agentId) : undefined;
  if (project.agentId) pushUnique(linked.agent, project.agentId);
  if (agent) {
    addIntegration(agent.integrationId);
    addPrompt(agent.systemPromptId);
    addPrompt(agent.instructionsPromptId);
    addPrompt(agent.feedbackInstructionsPromptId);
  }
  for (const id of overridePromptIds(project.agentOverrideJson)) addPrompt(id);
  addIntegration(project.ticketSource?.integration?.id);
  addIntegration(project.reviewConfig?.integration?.id);
  for (const target of project.pushTargets ?? []) addIntegration(target.integrationId);
  return linked;
}

/** Add linked resources to their groups with Read access; returns the updated draft and newly added ids. */
export function applyLinkedResources(draft: PolicyDraft, linked: LinkedResources): { draft: PolicyDraft; added: LinkedResources } {
  const added: LinkedResources = { agent: [], integration: [], prompt: [] };
  const groups = { ...draft.groups };
  for (const kind of ["agent", "integration", "prompt"] as const) {
    if (linked[kind].length === 0) continue;
    const group = { actions: [...groups[kind].actions], resourceIds: [...groups[kind].resourceIds] };
    for (const id of linked[kind]) {
      if (!group.resourceIds.includes(id)) {
        group.resourceIds.push(id);
        added[kind].push(id);
      }
    }
    pushUnique(group.actions, `${kind}.read`);
    groups[kind] = group;
  }
  return { draft: { ...draft, groups }, added };
}
