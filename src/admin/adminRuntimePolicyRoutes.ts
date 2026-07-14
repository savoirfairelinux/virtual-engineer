import { writeJson, readBody } from "./adminRouteUtils.js";
import type { Router } from "./router.js";
import type { RuntimePolicyStoreApi } from "../state/stores/runtimePolicyStore.js";
import type { RuntimePolicyKind } from "../state/schema.js";
import { parse } from "yaml";

const VALID_KINDS = new Set<RuntimePolicyKind>(["filesystem", "network", "process", "inference"]);
const MAX_POLICY_YAML_BYTES = 64 * 1024;

export interface RuntimePolicyRouteDeps {
  runtimePolicyStore?: RuntimePolicyStoreApi | undefined;
  /** OpenShell gateway probe: reports whether the k8s-backed agent runtime is reachable. */
  gateway?: { healthy(): Promise<boolean>; address: string | undefined } | undefined;
}

function isKind(value: unknown): value is RuntimePolicyKind {
  return typeof value === "string" && VALID_KINDS.has(value as RuntimePolicyKind);
}

export function validateRuntimePolicyYaml(kind: RuntimePolicyKind, yaml: string): string | null {
  if (yaml.trim().length === 0) return "Runtime policy YAML must not be empty";
  if (Buffer.byteLength(yaml, "utf8") > MAX_POLICY_YAML_BYTES) {
    return "Runtime policy YAML is too large (maximum 64 KiB)";
  }
  if (/(^|[\s[{,])(?:&|\*)[A-Za-z0-9_-]+/.test(yaml)) {
    return "Runtime policy YAML aliases and anchors are not allowed";
  }
  let document: unknown;
  try {
    document = parse(yaml);
  } catch (err) {
    return `Invalid YAML: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return "Runtime policy YAML must be an object";
  }
  if (!Object.hasOwn(document, kind)) {
    return `Runtime policy YAML must contain a '${kind}' section`;
  }
  const keys = Object.keys(document);
  if (keys.length !== 1 || keys[0] !== kind) {
    return `Runtime policy YAML may contain only the '${kind}' top-level section`;
  }
  const section = (document as Record<string, unknown>)[kind];
  if (typeof section !== "object" || section === null || Array.isArray(section)) {
    return `Runtime policy '${kind}' section must be an object`;
  }
  return null;
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

  // Read-only status of the OpenShell/Kubernetes agent runtime for the admin UI.
  router.add("GET", "/api/admin/runtime/status", async (_req, res) => {
    const gateway = deps.gateway;
    const gatewayHealthy = gateway ? await gateway.healthy().catch(() => false) : false;
    const address = gateway?.address;
    writeJson(res, 200, {
      driver: "kubernetes",
      gatewayConfigured: address !== undefined && address !== "",
      gatewayAddress: address ?? null,
      gatewayHealthy,
    });
  }, { permission: "policy.manage" });

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
    if (typeof body["yaml"] !== "string") {
      writeJson(res, 400, { error: "Runtime policy YAML is required" });
      return;
    }
    const validationError = validateRuntimePolicyYaml(body["kind"], body["yaml"]);
    if (validationError) {
      writeJson(res, 400, { error: validationError });
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
    if (body["kind"] !== undefined || body["yaml"] !== undefined) {
      const nextKind = isKind(body["kind"]) ? body["kind"] : existing.kind;
      const nextYaml = typeof body["yaml"] === "string" ? body["yaml"] : existing.yaml;
      const validationError = validateRuntimePolicyYaml(nextKind, nextYaml);
      if (validationError) {
        writeJson(res, 400, { error: validationError });
        return;
      }
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
