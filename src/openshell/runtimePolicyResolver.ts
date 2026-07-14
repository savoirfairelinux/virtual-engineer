import type { PolicyResolver } from "../workspace/openShellWorkspaceRunner.js";
import type { RuntimePolicyRecord } from "../state/stores/runtimePolicyStore.js";
import { parse, stringify } from "yaml";

interface RuntimePolicyResolverStore {
  getTask(taskId: Parameters<PolicyResolver>[0]["taskId"]): Promise<{ projectId?: string | null | undefined } | null>;
  getProjectById(projectId: string): Promise<{ agentId: string } | null>;
  getRuntimePoliciesForProject(projectId: string): Promise<RuntimePolicyRecord[]>;
  getRuntimePoliciesForAgent(agentId: string): Promise<RuntimePolicyRecord[]>;
}

function selectPolicy(policies: RuntimePolicyRecord[], owner: string): string | undefined {
  if (policies.length === 0) return undefined;
  const byKind = new Map<string, RuntimePolicyRecord>();
  const document: Record<string, unknown> = {};
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
    const section = (parsed as Record<string, unknown>)[policy.kind];
    if (section === undefined) {
      throw new Error(`Runtime policy '${policy.name}' bound to ${owner} has no ${policy.kind} section`);
    }
    byKind.set(policy.kind, policy);
    document[policy.kind] = section;
  }
  return stringify(document);
}

export function createRuntimePolicyResolver(store: RuntimePolicyResolverStore): PolicyResolver {
  return async ({ taskId }) => {
    const task = await store.getTask(taskId);
    if (!task?.projectId) return undefined;

    const projectPolicies = await store.getRuntimePoliciesForProject(task.projectId);
    const projectPolicy = selectPolicy(projectPolicies, `project ${task.projectId}`);
    if (projectPolicy !== undefined) return projectPolicy;

    const project = await store.getProjectById(task.projectId);
    if (!project) return undefined;
    const agentPolicies = await store.getRuntimePoliciesForAgent(project.agentId);
    return selectPolicy(agentPolicies, `agent ${project.agentId}`);
  };
}
