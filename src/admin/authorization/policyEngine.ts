import { SYSTEM_PRINCIPALS } from "../../domain/accessControl.js";
import type {
  EffectivePolicyRule,
  Permission,
  PolicyRule,
  ResourceType,
  UserRole,
} from "../../interfaces.js";
import { isScopeablePermission } from "./permissions.js";

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
  resourceOwnerGrants: ReadonlySet<Permission>;
  projectOwnerGrants: ReadonlySet<Permission>;
  registeredUserGrants: ReadonlySet<Permission>;
}

export interface ResourceDescriptor {
  type: ResourceType;
  id: string;
  /** `undefined` means ownership could not be resolved and must fail closed. */
  ownerUserId: string | null | undefined;
  projectId?: string | null;
}

function isEffectivePolicyRule(rule: PolicyRule): rule is EffectivePolicyRule {
  return "principalType" in rule && "principalId" in rule;
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
    return {
      isSuperuser: true,
      grants: new Map(),
      resourceOwnerGrants: new Set(),
      projectOwnerGrants: new Set(),
      registeredUserGrants: new Set(),
    };
  }

  const grants = new Map<Permission, Set<string> | typeof ALL_RESOURCES>();
  const resourceOwnerGrants = new Set<Permission>();
  const projectOwnerGrants = new Set<Permission>();
  const registeredUserGrants = new Set<Permission>();
  for (const rule of rules) {
    if (isEffectivePolicyRule(rule) && rule.principalType === "system") {
      if (rule.principalId === SYSTEM_PRINCIPALS.RESOURCE_OWNER) {
        resourceOwnerGrants.add(rule.permission);
        continue;
      }
      if (rule.principalId === SYSTEM_PRINCIPALS.PROJECT_OWNERS) {
        projectOwnerGrants.add(rule.permission);
        continue;
      }
      if (
        rule.principalId === SYSTEM_PRINCIPALS.REGISTERED_USERS &&
        isScopeablePermission(rule.permission)
      ) {
        registeredUserGrants.add(rule.permission);
        continue;
      }
    }

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

  return {
    isSuperuser: false,
    grants,
    resourceOwnerGrants,
    projectOwnerGrants,
    registeredUserGrants,
  };
}

/** True when a user can exercise a permission on a concrete resource. */
export function canAccessResource(
  perms: EffectivePermissions,
  permission: Permission,
  resource: ResourceDescriptor,
  actorUserId: string | null
): boolean {
  if (can(perms, permission, resource.type === "task" ? resource.projectId : resource.id)) {
    return true;
  }
  if (actorUserId === null) return false;
  if (
    resource.ownerUserId === null &&
    (resource.type !== "task" || resource.projectId != null) &&
    perms.registeredUserGrants.has(permission)
  ) return true;
  if (resource.ownerUserId === actorUserId && perms.resourceOwnerGrants.has(permission)) return true;

  const projectId = resource.type === "project"
    ? resource.id
    : resource.type === "task"
      ? resource.projectId
      : null;
  return projectId != null &&
    perms.projectOwnerGrants.has(permission) &&
    can(perms, "project.owner", projectId);
}

/** True when collection access may be granted by static or dynamic resource rules. */
export function hasPotentialResourceAccess(
  perms: EffectivePermissions,
  permission: Permission
): boolean {
  return perms.isSuperuser ||
    perms.grants.has(permission) ||
    perms.resourceOwnerGrants.has(permission) ||
    perms.projectOwnerGrants.has(permission) ||
    perms.registeredUserGrants.has(permission);
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

/** JSON-serializable projection of a user's effective permissions (for `/auth/me`). */
export interface SerializedPermissions {
  superuser: boolean;
  /** permission → `"*"` (all resources) or a sorted array of scoped resource ids. */
  grants: Record<Permission, "*" | string[]>;
  resourceOwnerGrants: Permission[];
  projectOwnerGrants: Permission[];
  registeredUserGrants: Permission[];
}

/** Project effective permissions to a JSON-friendly shape for the client. */
export function serializeEffectivePermissions(perms: EffectivePermissions): SerializedPermissions {
  const grants: Record<Permission, "*" | string[]> = {};
  for (const [permission, scope] of perms.grants) {
    grants[permission] = scope === ALL_RESOURCES ? "*" : [...scope].sort();
  }
  return {
    superuser: perms.isSuperuser,
    grants,
    resourceOwnerGrants: [...perms.resourceOwnerGrants].sort(),
    projectOwnerGrants: [...perms.projectOwnerGrants].sort(),
    registeredUserGrants: [...perms.registeredUserGrants].sort(),
  };
}
