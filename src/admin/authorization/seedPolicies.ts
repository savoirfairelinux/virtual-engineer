import { getLogger } from "../../logger.js";
import type { AdminUser, Group, Policy, PolicyBinding, PolicyRule, PrincipalType, UserRole } from "../../interfaces.js";
import type { PolicyRuleInput } from "../../state/stores/policyStore.js";
import { PERMISSIONS } from "./permissions.js";

const log = getLogger("pbac-seed");

/**
 * Built-in policy that reproduces the legacy `operator` role: full read/write on
 * every non-administrative resource type. Excludes user, audit, and policy
 * management (those stay `admin`-only).
 */
const OPERATOR_RULES: PolicyRuleInput[] = [
  { permission: PERMISSIONS.PROJECT_READ },
  { permission: PERMISSIONS.PROJECT_WRITE },
  { permission: PERMISSIONS.PROJECT_DELETE },
  { permission: PERMISSIONS.PROJECT_OPERATE },
  { permission: PERMISSIONS.TASK_READ },
  { permission: PERMISSIONS.TASK_OPERATE },
  { permission: PERMISSIONS.TASK_DELETE },
  { permission: PERMISSIONS.INTEGRATION_READ },
  { permission: PERMISSIONS.INTEGRATION_WRITE },
  { permission: PERMISSIONS.INTEGRATION_DELETE },
  { permission: PERMISSIONS.INTEGRATION_OPERATE },
  { permission: PERMISSIONS.AGENT_READ },
  { permission: PERMISSIONS.AGENT_WRITE },
  { permission: PERMISSIONS.AGENT_DELETE },
  { permission: PERMISSIONS.AGENT_OPERATE },
  { permission: PERMISSIONS.PROMPT_READ },
  { permission: PERMISSIONS.PROMPT_WRITE },
  { permission: PERMISSIONS.PROMPT_DELETE },
  { permission: PERMISSIONS.OAUTH_MANAGE },
  { permission: PERMISSIONS.OVERVIEW_READ },
  { permission: PERMISSIONS.CONCURRENCY_READ },
  { permission: PERMISSIONS.SYSTEM_READ },
  { permission: PERMISSIONS.SYSTEM_WRITE },
];

/**
 * Built-in policy that reproduces the legacy `viewer` role: read-only access to
 * the overview, tasks, projects, and runtime status.
 */
const VIEWER_RULES: PolicyRuleInput[] = [
  { permission: PERMISSIONS.OVERVIEW_READ },
  { permission: PERMISSIONS.CONCURRENCY_READ },
  { permission: PERMISSIONS.SYSTEM_READ },
  { permission: PERMISSIONS.PROJECT_READ },
  { permission: PERMISSIONS.TASK_READ },
];

/** Names of the seeded built-in policies. Stable identifiers referenced by the migration. */
export const BUILTIN_POLICY_OPERATOR = "Operator";
export const BUILTIN_POLICY_VIEWER = "Viewer";

const BUILTIN_POLICIES: ReadonlyArray<{ name: string; description: string; rules: PolicyRuleInput[] }> = [
  {
    name: BUILTIN_POLICY_OPERATOR,
    description: "Full read/write on projects, tasks, integrations, agents and prompts (no user/audit/policy administration).",
    rules: OPERATOR_RULES,
  },
  {
    name: BUILTIN_POLICY_VIEWER,
    description: "Read-only access to the overview, tasks, projects and runtime status.",
    rules: VIEWER_RULES,
  },
];

/** Store surface the policy seeder needs (satisfied by SqliteStateStore). */
export interface PolicySeedStore {
  listPolicies(): Promise<Policy[]>;
  createPolicy(input: { name: string; description?: string; builtin?: boolean }): Promise<Policy>;
  setPolicyRules(policyId: string, rules: readonly PolicyRuleInput[]): Promise<PolicyRule[]>;
  listUsers(): Promise<AdminUser[]>;
  listBindingsForPrincipal(principalType: PrincipalType, principalId: string): Promise<PolicyBinding[]>;
  listGroupsForUser(userId: string): Promise<Group[]>;
  createBinding(input: { policyId: string; principalType: PrincipalType; principalId: string }): Promise<PolicyBinding>;
}

