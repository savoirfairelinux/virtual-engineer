import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Router } from "./router.js";
import { readBody, requireStore, toIsoTimestamp, writeJson, zodErrorBody } from "./adminRouteUtils.js";
import { recordAudit, type AuditCapableStore } from "./adminAudit.js";
import type { AuthSourceRecord, AuthSourceStoreApi } from "../state/stores/authSourceStore.js";
import { parseLdapConfigInput, publicLdapConfig, serializeLdapConfig, type LdapConfig } from "./authentication/ldapConfig.js";
import { testLdapConnection } from "./authentication/ldapDirectory.js";
import { StoredCredentialDecryptionError } from "../utils/encryption.js";

const MISSING_SECRET_ERROR = "ADMIN_AUTH_SECRET is required to encrypt credentials.";

const sourceFieldsSchema = z.object({
  name: z.string().trim().min(1, "is required").max(100),
  kind: z.literal("ldap"),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(10_000).optional(),
  config: z.record(z.unknown()),
});
const updateSchema = sourceFieldsSchema.omit({ kind: true }).partial();
const testSchema = z.object({ id: z.string().min(1).optional(), kind: z.literal("ldap"), config: z.record(z.unknown()) });

export interface AuthSourceRouteDeps {
  authSourceStore?: AuthSourceStoreApi | undefined;
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
  return parsed.data as z.output<T>;
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
        configJson: serializeLdapConfig(config, deps.adminAuthSecret),
      });
      recordAudit(deps.auditStore, req, {
        action: "auth_source.create",
        targetType: "auth_source",
        targetId: created.id,
        details: { name: created.name, kind: created.kind, enabled: created.enabled, priority: created.priority },
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
        ...(configJson !== undefined ? { configJson } : {}),
      });
      if (!updated) {
        writeJson(res, 404, { error: "Authentication source not found" });
        return;
      }
      recordAudit(deps.auditStore, req, {
        action: "auth_source.update",
        targetType: "auth_source",
        targetId: id,
        details: {
          name: updated.name,
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(body.priority !== undefined ? { priority: body.priority } : {}),
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
    if (!existing || !(await store.deleteAuthSource(id))) {
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
}
