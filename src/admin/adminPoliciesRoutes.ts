import { z } from "zod";
import type { Group, Policy, PolicyBinding, PolicyRule, PrincipalType, UserRole } from "../interfaces.js";
import type { PolicyRuleInput } from "../state/stores/policyStore.js";
import { writeJson, readBody, zodErrorBody } from "./adminRouteUtils.js";
import { recordAudit, type AuditCapableStore } from "./adminAudit.js";
import { ALL_PERMISSIONS, PERMISSIONS, isKnownPermission, isScopeablePermission } from "./authorization/permissions.js";
import type { Router } from "./router.js";

/** Minimal user shape the policy routes need for principal validation/display. */
interface PolicyRouteUser {
  id: string;
  username: string;
  role: UserRole;
}

/** Store surface required by the policy/group admin routes (satisfied by SqliteStateStore). */
export interface PolicyRoutesStore {
  // Groups
  createGroup(input: { name: string; description?: string }): Promise<Group>;
  getGroupById(id: string): Promise<Group | null>;
  listGroups(): Promise<Group[]>;
  updateGroup(id: string, partial: { name?: string; description?: string }): Promise<Group | null>;
  deleteGroup(id: string): Promise<boolean>;
  addUserToGroup(groupId: string, userId: string): Promise<void>;
  removeUserFromGroup(groupId: string, userId: string): Promise<boolean>;
  listGroupMemberIds(groupId: string): Promise<string[]>;
  // Policies
  createPolicy(input: { name: string; description?: string; builtin?: boolean }): Promise<Policy>;
  getPolicyById(id: string): Promise<Policy | null>;
  listPolicies(): Promise<Policy[]>;
  updatePolicy(id: string, partial: { name?: string; description?: string }): Promise<Policy | null>;
  deletePolicy(id: string): Promise<boolean>;
  setPolicyRules(policyId: string, rules: readonly PolicyRuleInput[]): Promise<PolicyRule[]>;
  listPolicyRules(policyId: string): Promise<PolicyRule[]>;
  createBinding(input: { policyId: string; principalType: PrincipalType; principalId: string }): Promise<PolicyBinding>;
  deleteBinding(policyId: string, principalType: PrincipalType, principalId: string): Promise<boolean>;
  listBindingsForPolicy(policyId: string): Promise<PolicyBinding[]>;
  // Users (for principal validation + display)
  getUserById(id: string): Promise<PolicyRouteUser | null>;
}

export interface PolicyRoutesDeps {
  policyStore?: PolicyRoutesStore | undefined;
  auditStore?: AuditCapableStore | undefined;
}

const MANAGE = { permission: PERMISSIONS.POLICY_MANAGE } as const;

function isDuplicateError(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as { code?: unknown }).code === "DUPLICATE";
}

function serializeGroup(g: Group): Record<string, unknown> {
  return { id: g.id, name: g.name, description: g.description, createdAt: g.createdAt.toISOString(), updatedAt: g.updatedAt.toISOString() };
}

function serializePolicy(p: Policy): Record<string, unknown> {
  return { id: p.id, name: p.name, description: p.description, builtin: p.builtin, createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString() };
}

function serializeRule(r: PolicyRule): Record<string, unknown> {
  return { id: r.id, permission: r.permission, resourceId: r.resourceId };
}

function serializeBinding(b: PolicyBinding): Record<string, unknown> {
  return { id: b.id, policyId: b.policyId, principalType: b.principalType, principalId: b.principalId };
}

const groupCreateSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(100),
  description: z.string().max(500).optional(),
});
const groupUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
});
const memberSchema = z.object({ userId: z.string().min(1) });

const ruleSchema = z.object({
  permission: z.string().refine(isKnownPermission, "unknown permission"),
  resourceId: z.string().min(1).nullable().optional(),
}).refine(
  (r) => r.resourceId == null || isScopeablePermission(r.permission),
  { message: "resourceId is only allowed on scopeable permissions (project.* / task.*)", path: ["resourceId"] }
);
const policyCreateSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(100),
  description: z.string().max(500).optional(),
  rules: z.array(ruleSchema).optional(),
});
const policyUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
});
const rulesSchema = z.object({ rules: z.array(ruleSchema) });
const bindingSchema = z.object({
  principalType: z.enum(["user", "group"]),
  principalId: z.string().min(1),
});