/**
 * Ensure the built-in policies exist with up-to-date rules, then perform a
 * one-time migration binding existing `operator`/`viewer` users to their
 * matching built-in policy. The migration only touches users that have **no**
 * policy bindings and **no** group memberships, so it never overrides an admin's
 * later access-control changes.
 */
export async function seedBuiltInPolicies(store: PolicySeedStore): Promise<void> {
  const existing = await store.listPolicies();
  const byName = new Map(existing.map((p) => [p.name, p]));

  const policyIdByName = new Map<string, string>();
  for (const spec of BUILTIN_POLICIES) {
    let policy = byName.get(spec.name);
    if (!policy) {
      policy = await store.createPolicy({ name: spec.name, description: spec.description, builtin: true });
    }
    await store.setPolicyRules(policy.id, spec.rules);
    policyIdByName.set(spec.name, policy.id);
  }

  const roleToPolicyName: Partial<Record<UserRole, string>> = {
    operator: BUILTIN_POLICY_OPERATOR,
    viewer: BUILTIN_POLICY_VIEWER,
  };

  const users = await store.listUsers();
  for (const user of users) {
    const policyName = roleToPolicyName[user.role];
    if (!policyName) continue; // admins bypass PBAC; unknown roles skipped
    const policyId = policyIdByName.get(policyName);
    if (!policyId) continue;

    const [bindings, groups] = await Promise.all([
      store.listBindingsForPrincipal("user", user.id),
      store.listGroupsForUser(user.id),
    ]);
    if (bindings.length > 0 || groups.length > 0) continue; // already managed under PBAC

    try {
      await store.createBinding({ policyId, principalType: "user", principalId: user.id });
      log.info({ userId: user.id, role: user.role, policy: policyName }, "bound legacy user to built-in policy");
    } catch (err) {
      // Idempotent for an already-existing binding; surface anything else.
      if (!(err instanceof Error && (err as { code?: unknown }).code === "DUPLICATE")) {
        log.warn({ err, userId: user.id }, "failed to bind legacy user to built-in policy");
      }
    }
  }
}

/** Store surface needed to bind a user's role-default policy. */
export interface DefaultPolicyBinderStore {
  listPolicies(): Promise<Policy[]>;
  createBinding(input: { policyId: string; principalType: PrincipalType; principalId: string }): Promise<PolicyBinding>;
}

/**
 * Bind a newly created user to the built-in policy matching their role, so the
 * `role` chosen at creation acts as a sensible default access bundle. Admins are
 * superusers and receive no binding. Idempotent and best-effort — a missing
 * built-in policy or an existing binding is silently ignored.
 */
export async function bindDefaultPolicyForRole(
  store: DefaultPolicyBinderStore,
  userId: string,
  role: UserRole
): Promise<void> {
  const roleToPolicyName: Partial<Record<UserRole, string>> = {
    operator: BUILTIN_POLICY_OPERATOR,
    viewer: BUILTIN_POLICY_VIEWER,
  };
  const policyName = roleToPolicyName[role];
  if (!policyName) return; // admin (superuser) or unknown role

  const policies = await store.listPolicies();
  const policy = policies.find((p) => p.name === policyName);
  if (!policy) return;

  try {
    await store.createBinding({ policyId: policy.id, principalType: "user", principalId: userId });
  } catch (err) {
    // Idempotent for an already-existing binding; surface anything else.
    if (!(err instanceof Error && (err as { code?: unknown }).code === "DUPLICATE")) {
      log.warn({ err, userId }, "failed to bind default policy for role");
    }
  }
}
