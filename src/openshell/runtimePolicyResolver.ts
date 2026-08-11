import type { PolicyResolver } from "../workspace/openShellWorkspaceRunner.js";
import type { RuntimePolicyRecord } from "../state/stores/runtimePolicyStore.js";
import { createDefaultPolicyDocument, OPEN_SHELL_POLICY_KEYS } from "./openShellPolicyBuilder.js";
import { parse, stringify } from "yaml";

interface RuntimePolicyResolverStore {
  getTask(taskId: Parameters<PolicyResolver>[0]["taskId"]): Promise<{ projectId?: string | null | undefined } | null>;
  getProjectById(projectId: string): Promise<{ agentId: string } | null>;
  getRuntimePoliciesForProject(projectId: string): Promise<RuntimePolicyRecord[]>;
  getRuntimePoliciesForAgent(agentId: string): Promise<RuntimePolicyRecord[]>;
}

function policySections(policies: RuntimePolicyRecord[], owner: string): Map<string, unknown> {
  const byKind = new Map<string, RuntimePolicyRecord>();
  const sections = new Map<string, unknown>();
  for (const policy of policies) {
    if (byKind.has(policy.kind)) {
      throw new Error(`Multiple ${policy.kind} runtime policies are bound to ${owner}`);
    }
    if (!policy.yaml.trim()) {
      throw new Error(`Runtime policy '${policy.name}' bound to ${owner} has empty YAML`);
    }
    const parsed = parse(policy.yaml) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Runtime policy '${policy.name}' bound to ${owner} is not an object`);
    }
    const yamlKey = OPEN_SHELL_POLICY_KEYS[policy.kind];
    const section = (parsed as Record<string, unknown>)[yamlKey];
    if (section === undefined) {
      throw new Error(`Runtime policy '${policy.name}' bound to ${owner} has no ${yamlKey} section`);
    }
    byKind.set(policy.kind, policy);
    sections.set(yamlKey, section);
  }
  return sections;
}

/** Paths a bound filesystem policy must never make writable for the agent. */
const PROTECTED_PATHS = ["/", "/usr", "/lib", "/etc", "/app", "/bin", "/sbin", "/boot", "/var"];

/**
 * A bound runtime policy replaces its whole section, so re-assert the two
 * non-negotiable properties of the sandbox after composition: the agent runs as
 * the unprivileged `sandbox` account, and it cannot gain write access to the
 * image's executable or configuration trees.
 */
function enforceSandboxFloor(document: Record<string, unknown>): void {
  const base = createDefaultPolicyDocument();
  const process = document["process"];
  if (typeof process === "object" && process !== null) {
    Object.assign(process, base["process"]);
  } else {
    document["process"] = base["process"];
  }

  const filesystem = document["filesystem_policy"];
  if (typeof filesystem === "object" && filesystem !== null) {
    const policy = filesystem as Record<string, unknown>;
    const readWrite = policy["read_write"];
    if (Array.isArray(readWrite)) {
      const offending = readWrite.filter(
        (entry) => typeof entry === "string" && PROTECTED_PATHS.includes(entry.replace(/\/+$/, "") || "/")
      );
      if (offending.length > 0) {
        throw new Error(
          `Runtime filesystem policy may not grant write access to ${offending.join(", ")}`
        );
      }
    }
  }
}

function composePolicies(
  agentPolicies: RuntimePolicyRecord[],
  projectPolicies: RuntimePolicyRecord[],
  agentId: string,
  projectId: string,
): string | undefined {
  const sections = policySections(agentPolicies, `agent ${agentId}`);
  for (const [kind, section] of policySections(projectPolicies, `project ${projectId}`)) {
    sections.set(kind, section);
  }
  if (sections.size === 0) return undefined;
  const document = createDefaultPolicyDocument();
  for (const [yamlKey, section] of sections) document[yamlKey] = section;
  enforceSandboxFloor(document);
  return stringify(document);
}

export function createRuntimePolicyResolver(store: RuntimePolicyResolverStore): PolicyResolver {
  return async ({ taskId }) => {
    const task = await store.getTask(taskId);
    if (!task?.projectId) return undefined;

    const project = await store.getProjectById(task.projectId);
    if (!project) return undefined;
    const [agentPolicies, projectPolicies] = await Promise.all([
      store.getRuntimePoliciesForAgent(project.agentId),
      store.getRuntimePoliciesForProject(task.projectId),
    ]);
    return composePolicies(agentPolicies, projectPolicies, project.agentId, task.projectId);
  };
}