/** Register group + policy management routes (all require `policy.manage`). */
export function registerPolicyRoutes(router: Router, deps: PolicyRoutesDeps): void {
  // ─── Permission catalog (for UI dropdowns) ────────────────────────────────
  router.add("GET", "/api/admin/permissions", async (_req, res, _params) => {
    writeJson(res, 200, { permissions: ALL_PERMISSIONS });
  }, MANAGE);

  // ─── Groups ───────────────────────────────────────────────────────────────
  router.add("GET", "/api/admin/groups", async (_req, res, _params) => {
    if (!deps.policyStore) { writeJson(res, 501, { error: "Policy store not available" }); return; }
    const groups = await deps.policyStore.listGroups();
    const withCounts = await Promise.all(groups.map(async (g) => ({
      ...serializeGroup(g),
      memberCount: (await deps.policyStore!.listGroupMemberIds(g.id)).length,
    })));
    writeJson(res, 200, { groups: withCounts });
  }, MANAGE);

  router.add("POST", "/api/admin/groups", async (req, res, _params) => {
    if (!deps.policyStore) { writeJson(res, 501, { error: "Policy store not available" }); return; }
    const parsed = groupCreateSchema.safeParse(await readBody(req));
    if (!parsed.success) { writeJson(res, 400, zodErrorBody(parsed.error, "Invalid group payload")); return; }
    try {
      const group = await deps.policyStore.createGroup({
        name: parsed.data.name,
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      });
      recordAudit(deps.auditStore, req, { action: "group.create", targetType: "group", targetId: group.id, details: { name: group.name } });
      writeJson(res, 201, { group: serializeGroup(group) });
    } catch (err) {
      if (isDuplicateError(err)) { writeJson(res, 409, { error: `Group name already exists` }); return; }
      throw err;
    }
  }, MANAGE);

  router.add("GET", "/api/admin/groups/:id", async (_req, res, params) => {
    if (!deps.policyStore) { writeJson(res, 501, { error: "Policy store not available" }); return; }
    const id = params["id"] ?? "";
    const group = await deps.policyStore.getGroupById(id);
    if (!group) { writeJson(res, 404, { error: "Group not found" }); return; }
    const memberIds = await deps.policyStore.listGroupMemberIds(id);
    const members = (await Promise.all(memberIds.map((uid) => deps.policyStore!.getUserById(uid))))
      .filter((u): u is PolicyRouteUser => u !== null)
      .map((u) => ({ id: u.id, username: u.username, role: u.role }));
    writeJson(res, 200, { group: { ...serializeGroup(group), members } });
  }, MANAGE);

  router.add("PUT", "/api/admin/groups/:id", async (req, res, params) => {
    if (!deps.policyStore) { writeJson(res, 501, { error: "Policy store not available" }); return; }
    const id = params["id"] ?? "";
    const parsed = groupUpdateSchema.safeParse(await readBody(req));
    if (!parsed.success) { writeJson(res, 400, zodErrorBody(parsed.error, "Invalid group payload")); return; }
    try {
      const updated = await deps.policyStore.updateGroup(id, {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      });
      if (!updated) { writeJson(res, 404, { error: "Group not found" }); return; }
      recordAudit(deps.auditStore, req, { action: "group.update", targetType: "group", targetId: id, details: { name: updated.name } });
      writeJson(res, 200, { group: serializeGroup(updated) });
    } catch (err) {
      if (isDuplicateError(err)) { writeJson(res, 409, { error: `Group name already exists` }); return; }
      throw err;
    }
  }, MANAGE);

  router.add("DELETE", "/api/admin/groups/:id", async (req, res, params) => {
    if (!deps.policyStore) { writeJson(res, 501, { error: "Policy store not available" }); return; }
    const id = params["id"] ?? "";
    const removed = await deps.policyStore.deleteGroup(id);
    if (!removed) { writeJson(res, 404, { error: "Group not found" }); return; }
    recordAudit(deps.auditStore, req, { action: "group.delete", targetType: "group", targetId: id, details: {} });
    res.statusCode = 204; res.end();
  }, MANAGE);

  router.add("POST", "/api/admin/groups/:id/members", async (req, res, params) => {
    if (!deps.policyStore) { writeJson(res, 501, { error: "Policy store not available" }); return; }
    const id = params["id"] ?? "";
    const group = await deps.policyStore.getGroupById(id);
    if (!group) { writeJson(res, 404, { error: "Group not found" }); return; }
    const parsed = memberSchema.safeParse(await readBody(req));
    if (!parsed.success) { writeJson(res, 400, zodErrorBody(parsed.error, "Invalid member payload")); return; }
    const user = await deps.policyStore.getUserById(parsed.data.userId);
    if (!user) { writeJson(res, 404, { error: "User not found" }); return; }
    await deps.policyStore.addUserToGroup(id, parsed.data.userId);
    recordAudit(deps.auditStore, req, { action: "group.member_add", targetType: "group", targetId: id, details: { userId: parsed.data.userId } });
    writeJson(res, 200, { ok: true });
  }, MANAGE);

  router.add("DELETE", "/api/admin/groups/:id/members/:userId", async (req, res, params) => {
    if (!deps.policyStore) { writeJson(res, 501, { error: "Policy store not available" }); return; }
    const id = params["id"] ?? "";
    const userId = params["userId"] ?? "";
    const removed = await deps.policyStore.removeUserFromGroup(id, userId);
    if (!removed) { writeJson(res, 404, { error: "Membership not found" }); return; }
    recordAudit(deps.auditStore, req, { action: "group.member_remove", targetType: "group", targetId: id, details: { userId } });
    res.statusCode = 204; res.end();
  }, MANAGE);

  // ─── Policies ───────────────────────────────────────────────────────────────
  router.add("GET", "/api/admin/policies", async (_req, res, _params) => {
    if (!deps.policyStore) { writeJson(res, 501, { error: "Policy store not available" }); return; }
    const policies = await deps.policyStore.listPolicies();
    const withCounts = await Promise.all(policies.map(async (p) => ({
      ...serializePolicy(p),
      ruleCount: (await deps.policyStore!.listPolicyRules(p.id)).length,
      bindingCount: (await deps.policyStore!.listBindingsForPolicy(p.id)).length,
    })));
    writeJson(res, 200, { policies: withCounts });
  }, MANAGE);

  router.add("POST", "/api/admin/policies", async (req, res, _params) => {
    if (!deps.policyStore) { writeJson(res, 501, { error: "Policy store not available" }); return; }
    const parsed = policyCreateSchema.safeParse(await readBody(req));
    if (!parsed.success) { writeJson(res, 400, zodErrorBody(parsed.error, "Invalid policy payload")); return; }
    try {
      const policy = await deps.policyStore.createPolicy({ name: parsed.data.name, ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}) });
      if (parsed.data.rules && parsed.data.rules.length > 0) {
        await deps.policyStore.setPolicyRules(policy.id, parsed.data.rules.map((r) => ({ permission: r.permission, resourceId: r.resourceId ?? null })));
      }
      recordAudit(deps.auditStore, req, { action: "policy.create", targetType: "policy", targetId: policy.id, details: { name: policy.name } });
      writeJson(res, 201, { policy: serializePolicy(policy) });
    } catch (err) {
      if (isDuplicateError(err)) { writeJson(res, 409, { error: `Policy name already exists` }); return; }
      throw err;
    }
  }, MANAGE);

  router.add("GET", "/api/admin/policies/:id", async (_req, res, params) => {
    if (!deps.policyStore) { writeJson(res, 501, { error: "Policy store not available" }); return; }
    const id = params["id"] ?? "";
    const policy = await deps.policyStore.getPolicyById(id);
    if (!policy) { writeJson(res, 404, { error: "Policy not found" }); return; }
    const [rules, bindings] = await Promise.all([
      deps.policyStore.listPolicyRules(id),
      deps.policyStore.listBindingsForPolicy(id),
    ]);
    writeJson(res, 200, { policy: { ...serializePolicy(policy), rules: rules.map(serializeRule), bindings: bindings.map(serializeBinding) } });
  }, MANAGE);

  router.add("PUT", "/api/admin/policies/:id", async (req, res, params) => {
    if (!deps.policyStore) { writeJson(res, 501, { error: "Policy store not available" }); return; }
    const id = params["id"] ?? "";
    const existing = await deps.policyStore.getPolicyById(id);
    if (!existing) { writeJson(res, 404, { error: "Policy not found" }); return; }
    if (existing.builtin) { writeJson(res, 409, { error: "Built-in policies cannot be modified" }); return; }
    const parsed = policyUpdateSchema.safeParse(await readBody(req));
    if (!parsed.success) { writeJson(res, 400, zodErrorBody(parsed.error, "Invalid policy payload")); return; }
    try {
      const updated = await deps.policyStore.updatePolicy(id, {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      });
      if (!updated) { writeJson(res, 404, { error: "Policy not found" }); return; }
      recordAudit(deps.auditStore, req, { action: "policy.update", targetType: "policy", targetId: id, details: { name: updated.name } });
      writeJson(res, 200, { policy: serializePolicy(updated) });
    } catch (err) {
      if (isDuplicateError(err)) { writeJson(res, 409, { error: `Policy name already exists` }); return; }
      throw err;
    }
  }, MANAGE);

  router.add("DELETE", "/api/admin/policies/:id", async (req, res, params) => {
    if (!deps.policyStore) { writeJson(res, 501, { error: "Policy store not available" }); return; }
    const id = params["id"] ?? "";
    const existing = await deps.policyStore.getPolicyById(id);
    if (!existing) { writeJson(res, 404, { error: "Policy not found" }); return; }
    if (existing.builtin) { writeJson(res, 409, { error: "Built-in policies cannot be deleted" }); return; }
    await deps.policyStore.deletePolicy(id);
    recordAudit(deps.auditStore, req, { action: "policy.delete", targetType: "policy", targetId: id, details: { name: existing.name } });
    res.statusCode = 204; res.end();
  }, MANAGE);

  router.add("PUT", "/api/admin/policies/:id/rules", async (req, res, params) => {
    if (!deps.policyStore) { writeJson(res, 501, { error: "Policy store not available" }); return; }
    const id = params["id"] ?? "";
    const existing = await deps.policyStore.getPolicyById(id);
    if (!existing) { writeJson(res, 404, { error: "Policy not found" }); return; }
    if (existing.builtin) { writeJson(res, 409, { error: "Built-in policy rules cannot be modified" }); return; }
    const parsed = rulesSchema.safeParse(await readBody(req));
    if (!parsed.success) { writeJson(res, 400, zodErrorBody(parsed.error, "Invalid rules payload")); return; }
    const rules = await deps.policyStore.setPolicyRules(id, parsed.data.rules.map((r) => ({ permission: r.permission, resourceId: r.resourceId ?? null })));
    recordAudit(deps.auditStore, req, { action: "policy.rules_set", targetType: "policy", targetId: id, details: { ruleCount: rules.length } });
    writeJson(res, 200, { rules: rules.map(serializeRule) });
  }, MANAGE);

  router.add("POST", "/api/admin/policies/:id/bindings", async (req, res, params) => {
    if (!deps.policyStore) { writeJson(res, 501, { error: "Policy store not available" }); return; }
    const id = params["id"] ?? "";
    const policy = await deps.policyStore.getPolicyById(id);
    if (!policy) { writeJson(res, 404, { error: "Policy not found" }); return; }
    const parsed = bindingSchema.safeParse(await readBody(req));
    if (!parsed.success) { writeJson(res, 400, zodErrorBody(parsed.error, "Invalid binding payload")); return; }
    const { principalType, principalId } = parsed.data;
    const principalExists = principalType === "user"
      ? (await deps.policyStore.getUserById(principalId)) !== null
      : (await deps.policyStore.getGroupById(principalId)) !== null;
    if (!principalExists) { writeJson(res, 404, { error: `${principalType} not found` }); return; }
    try {
      const binding = await deps.policyStore.createBinding({ policyId: id, principalType, principalId });
      recordAudit(deps.auditStore, req, { action: "policy.binding_add", targetType: "policy", targetId: id, details: { principalType, principalId } });
      writeJson(res, 201, { binding: serializeBinding(binding) });
    } catch (err) {
      if (isDuplicateError(err)) { writeJson(res, 409, { error: "Policy is already bound to this principal" }); return; }
      throw err;
    }
  }, MANAGE);

  router.add("DELETE", "/api/admin/policies/:id/bindings/:principalType/:principalId", async (req, res, params) => {
    if (!deps.policyStore) { writeJson(res, 501, { error: "Policy store not available" }); return; }
    const id = params["id"] ?? "";
    const principalType = params["principalType"] ?? "";
    const principalId = params["principalId"] ?? "";
    if (principalType !== "user" && principalType !== "group") { writeJson(res, 400, { error: "principalType must be user or group" }); return; }
    const removed = await deps.policyStore.deleteBinding(id, principalType, principalId);
    if (!removed) { writeJson(res, 404, { error: "Binding not found" }); return; }
    recordAudit(deps.auditStore, req, { action: "policy.binding_remove", targetType: "policy", targetId: id, details: { principalType, principalId } });
    res.statusCode = 204; res.end();
  }, MANAGE);
}
