import type { ConfigRoute, ConfigSectionId } from "./configRouting.ts";

export type Can = (permission: string, resourceId?: string) => boolean;
export type HasPermission = (permission: string) => boolean;

export const CONFIG_SECTION_PERMISSIONS: Record<ConfigSectionId, string> = {
  overview: "overview.read",
  integrations: "integration.read",
  oauth: "oauth.manage",
  agents: "agent.read",
  projects: "project.read",
  prompts: "prompt.read",
  "runtime-policies": "policy.manage",
  denials: "audit.read",
  users: "user.manage",
  groups: "policy.manage",
  policies: "policy.manage",
  audit: "audit.read",
  system: "system.read",
};

export const CONFIG_PERMISSIONS = [...new Set(Object.values(CONFIG_SECTION_PERMISSIONS))];

export function canAccessConfigSection(hasPermission: HasPermission, section: ConfigSectionId): boolean {
  return hasPermission(CONFIG_SECTION_PERMISSIONS[section]);
}

export function canAccessConfigRoute(can: Can, hasPermission: HasPermission, route: ConfigRoute): boolean {
  if (!canAccessConfigSection(hasPermission, route.section)) return false;
  if (route.mode === "list" || route.mode === "detail") return true;
  if (route.section === "oauth") return can("oauth.manage");
  if (route.section === "users") return can("user.manage");
  if (route.section === "groups" || route.section === "policies") return can("policy.manage");
  if (route.section === "runtime-policies") return can("policy.manage");

  const permission = `${route.section.slice(0, -1)}.write`;
  return route.mode === "edit" && route.section === "projects"
    ? can(permission, route.id)
    : can(permission);
}

export function canViewConfiguration(hasPermission: HasPermission): boolean {
  return CONFIG_PERMISSIONS.some((permission) => hasPermission(permission));
}