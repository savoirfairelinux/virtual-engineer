import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Router } from "./router.js";
import { readBody, requireStore, toIsoTimestamp, writeJson, zodErrorBody } from "./adminRouteUtils.js";
import { recordAudit, type AuditCapableStore } from "./adminAudit.js";
import type { AdminUser, Group } from "../interfaces.js";
import type { AuthSourceRecord, AuthSourceStoreApi } from "../state/stores/authSourceStore.js";
import type { UserIdentityStoreApi } from "../state/stores/userIdentityStore.js";
import type { AuthSourceGroupMapping, DirectoryGroupStoreApi } from "../state/stores/directoryGroupStore.js";
import { parseLdapConfigInput, publicLdapConfig, serializeLdapConfig, type LdapConfig } from "./authentication/ldapConfig.js";
import { normalizeLdapDn, testLdapConnection } from "./authentication/ldapDirectory.js";
import { normalizeUsername } from "./authentication/username.js";
import type { DirectoryAccountResolver } from "./authentication/directoryAuthenticator.js";
import { PERMISSIONS } from "./authorization/permissions.js";
import { StoredCredentialDecryptionError } from "../utils/encryption.js";

const MISSING_SECRET_ERROR = "ADMIN_AUTH_SECRET is required to encrypt credentials.";

const sourceFieldsSchema = z.object({
  name: z.string().trim().min(1, "is required").max(100),
  kind: z.literal("ldap"),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(10_000).optional(),
  autoProvision: z.boolean().optional(),
  defaultRole: z.enum(["viewer", "operator"]).optional(),
  sessionMaxAgeHours: z.number().int().min(1).max(720).optional(),
  revalidateIntervalMinutes: z.number().int().min(0).max(1440).optional(),
  config: z.record(z.string(), z.unknown()),
});
const updateSchema = sourceFieldsSchema.omit({ kind: true }).partial();
const testSchema = z.object({ id: z.string().min(1).optional(), kind: z.literal("ldap"), config: z.record(z.string(), z.unknown()) });
const mappingSchema = z.object({
  externalGroup: z.string().trim().min(1, "is required").max(1024).refine((value) => value.includes("="), "must be a group DN"),
  groupId: z.string().min(1, "is required"),
});
const lookupSchema = z.object({ username: z.string().trim().min(1, "is required").max(256) });

export interface AuthSourceRouteDeps {
  authSourceStore?: AuthSourceStoreApi | undefined;
  identityStore?: (Pick<UserIdentityStoreApi, "countUserIdentitiesForSource" | "getUserIdentityBySubject" | "deleteSessionsForAuthSource"> & {
    getUserById(id: string): Promise<AdminUser | null>;
    getUserByUsername(username: string): Promise<AdminUser | null>;
  }) | undefined;
  directoryGroupStore?: (Pick<DirectoryGroupStoreApi, "listGroupMappings" | "createGroupMapping" | "deleteGroupMapping" | "listMappedGroupIds"> & {
    getGroupById(id: string): Promise<Group | null>;
  }) | undefined;
  directoryAccounts?: DirectoryAccountResolver | undefined;
  auditStore?: AuditCapableStore | undefined;
  adminAuthSecret?: string | undefined;
}

export function serializeAuthSource(record: AuthSourceRecord): Record<string, unknown> {
  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    enabled: record.enabled,
    priority: record.priority,
    autoProvision: record.autoProvision,
    defaultRole: record.defaultRole,
    sessionMaxAgeHours: record.sessionMaxAgeHours,
    revalidateIntervalMinutes: record.revalidateIntervalMinutes,
    config: publicLdapConfig(record.configJson),
    createdAt: toIsoTimestamp(record.createdAt),
    updatedAt: toIsoTimestamp(record.updatedAt),
  };
}

function isDuplicateError(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as { code?: unknown }).code === "DUPLICATE";
}

/** Validate a config payload; writes the 400 response and returns null on failure. */
function resolveConfig(
  res: ServerResponse,
  input: unknown,
  storedConfigJson: string | null,
  adminAuthSecret: string | undefined
): LdapConfig | null {
  try {
    const parsed = parseLdapConfigInput(input, storedConfigJson, adminAuthSecret);
    if (!parsed.success) {
      writeJson(res, 400, zodErrorBody(parsed.error, "Invalid LDAP configuration"));
      return null;
    }
    return parsed.data;
  } catch (err) {
    const message = err instanceof StoredCredentialDecryptionError
      ? `${err.message} Re-enter the bind password.`
      : "Stored LDAP configuration is unreadable; re-enter the bind password.";
    writeJson(res, 400, { error: message });
    return null;
  }
}

