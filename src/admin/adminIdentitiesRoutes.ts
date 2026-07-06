import { z } from "zod";
import { getLogger } from "../logger.js";
import { writeJson, readBody, zodErrorBody } from "./adminRouteUtils.js";
import { makeIdentityId, type IdentityId, type IdentityRecord } from "../interfaces.js";
import type { Router } from "./router.js";

const log = getLogger("admin-identities");

/** Store surface backing the /api/admin/identities routes. */
export interface IdentitiesRouteStore {
  createIdentity(input: {
    id?: string;
    name: string;
    email?: string;
    username?: string;
    signature?: string;
  }): Promise<IdentityRecord>;
  getIdentityById(id: IdentityId): Promise<IdentityRecord | null>;
  listIdentities(): Promise<IdentityRecord[]>;
  updateIdentity(
    id: IdentityId,
    partial: Partial<Pick<IdentityRecord, "name" | "email" | "username" | "signature">>
  ): Promise<IdentityRecord>;
  deleteIdentity(id: IdentityId): Promise<void>;
}

export interface IdentitiesRouteDeps {
  identityStore?: IdentitiesRouteStore | undefined;
  /** Called after an identity is created/updated/deleted so runtime can refresh. */
  onIdentityChange?: (() => void) | undefined;
}

const identityCreateSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1, "Identity name is required"),
  email: z.string().optional(),
  username: z.string().optional(),
  signature: z.string().optional(),
});

const identityUpdateSchema = z.object({
  name: z.string().min(1, "Identity name is required").optional(),
  email: z.string().optional(),
  username: z.string().optional(),
  signature: z.string().optional(),
});

/** Serialise an IdentityRecord into the JSON API shape. */
function toApi(identity: IdentityRecord): Record<string, unknown> {
  return {
    id: identity.id,
    name: identity.name,
    email: identity.email,
    username: identity.username,
    signature: identity.signature,
    createdAt: identity.createdAt.toISOString(),
    updatedAt: identity.updatedAt.toISOString(),
  };
}

/** Register the VE-identity CRUD routes on the given router. */
export function registerIdentityRoutes(router: Router, deps: IdentitiesRouteDeps): void {
  router.add("GET", "/api/admin/identities", async (_req, res, _params) => {
    if (!deps.identityStore) { writeJson(res, 501, { error: "Identity store not available" }); return; }
    const identities = await deps.identityStore.listIdentities();
    writeJson(res, 200, { identities: identities.map(toApi) });
  });

  router.add("POST", "/api/admin/identities", async (req, res, _params) => {
    if (!deps.identityStore) { writeJson(res, 501, { error: "Identity store not available" }); return; }
    const body = await readBody(req);
    if (!body) { writeJson(res, 400, { error: "Request body required" }); return; }
    const parsed = identityCreateSchema.safeParse(body);
    if (!parsed.success) { writeJson(res, 400, zodErrorBody(parsed.error, "Invalid identity payload")); return; }
    const data = parsed.data;
    try {
      const identity = await deps.identityStore.createIdentity({
        ...(data.id !== undefined ? { id: data.id } : {}),
        name: data.name,
        ...(data.email !== undefined ? { email: data.email } : {}),
        ...(data.username !== undefined ? { username: data.username } : {}),
        ...(data.signature !== undefined ? { signature: data.signature } : {}),
      });
      writeJson(res, 201, { identity: toApi(identity) });
      deps.onIdentityChange?.();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err }, "create identity failed");
      writeJson(res, 500, { error: msg });
    }
  });

  router.add("GET", "/api/admin/identities/:id", async (_req, res, params) => {
    if (!deps.identityStore) { writeJson(res, 501, { error: "Identity store not available" }); return; }
    const id = makeIdentityId(params["id"] ?? "");
    const identity = await deps.identityStore.getIdentityById(id);
    if (!identity) { writeJson(res, 404, { error: "Identity not found" }); return; }
    writeJson(res, 200, { identity: toApi(identity) });
  });

  router.add("PUT", "/api/admin/identities/:id", async (req, res, params) => {
    if (!deps.identityStore) { writeJson(res, 501, { error: "Identity store not available" }); return; }
    const id = makeIdentityId(params["id"] ?? "");
    const existing = await deps.identityStore.getIdentityById(id);
    if (!existing) { writeJson(res, 404, { error: "Identity not found" }); return; }
    const body = await readBody(req);
    if (!body) { writeJson(res, 400, { error: "Request body required" }); return; }
    const parsed = identityUpdateSchema.safeParse(body);
    if (!parsed.success) { writeJson(res, 400, zodErrorBody(parsed.error, "Invalid identity payload")); return; }
    const data = parsed.data;
    const updates: Parameters<IdentitiesRouteStore["updateIdentity"]>[1] = {};
    if (data.name !== undefined) updates.name = data.name;
    if (data.email !== undefined) updates.email = data.email;
    if (data.username !== undefined) updates.username = data.username;
    if (data.signature !== undefined) updates.signature = data.signature;
    try {
      const identity = await deps.identityStore.updateIdentity(id, updates);
      writeJson(res, 200, { identity: toApi(identity) });
      deps.onIdentityChange?.();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err, id }, "update identity failed");
      writeJson(res, 500, { error: msg });
    }
  });

  router.add("DELETE", "/api/admin/identities/:id", async (_req, res, params) => {
    if (!deps.identityStore) { writeJson(res, 501, { error: "Identity store not available" }); return; }
    const id = makeIdentityId(params["id"] ?? "");
    const existing = await deps.identityStore.getIdentityById(id);
    if (!existing) { writeJson(res, 404, { error: "Identity not found" }); return; }
    try {
      await deps.identityStore.deleteIdentity(id);
      res.statusCode = 204; res.end();
      deps.onIdentityChange?.();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err, id }, "delete identity failed");
      writeJson(res, 500, { error: msg });
    }
  });
}
