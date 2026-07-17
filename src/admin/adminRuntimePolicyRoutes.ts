import { writeJson, readBody } from "./adminRouteUtils.js";
import type { Router } from "./router.js";
import type { RuntimePolicyStoreApi } from "../state/stores/runtimePolicyStore.js";
import type { RuntimePolicyKind } from "../state/schema.js";
import { OPEN_SHELL_POLICY_KEYS } from "../openshell/openShellPolicyBuilder.js";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateNetworkPolicy(section: Record<string, unknown>): string | null {
  if (Object.hasOwn(section, "default") || Object.hasOwn(section, "allow")) {
    return "Runtime policy 'network_policies' must contain named rules; legacy default/allow fields are unsupported";
  }
  for (const [ruleName, rule] of Object.entries(section)) {
    if (!isRecord(rule)) return `Network policy rule '${ruleName}' must be an object`;
    if (typeof rule["name"] !== "string" || rule["name"] === "") {
      return `Network policy rule '${ruleName}' must have a name`;
    }
    const binaries = rule["binaries"];
    if (!Array.isArray(binaries) || binaries.length === 0
      || binaries.some((binary) => !isRecord(binary) || typeof binary["path"] !== "string")) {
      return `Network policy rule '${ruleName}' must have binaries with path values`;
    }
    const endpoints = rule["endpoints"];
    if (!Array.isArray(endpoints) || endpoints.length === 0
      || endpoints.some((endpoint) => !isRecord(endpoint)
        || typeof endpoint["host"] !== "string"
        || !Number.isInteger(endpoint["port"]))) {
      return `Network policy rule '${ruleName}' must have endpoints with host and integer port values`;
    }
  }
  return null;
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
  if (!isRecord(document)) {
    return "Runtime policy YAML must be an object";
  }
  const expectedKey = OPEN_SHELL_POLICY_KEYS[kind];
  if (!Object.hasOwn(document, expectedKey)) {
    return `Runtime policy YAML must contain a '${expectedKey}' section`;
  }
  const keys = Object.keys(document);
  if (keys.length !== 1 || keys[0] !== expectedKey) {
    return `Runtime policy YAML may contain only the '${expectedKey}' top-level section`;
  }
  const section = document[expectedKey];
  if (!isRecord(section)) {
    return `Runtime policy '${expectedKey}' section must be an object`;
  }
  if (kind === "network") return validateNetworkPolicy(section);
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

  router.add("GET", "/api/admin/runtime/policies/:id/bindings", async (_req, res, params) => {
    const store = guard(res);
    if (!store) return;
    writeJson(res, 200, {
      bindings: await store.listRuntimePolicyBindings(params["id"] ?? ""),
    });
  }, { permission: "policy.manage" });

  router.add("DELETE", "/api/admin/runtime/policies/bindings/:bindingId", async (_req, res, params) => {
    const store = guard(res);
    if (!store) return;
    await store.unbindRuntimePolicy(params["bindingId"] ?? "");
    writeJson(res, 204, {});
  }, { permission: "policy.manage" });
}
