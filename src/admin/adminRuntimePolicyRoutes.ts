import { writeJson, readBody } from "./adminRouteUtils.js";
import type { Router } from "./router.js";
import type { RuntimePolicyStoreApi } from "../state/stores/runtimePolicyStore.js";
import type { RuntimePolicyKind } from "../state/schema.js";

const VALID_KINDS = new Set<RuntimePolicyKind>(["filesystem", "network", "process", "inference"]);

export interface RuntimePolicyRouteDeps {
  runtimePolicyStore?: RuntimePolicyStoreApi | undefined;
}

function isKind(value: unknown): value is RuntimePolicyKind {
  return typeof value === "string" && VALID_KINDS.has(value as RuntimePolicyKind);
}

/** Register runtime-policy CRUD + binding routes. */
export function registerRuntimePolicyRoutes(router: Router, deps: RuntimePolicyRouteDeps): void {
  const guard = (res: Parameters<Parameters<Router["add"]>[2]>[1]): RuntimePolicyStoreApi | null => {
    if (!deps.runtimePolicyStore) {
      writeJson(res, 501, { error: "Policy store not available" });
      return null;
    }
    return deps.runtimePolicyStore;
  };

  router.add("GET", "/api/admin/runtime/policies", async (_req, res) => {
    const store = guard(res);
    if (!store) return;
    writeJson(res, 200, { policies: await store.listRuntimePolicies() });
  }, { permission: "policy.manage" });

  router.add("POST", "/api/admin/runtime/policies", async (req, res) => {
    const store = guard(res);
    if (!store) return;
    const body = await readBody(req);
    if (!body || typeof body["name"] !== "string" || !isKind(body["kind"])) {
      writeJson(res, 400, { error: "name and kind (filesystem|network|process|inference) are required" });
      return;
    }
    const created = await store.createRuntimePolicy({
      name: body["name"],
      kind: body["kind"],
      ...(typeof body["yaml"] === "string" ? { yaml: body["yaml"] } : {}),
      ...(typeof body["description"] === "string" ? { description: body["description"] } : {}),
    });
    writeJson(res, 201, { policy: created });
  }, { permission: "policy.manage" });

  router.add("PUT", "/api/admin/runtime/policies/:id", async (req, res, params) => {
    const store = guard(res);
    if (!store) return;
    const id = params["id"] ?? "";
    const existing = await store.getRuntimePolicyById(id);
    if (!existing) {
      writeJson(res, 404, { error: "Policy not found" });
      return;
    }
    const body = (await readBody(req)) ?? {};
    if (body["kind"] !== undefined && !isKind(body["kind"])) {
      writeJson(res, 400, { error: "kind must be filesystem|network|process|inference" });
      return;
    }
    const updated = await store.updateRuntimePolicy(id, {
      ...(typeof body["name"] === "string" ? { name: body["name"] } : {}),
      ...(isKind(body["kind"]) ? { kind: body["kind"] } : {}),
      ...(typeof body["yaml"] === "string" ? { yaml: body["yaml"] } : {}),
      ...(typeof body["description"] === "string" ? { description: body["description"] } : {}),
    });
    writeJson(res, 200, { policy: updated });
  }, { permission: "policy.manage" });

  router.add("DELETE", "/api/admin/runtime/policies/:id", async (_req, res, params) => {
    const store = guard(res);
    if (!store) return;
    await store.deleteRuntimePolicy(params["id"] ?? "");
    writeJson(res, 204, {});
  }, { permission: "policy.manage" });

  router.add("POST", "/api/admin/runtime/policies/:id/bindings", async (req, res, params) => {
    const store = guard(res);
    if (!store) return;
    const policyId = params["id"] ?? "";
    const body = (await readBody(req)) ?? {};
    const projectId = typeof body["projectId"] === "string" ? body["projectId"] : null;
    const agentId = typeof body["agentId"] === "string" ? body["agentId"] : null;
    try {
      const binding = await store.bindRuntimePolicy({ policyId, projectId, agentId });
      writeJson(res, 201, { binding });
    } catch (err) {
      writeJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }, { permission: "policy.manage" });

  router.add("DELETE", "/api/admin/runtime/policies/bindings/:bindingId", async (_req, res, params) => {
    const store = guard(res);
    if (!store) return;
    await store.unbindRuntimePolicy(params["bindingId"] ?? "");
    writeJson(res, 204, {});
  }, { permission: "policy.manage" });
}