async function readParsed<T extends z.ZodTypeAny>(
  req: IncomingMessage,
  res: ServerResponse,
  schema: T
): Promise<z.output<T> | null> {
  const parsed = schema.safeParse((await readBody(req)) ?? {});
  if (!parsed.success) {
    writeJson(res, 400, zodErrorBody(parsed.error, "Invalid authentication source"));
    return null;
  }
  return parsed.data;
}

/** Register `/api/admin/auth-sources` CRUD and connection-test routes (all `user.manage`). */
export function registerAuthSourceRoutes(router: Router, deps: AuthSourceRouteDeps): void {
  const unavailable = "Authentication source store not available";

  router.add("GET", "/api/admin/auth-sources", async (_req, res) => {
    const store = deps.authSourceStore;
    if (!requireStore(store, res, unavailable)) return;
    writeJson(res, 200, { authSources: (await store.listAuthSources()).map(serializeAuthSource) });
  }, { permission: "user.manage" });

  router.add("POST", "/api/admin/auth-sources", async (req, res) => {
    const store = deps.authSourceStore;
    if (!requireStore(store, res, unavailable)) return;
    const body = await readParsed(req, res, sourceFieldsSchema);
    if (!body) return;
    const config = resolveConfig(res, body.config, null, deps.adminAuthSecret);
    if (!config) return;
    if (!deps.adminAuthSecret) {
      writeJson(res, 400, { error: MISSING_SECRET_ERROR });
      return;
    }
    try {
      const created = await store.createAuthSource({
        name: body.name,
        kind: body.kind,
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        ...(body.autoProvision !== undefined ? { autoProvision: body.autoProvision } : {}),
        ...(body.defaultRole !== undefined ? { defaultRole: body.defaultRole } : {}),
        ...(body.sessionMaxAgeHours !== undefined ? { sessionMaxAgeHours: body.sessionMaxAgeHours } : {}),
        ...(body.revalidateIntervalMinutes !== undefined ? { revalidateIntervalMinutes: body.revalidateIntervalMinutes } : {}),
        configJson: serializeLdapConfig(config, deps.adminAuthSecret),
      });
      recordAudit(deps.auditStore, req, {
        action: "auth_source.create",
        targetType: "auth_source",
        targetId: created.id,
        details: {
          name: created.name,
          kind: created.kind,
          enabled: created.enabled,
          priority: created.priority,
          autoProvision: created.autoProvision,
          defaultRole: created.defaultRole,
          sessionMaxAgeHours: created.sessionMaxAgeHours,
          revalidateIntervalMinutes: created.revalidateIntervalMinutes,
        },
      });
      writeJson(res, 201, { authSource: serializeAuthSource(created) });
    } catch (err) {
      if (isDuplicateError(err)) {
        writeJson(res, 409, { error: `Authentication source "${body.name}" already exists` });
        return;
      }
      throw err;
    }
  }, { permission: "user.manage" });

  router.add("POST", "/api/admin/auth-sources/test", async (req, res) => {
    const store = deps.authSourceStore;
    if (!requireStore(store, res, unavailable)) return;
    const body = await readParsed(req, res, testSchema);
    if (!body) return;
    const stored = body.id !== undefined ? await store.getAuthSourceById(body.id) : null;
    if (body.id !== undefined && !stored) {
      writeJson(res, 404, { error: "Authentication source not found" });
      return;
    }
    const config = resolveConfig(res, body.config, stored?.configJson ?? null, deps.adminAuthSecret);
    if (!config) return;
    writeJson(res, 200, await testLdapConnection(config));
  }, { permission: "user.manage" });

  router.add("GET", "/api/admin/auth-sources/:id", async (_req, res, params) => {
    const store = deps.authSourceStore;
    if (!requireStore(store, res, unavailable)) return;
    const source = await store.getAuthSourceById(params["id"] ?? "");
    if (!source) {
      writeJson(res, 404, { error: "Authentication source not found" });
      return;
    }
    writeJson(res, 200, { authSource: serializeAuthSource(source) });
  }, { permission: "user.manage" });

  router.add("PUT", "/api/admin/auth-sources/:id", async (req, res, params) => {
    const store = deps.authSourceStore;
    if (!requireStore(store, res, unavailable)) return;
    const id = params["id"] ?? "";
    const existing = await store.getAuthSourceById(id);
    if (!existing) {
      writeJson(res, 404, { error: "Authentication source not found" });
      return;
    }
    const body = await readParsed(req, res, updateSchema);
    if (!body) return;
    let configJson: string | undefined;
    if (body.config !== undefined) {
      const config = resolveConfig(res, body.config, existing.configJson, deps.adminAuthSecret);
      if (!config) return;
      if (!deps.adminAuthSecret) {
        writeJson(res, 400, { error: MISSING_SECRET_ERROR });
        return;
      }
      configJson = serializeLdapConfig(config, deps.adminAuthSecret);
    }
    try {
      const updated = await store.updateAuthSource(id, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        ...(body.autoProvision !== undefined ? { autoProvision: body.autoProvision } : {}),
        ...(body.defaultRole !== undefined ? { defaultRole: body.defaultRole } : {}),
        ...(body.sessionMaxAgeHours !== undefined ? { sessionMaxAgeHours: body.sessionMaxAgeHours } : {}),
        ...(body.revalidateIntervalMinutes !== undefined ? { revalidateIntervalMinutes: body.revalidateIntervalMinutes } : {}),
        ...(configJson !== undefined ? { configJson } : {}),
      });
      if (!updated) {
        writeJson(res, 404, { error: "Authentication source not found" });
        return;
      }
      // Not gated on `existing.enabled`: an overlapping update may have re-enabled the source since that read.
      const revokedSessions = body.enabled === false
        ? (await deps.identityStore?.deleteSessionsForAuthSource(id)) ?? 0
        : 0;
      recordAudit(deps.auditStore, req, {
        action: "auth_source.update",
        targetType: "auth_source",
        targetId: id,
        details: {
          name: updated.name,
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(body.priority !== undefined ? { priority: body.priority } : {}),
          ...(body.autoProvision !== undefined ? { autoProvision: body.autoProvision } : {}),
          ...(body.defaultRole !== undefined ? { defaultRole: body.defaultRole } : {}),
          ...(body.sessionMaxAgeHours !== undefined ? { sessionMaxAgeHours: body.sessionMaxAgeHours } : {}),
          ...(body.revalidateIntervalMinutes !== undefined ? { revalidateIntervalMinutes: body.revalidateIntervalMinutes } : {}),
          ...(revokedSessions > 0 ? { revokedSessions } : {}),
          configChanged: configJson !== undefined,
        },
      });
      writeJson(res, 200, { authSource: serializeAuthSource(updated) });
    } catch (err) {
      if (isDuplicateError(err)) {
        writeJson(res, 409, { error: `Authentication source "${body.name ?? ""}" already exists` });
        return;
      }
      throw err;
    }
  }, { permission: "user.manage" });

  router.add("DELETE", "/api/admin/auth-sources/:id", async (req, res, params) => {
    const store = deps.authSourceStore;
    if (!requireStore(store, res, unavailable)) return;
    const id = params["id"] ?? "";
    const existing = await store.getAuthSourceById(id);
    if (!existing) {
      writeJson(res, 404, { error: "Authentication source not found" });
      return;
    }
    const linked = (await deps.identityStore?.countUserIdentitiesForSource(id)) ?? 0;
    if (linked > 0) {
      writeJson(res, 409, {
        error: `${linked} ${linked === 1 ? "user signs" : "users sign"} in through this source; unlink or delete them first, or disable the source`,
      });
      return;
    }
    if (!(await store.deleteAuthSource(id))) {
      writeJson(res, 404, { error: "Authentication source not found" });
      return;
    }
    recordAudit(deps.auditStore, req, {
      action: "auth_source.delete",
      targetType: "auth_source",
      targetId: id,
      details: { name: existing.name },
    });
    res.statusCode = 204;
    res.end();
  }, { permission: "user.manage" });

  router.add("POST", "/api/admin/auth-sources/:id/test", async (_req, res, params) => {
    const store = deps.authSourceStore;
    if (!requireStore(store, res, unavailable)) return;
    const source = await store.getAuthSourceById(params["id"] ?? "");
    if (!source) {
      writeJson(res, 404, { error: "Authentication source not found" });
      return;
    }
    const config = resolveConfig(res, publicLdapConfig(source.configJson), source.configJson, deps.adminAuthSecret);
    if (!config) return;
    writeJson(res, 200, await testLdapConnection(config));
  }, { permission: "user.manage" });

  async function serializeMapping(mapping: AuthSourceGroupMapping): Promise<Record<string, unknown>> {
    const group = await deps.directoryGroupStore?.getGroupById(mapping.groupId);
    return {
      id: mapping.id,
      externalGroup: mapping.externalGroup,
      groupId: mapping.groupId,
      groupName: group?.name ?? mapping.groupId,
      createdAt: toIsoTimestamp(mapping.createdAt),
    };
  }

  // Mappings grant group membership (and thus policies), so they need policy.manage.
  router.add("GET", "/api/admin/auth-sources/:id/group-mappings", async (_req, res, params) => {
    const store = deps.authSourceStore;
    const groups = deps.directoryGroupStore;
    if (!requireStore(store, res, unavailable) || !requireStore(groups, res, "Group mapping store not available")) return;
    const id = params["id"] ?? "";
    if (!(await store.getAuthSourceById(id))) {
      writeJson(res, 404, { error: "Authentication source not found" });
      return;
    }
    const mappings = await Promise.all((await groups.listGroupMappings(id)).map(serializeMapping));
    writeJson(res, 200, { mappings });
  }, { permission: PERMISSIONS.POLICY_MANAGE });

  router.add("POST", "/api/admin/auth-sources/:id/group-mappings", async (req, res, params) => {
    const store = deps.authSourceStore;
    const groups = deps.directoryGroupStore;
    if (!requireStore(store, res, unavailable) || !requireStore(groups, res, "Group mapping store not available")) return;
    const id = params["id"] ?? "";
    const source = await store.getAuthSourceById(id);
    if (!source) {
      writeJson(res, 404, { error: "Authentication source not found" });
      return;
    }
    const body = await readParsed(req, res, mappingSchema);
    if (!body) return;
    const group = await groups.getGroupById(body.groupId);
    if (!group) {
      writeJson(res, 404, { error: "Group not found" });
      return;
    }
    try {
      const mapping = await groups.createGroupMapping({
        authSourceId: id,
        externalGroup: normalizeLdapDn(body.externalGroup),
        groupId: group.id,
      });
      recordAudit(deps.auditStore, req, {
        action: "auth_source.group_mapping_create",
        targetType: "auth_source",
        targetId: id,
        details: { name: source.name, externalGroup: mapping.externalGroup, groupId: group.id, groupName: group.name },
      });
      writeJson(res, 201, { mapping: await serializeMapping(mapping) });
    } catch (err) {
      if (err instanceof Error && "code" in err && (err as { code?: unknown }).code === "DUPLICATE") {
        writeJson(res, 409, { error: "This directory group is already mapped to that group" });
        return;
      }
      throw err;
    }
  }, { permission: PERMISSIONS.POLICY_MANAGE });

  router.add("DELETE", "/api/admin/auth-sources/:id/group-mappings/:mappingId", async (req, res, params) => {
    const groups = deps.directoryGroupStore;
    if (!requireStore(groups, res, "Group mapping store not available")) return;
    const id = params["id"] ?? "";
    const mappingId = params["mappingId"] ?? "";
    const existing = (await groups.listGroupMappings(id)).find((mapping) => mapping.id === mappingId);
    if (!existing || !(await groups.deleteGroupMapping(id, mappingId))) {
      writeJson(res, 404, { error: "Group mapping not found" });
      return;
    }
    recordAudit(deps.auditStore, req, {
      action: "auth_source.group_mapping_delete",
      targetType: "auth_source",
      targetId: id,
      details: { externalGroup: existing.externalGroup, groupId: existing.groupId },
    });
    res.statusCode = 204;
    res.end();
  }, { permission: PERMISSIONS.POLICY_MANAGE });

  // Preview what a sign-in would resolve to, without a user password.
  router.add("POST", "/api/admin/auth-sources/:id/lookup", async (req, res, params) => {
    const resolver = deps.directoryAccounts;
    if (!requireStore(resolver, res, "Directory accounts are not available")) return;
    const body = await readParsed(req, res, lookupSchema);
    if (!body) return;
    const lookup = await resolver.resolve(params["id"] ?? "", body.username);
    if (lookup.status === "source_not_found") {
      writeJson(res, 404, { error: "Authentication source not found" });
      return;
    }
    if (lookup.status !== "found") {
      writeJson(res, 200, lookup.status === "unavailable" ? { status: "unavailable", error: lookup.error } : { status: lookup.status });
      return;
    }
    const groupStore = deps.directoryGroupStore;
    const mappedIds = groupStore ? await groupStore.listMappedGroupIds(lookup.source.id, lookup.account.groups) : [];
    const mappedGroups = groupStore
      ? (await Promise.all(mappedIds.map((groupId) => groupStore.getGroupById(groupId))))
          .filter((group): group is Group => group !== null)
          .map((group) => ({ id: group.id, name: group.name }))
      : [];
    const identity = await deps.identityStore?.getUserIdentityBySubject(lookup.source.id, lookup.account.subject);
    const linkedUser = identity ? await deps.identityStore?.getUserById(identity.userId) : null;
    // Mirrors sign-in: disabled sources are skipped and provisioning never takes an existing username.
    let blockedReason: "source_disabled" | "not_linked" | "username_taken" | null = null;
    if (!lookup.source.enabled) blockedReason = "source_disabled";
    else if (!linkedUser && !lookup.source.autoProvision) blockedReason = "not_linked";
    else if (!linkedUser && await deps.identityStore?.getUserByUsername(normalizeUsername(lookup.account.username))) {
      blockedReason = "username_taken";
    }
    writeJson(res, 200, {
      status: "found",
      account: lookup.account,
      mappedGroups,
      linkedUser: linkedUser ? { id: linkedUser.id, username: linkedUser.username } : null,
      wouldProvision: !linkedUser && blockedReason === null,
      blockedReason,
    });
  }, { permission: "user.manage" });
}
