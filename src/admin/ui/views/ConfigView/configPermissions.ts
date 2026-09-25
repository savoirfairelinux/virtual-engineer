import type { ConfigRoute, ConfigSectionId } from "./configRouting.ts";

export type Can = (permission: string, resourceId?: string, ownerUserId?: string | null) => boolean;
export type HasPermission = (permission: string) => boolean;

export const CONFIG_SECTION_PERMISSIONS: Record<ConfigSectionId, string> = {
  overview: "overview.read",
  integrations: "integration.read",
  oauth: "oauth.read",
  agents: "agent.read",
  projects: "project.read",
  prompts: "prompt.read",
  "runtime-policies": "policy.manage",
  denials: "audit.read",
  "auth-sources": "user.manage",
  users: "user.manage",
  groups: "policy.manage",
  policies: "policy.manage",
  audit: "audit.read",
  system: "system.read",
};

export const CONFIG_PERMISSIONS = [
  ...new Set(Object.values(CONFIG_SECTION_PERMISSIONS).filter((permission) => permission !== "oauth.read")),
];

export function canAccessConfigSection(hasPermission: HasPermission, section: ConfigSectionId): boolean {
  return hasPermission(CONFIG_SECTION_PERMISSIONS[section]);
}

export function canAccessConfigRoute(can: Can, hasPermission: HasPermission, route: ConfigRoute): boolean {
  if (!canAccessConfigSection(hasPermission, route.section)) return false;
  if (route.mode === "list" || route.mode === "detail") return true;
  if (route.section === "audit" && route.mode === "export") return hasPermission("audit.read");
  if (route.section === "projects" && route.mode === "statistics") return hasPermission("project.statistics.read");
  if (route.section === "oauth") return route.mode === "create" ? can("oauth.create") : true;
  if (route.section === "users") return can("user.manage");
  if (route.section === "groups" || route.section === "policies") return can("policy.manage");
  if (route.section === "runtime-policies") return can("policy.manage");

  const resourceType = route.section.slice(0, -1);
  return route.mode === "create" || route.mode === "copy"
    ? can(`${resourceType}.create`)
    : hasPermission(`${resourceType}.write`);
}

export function canViewConfiguration(hasPermission: HasPermission): boolean {
  return CONFIG_PERMISSIONS.some((permission) => hasPermission(permission));
}