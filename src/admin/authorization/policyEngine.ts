import type { Permission, PolicyRule, UserRole } from "../../interfaces.js";

/** Sentinel meaning "every resource of this permission's type". */
export const ALL_RESOURCES = "*" as const;

/** The scope of a granted permission: all resources, or a specific id set. */
export type Scope = typeof ALL_RESOURCES | ReadonlySet<string>;

/**
 * A user's resolved authorization: the union of every rule from the policies
 * bound to the user and to the user's groups. `isSuperuser` short-circuits every
 * check (the `admin` role).
 */
export interface EffectivePermissions {
  isSuperuser: boolean;
  grants: ReadonlyMap<Permission, Scope>;
}

/**
 * Fold a set of policy rules into an {@link EffectivePermissions}. The `admin`
 * role yields a superuser context that bypasses all rule evaluation; every other
 * role is driven entirely by the supplied `rules` (default-deny).
 */
export function buildEffectivePermissions(
  role: UserRole,
  rules: readonly PolicyRule[]
): EffectivePermissions {
  if (role === "admin") {
    return { isSuperuser: true, grants: new Map() };
  }

  const grants = new Map<Permission, Set<string> | typeof ALL_RESOURCES>();
  for (const rule of rules) {
    const existing = grants.get(rule.permission);
    if (existing === ALL_RESOURCES) continue; // already the widest scope
    if (rule.resourceId === null) {
      grants.set(rule.permission, ALL_RESOURCES);
      continue;
    }
    if (existing instanceof Set) {
      existing.add(rule.resourceId);
    } else {
      grants.set(rule.permission, new Set([rule.resourceId]));
    }
  }

  return { isSuperuser: false, grants };
}

/**
 * True when `perms` authorizes `permission` on the given resource.
 *
 * - Superusers are always authorized.
 * - A global (`resourceId` omitted) check requires a `*` grant — a grant scoped
 *   to specific ids does **not** satisfy an unscoped action.
 * - A scoped check (`resourceId` provided) is satisfied by a `*` grant or by a
 *   grant whose id set contains `resourceId`.
 */
export function can(
  perms: EffectivePermissions,
  permission: Permission,
  resourceId?: string | null
): boolean {
  if (perms.isSuperuser) return true;
  const scope = perms.grants.get(permission);
  if (scope === undefined) return false;
  if (scope === ALL_RESOURCES) return true;
  if (resourceId === undefined || resourceId === null) return false;
  return scope.has(resourceId);
}

/**
 * The resource ids a user may exercise `permission` on, for list filtering:
 * `ALL_RESOURCES` (unrestricted), a concrete id set, or `null` (no access).
 */
export function accessibleResourceIds(
  perms: EffectivePermissions,
  permission: Permission
): Scope | null {
  if (perms.isSuperuser) return ALL_RESOURCES;
  const scope = perms.grants.get(permission);
  return scope ?? null;
}
