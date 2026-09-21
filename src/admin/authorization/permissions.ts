import type { Permission, ResourceType } from "../../interfaces.js";

/**
 * The authoritative catalog of admin permissions. Each entry is a
 * `"<resourceType>.<action>"` string (with optional sub-resource segments)
 * consumed by the policy engine and declared as route metadata. Grant-only:
 * possessing a permission authorizes the action;
 * the absence of a grant denies it (default-deny).
 *
 * Scopeable resource types accept
 * a concrete `resourceId` in a policy rule; a null `resourceId` grants the action
 * on every resource of that type. `task.*` permissions are evaluated against the
 * id of the task's owning **project** (tasks inherit their project's scope).
 * System capabilities remain global and must use a null `resourceId`.
 */
export const PERMISSIONS = {
  // Projects (scopeable) — and the tasks they own.
  PROJECT_CREATE: "project.create",
  PROJECT_READ: "project.read",
  PROJECT_STATISTICS_READ: "project.statistics.read",
  PROJECT_WRITE: "project.write",
  PROJECT_DELETE: "project.delete",
  PROJECT_OPERATE: "project.operate",
  PROJECT_OWNER: "project.owner",
  TASK_READ: "task.read",
  TASK_OPERATE: "task.operate",
  TASK_DELETE: "task.delete",
  // Integrations (scopeable).
  INTEGRATION_CREATE: "integration.create",
  INTEGRATION_READ: "integration.read",
  INTEGRATION_WRITE: "integration.write",
  INTEGRATION_DELETE: "integration.delete",
  INTEGRATION_OPERATE: "integration.operate",
  // Agents (scopeable).
  AGENT_CREATE: "agent.create",
  AGENT_READ: "agent.read",
  AGENT_WRITE: "agent.write",
  AGENT_DELETE: "agent.delete",
  AGENT_OPERATE: "agent.operate",
  // Prompts (scopeable).
  PROMPT_CREATE: "prompt.create",
  PROMPT_READ: "prompt.read",
  PROMPT_WRITE: "prompt.write",
  PROMPT_DELETE: "prompt.delete",
  // Global capabilities.
  OAUTH_CREATE: "oauth.create",
  OAUTH_READ: "oauth.read",
  OAUTH_WRITE: "oauth.write",
  OAUTH_DELETE: "oauth.delete",
  OAUTH_MANAGE: "oauth.manage",
  OVERVIEW_READ: "overview.read",
  CONCURRENCY_READ: "concurrency.read",
  SYSTEM_READ: "system.read",
  SYSTEM_WRITE: "system.write",
  USER_MANAGE: "user.manage",
  AUDIT_READ: "audit.read",
  POLICY_MANAGE: "policy.manage",
} as const;

/** Union of every valid permission string in {@link PERMISSIONS}. */
export type KnownPermission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** Immutable set of all valid permission strings, for validation. */
export const ALL_PERMISSIONS: readonly Permission[] = Object.freeze(
  Object.values(PERMISSIONS)
);

const ALL_PERMISSIONS_SET: ReadonlySet<Permission> = new Set(ALL_PERMISSIONS);

/**
 * Resource types whose rules may carry a concrete (non-null) `resourceId`.
 *
 * Projects, integrations, agents, prompts and OAuth apps are owned resources.
 * Tasks use their owning project id as their resource scope. Creation remains
 * global because no concrete resource exists before a create route runs.
 */
export const SCOPEABLE_RESOURCE_TYPES: ReadonlySet<ResourceType> = new Set<ResourceType>([
  "project",
  "task",
  "integration",
  "agent",
  "prompt",
  "oauth",
]);

/** True when `value` is a permission string present in the catalog. */
export function isKnownPermission(value: string): value is KnownPermission {
  return ALL_PERMISSIONS_SET.has(value);
}

/**
 * The resource type a permission targets — the segment before the first dot
 * (e.g. `"project.read"` → `"project"`). Returns null for malformed strings.
 */
export function resourceTypeOf(permission: Permission): ResourceType | null {
  const dot = permission.indexOf(".");
  if (dot <= 0) return null;
  return permission.slice(0, dot) as ResourceType;
}

/** True when a permission's resource type may be scoped to a concrete resource id. */
export function isScopeablePermission(permission: Permission): boolean {
  if (permission.endsWith(".create")) return false;
  if (permission === PERMISSIONS.OAUTH_MANAGE) return false;
  const type = resourceTypeOf(permission);
  return type !== null && SCOPEABLE_RESOURCE_TYPES.has(type);
}
