import { randomUUID } from "crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { policyBindings, runtimePolicies, type RuntimePolicyKind } from "../schema.js";
import * as schema from "../schema.js";

/** A declarative agent-runtime policy record. */
export interface RuntimePolicyRecord {
  id: string;
  name: string;
  kind: RuntimePolicyKind;
  yaml: string;
  description: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A binding of a policy to a project or an agent (exactly one is non-null). */
export interface PolicyBindingRecord {
  id: string;
  policyId: string;
  projectId: string | null;
  agentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PolicyStoreApi {
  createRuntimePolicy(input: {
    id?: string;
    name: string;
    kind: RuntimePolicyKind;
    yaml?: string;
    description?: string;
  }): Promise<RuntimePolicyRecord>;
  getRuntimePolicyById(id: string): Promise<RuntimePolicyRecord | null>;
  listRuntimePolicies(filter?: { kind?: RuntimePolicyKind }): Promise<RuntimePolicyRecord[]>;
  updateRuntimePolicy(
    id: string,
    partial: Partial<Pick<RuntimePolicyRecord, "name" | "kind" | "yaml" | "description">>
  ): Promise<RuntimePolicyRecord>;
  deleteRuntimePolicy(id: string): Promise<void>;
  /** Bind a policy to a project (`agentId` null) or an agent (`projectId` null). */
  bindPolicy(input: { policyId: string; projectId?: string | null; agentId?: string | null }): Promise<PolicyBindingRecord>;
  unbindPolicy(bindingId: string): Promise<void>;
  /** Policies bound to a project. */
  getPoliciesForProject(projectId: string): Promise<RuntimePolicyRecord[]>;
  /** Policies bound to an agent. */
  getPoliciesForAgent(agentId: string): Promise<RuntimePolicyRecord[]>;
}

interface PolicyStoreContext {
  db: BetterSQLite3Database<typeof schema>;
}

export function createPolicyStore(context: PolicyStoreContext): PolicyStoreApi {
  const { db } = context;

  function rowToPolicy(row: typeof runtimePolicies.$inferSelect): RuntimePolicyRecord {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      yaml: row.yaml,
      description: row.description,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async function getRuntimePolicyById(id: string): Promise<RuntimePolicyRecord | null> {
    const row = await db.query.runtimePolicies.findFirst({ where: eq(runtimePolicies.id, id) });
    return row ? rowToPolicy(row) : null;
  }

  async function createRuntimePolicy(input: {
    id?: string;
    name: string;
    kind: RuntimePolicyKind;
    yaml?: string;
    description?: string;
  }): Promise<RuntimePolicyRecord> {
    const now = new Date();
    const id = input.id ?? randomUUID();
    await db.insert(runtimePolicies).values({
      id,
      name: input.name,
      kind: input.kind,
      yaml: input.yaml ?? "",
      description: input.description ?? "",
      createdAt: now,
      updatedAt: now,
    });
    const created = await getRuntimePolicyById(id);
    if (!created) throw new Error(`Failed to create runtime policy '${id}'`);
    return created;
  }

  async function listRuntimePolicies(filter?: { kind?: RuntimePolicyKind }): Promise<RuntimePolicyRecord[]> {
    const rows = await db.query.runtimePolicies.findMany(
      filter?.kind ? { where: eq(runtimePolicies.kind, filter.kind) } : undefined
    );
    return rows.map(rowToPolicy);
  }

  async function updateRuntimePolicy(
    id: string,
    partial: Partial<Pick<RuntimePolicyRecord, "name" | "kind" | "yaml" | "description">>
  ): Promise<RuntimePolicyRecord> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (partial.name !== undefined) set["name"] = partial.name;
    if (partial.kind !== undefined) set["kind"] = partial.kind;
    if (partial.yaml !== undefined) set["yaml"] = partial.yaml;
    if (partial.description !== undefined) set["description"] = partial.description;
    await db.update(runtimePolicies).set(set).where(eq(runtimePolicies.id, id));
    const updated = await getRuntimePolicyById(id);
    if (!updated) throw new Error(`Runtime policy '${id}' not found`);
    return updated;
  }

  async function deleteRuntimePolicy(id: string): Promise<void> {
    await db.delete(policyBindings).where(eq(policyBindings.policyId, id));
    await db.delete(runtimePolicies).where(eq(runtimePolicies.id, id));
  }

  async function bindPolicy(input: {
    policyId: string;
    projectId?: string | null;
    agentId?: string | null;
  }): Promise<PolicyBindingRecord> {
    const projectId = input.projectId ?? null;
    const agentId = input.agentId ?? null;
    if ((projectId === null) === (agentId === null)) {
      throw new Error("bindPolicy requires exactly one of projectId or agentId");
    }
    const now = new Date();
    const id = randomUUID();
    await db.insert(policyBindings).values({
      id,
      policyId: input.policyId,
      projectId,
      agentId,
      createdAt: now,
      updatedAt: now,
    });
    return { id, policyId: input.policyId, projectId, agentId, createdAt: now, updatedAt: now };
  }

  async function unbindPolicy(bindingId: string): Promise<void> {
    await db.delete(policyBindings).where(eq(policyBindings.id, bindingId));
  }

  async function getPoliciesForProject(projectId: string): Promise<RuntimePolicyRecord[]> {
    const rows = await db
      .select({ policy: runtimePolicies })
      .from(policyBindings)
      .innerJoin(runtimePolicies, eq(policyBindings.policyId, runtimePolicies.id))
      .where(and(eq(policyBindings.projectId, projectId), isNull(policyBindings.agentId)));
    return rows.map((r) => rowToPolicy(r.policy));
  }

  async function getPoliciesForAgent(agentId: string): Promise<RuntimePolicyRecord[]> {
    const rows = await db
      .select({ policy: runtimePolicies })
      .from(policyBindings)
      .innerJoin(runtimePolicies, eq(policyBindings.policyId, runtimePolicies.id))
      .where(and(eq(policyBindings.agentId, agentId), isNull(policyBindings.projectId)));
    return rows.map((r) => rowToPolicy(r.policy));
  }

  return {
    createRuntimePolicy,
    getRuntimePolicyById,
    listRuntimePolicies,
    updateRuntimePolicy,
    deleteRuntimePolicy,
    bindPolicy,
    unbindPolicy,
    getPoliciesForProject,
    getPoliciesForAgent,
  };
}
