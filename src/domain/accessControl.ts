export const SYSTEM_PRINCIPALS = {
  REGISTERED_USERS: "registered_users",
  RESOURCE_OWNER: "resource_owner",
  PROJECT_OWNERS: "project_owners",
} as const;

export const SYSTEM_POLICY_BINDINGS = {
  "Registered Users": SYSTEM_PRINCIPALS.REGISTERED_USERS,
  "Resource Owner": SYSTEM_PRINCIPALS.RESOURCE_OWNER,
  "Project Owners": SYSTEM_PRINCIPALS.PROJECT_OWNERS,
} as const;

export type SystemPrincipalId = (typeof SYSTEM_PRINCIPALS)[keyof typeof SYSTEM_PRINCIPALS];

const SYSTEM_PRINCIPAL_IDS: ReadonlySet<string> = new Set(Object.values(SYSTEM_PRINCIPALS));

export function isSystemPrincipalId(value: string): value is SystemPrincipalId {
  return SYSTEM_PRINCIPAL_IDS.has(value);
}

export function systemPrincipalForPolicyName(name: string): SystemPrincipalId | undefined {
  return SYSTEM_POLICY_BINDINGS[name as keyof typeof SYSTEM_POLICY_BINDINGS];
}

export function oauthAppResourceId(provider: string, baseUrl: string): string {
  return `${provider}|${baseUrl}`;
}

export function parseOAuthAppResourceId(
  resourceId: string
): { provider: string; baseUrl: string } | null {
  const separator = resourceId.indexOf("|");
  if (separator <= 0 || separator === resourceId.length - 1) return null;
  return {
    provider: resourceId.slice(0, separator),
    baseUrl: resourceId.slice(separator + 1),
  };
}