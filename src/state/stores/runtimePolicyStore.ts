import { randomUUID } from "crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { runtimePolicyBindings, runtimePolicies, type RuntimePolicyKind } from "../schema.js";
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
export interface RuntimePolicyBindingRecord {
  id: string;
  policyId: string;
  kind: RuntimePolicyKind;
  projectId: string | null;
  agentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RuntimePolicyStoreApi {
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
  bindRuntimePolicy(input: { policyId: string; projectId?: string | null; agentId?: string | null }): Promise<RuntimePolicyBindingRecord>;
  listRuntimePolicyBindings(policyId: string): Promise<RuntimePolicyBindingRecord[]>;
  unbindRuntimePolicy(bindingId: string): Promise<void>;
  /** Policies bound to a project. */
  getRuntimePoliciesForProject(projectId: string): Promise<RuntimePolicyRecord[]>;
  /** Policies bound to an agent. */
  getRuntimePoliciesForAgent(agentId: string): Promise<RuntimePolicyRecord[]>;
}

interface RuntimePolicyStoreContext {
  db: BetterSQLite3Database<typeof schema>;
}

export function createRuntimePolicyStore(context: RuntimePolicyStoreContext): RuntimePolicyStoreApi {
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
    db.transaction((transaction) => {
      if (partial.kind !== undefined) {
        transaction.update(runtimePolicyBindings)
          .set({ kind: partial.kind, updatedAt: new Date() })
          .where(eq(runtimePolicyBindings.policyId, id))
          .run();
      }
      transaction.update(runtimePolicies).set(set).where(eq(runtimePolicies.id, id)).run();
    });
    const updated = await getRuntimePolicyById(id);
    if (!updated) throw new Error(`Runtime policy '${id}' not found`);
    return updated;
  }

  async function deleteRuntimePolicy(id: string): Promise<void> {
    await db.delete(runtimePolicyBindings).where(eq(runtimePolicyBindings.policyId, id));
    await db.delete(runtimePolicies).where(eq(runtimePolicies.id, id));
  }

  async function bindRuntimePolicy(input: {
    policyId: string;
    projectId?: string | null;
    agentId?: string | null;
  }): Promise<RuntimePolicyBindingRecord> {
    const projectId = input.projectId ?? null;
    const agentId = input.agentId ?? null;
    if ((projectId === null) === (agentId === null)) {
      throw new Error("bindRuntimePolicy requires exactly one of projectId or agentId");
    }
    const policy = await getRuntimePolicyById(input.policyId);
    if (!policy) throw new Error(`Runtime policy '${input.policyId}' not found`);
    const boundPolicies = projectId !== null
      ? await getRuntimePoliciesForProject(projectId)
      : await getRuntimePoliciesForAgent(agentId!);
    if (boundPolicies.some((bound) => bound.kind === policy.kind)) {
      const target = projectId !== null ? `project ${projectId}` : `agent ${agentId}`;
      throw new Error(`A ${policy.kind} runtime policy is already bound to ${target}`);
    }
    const now = new Date();
    const id = randomUUID();
    await db.insert(runtimePolicyBindings).values({
      id,
      policyId: input.policyId,
      kind: policy.kind,
      projectId,
      agentId,
      createdAt: now,
      updatedAt: now,
    });
    const binding = await db.query.runtimePolicyBindings.findFirst({
      where: eq(runtimePolicyBindings.id, id),
    });
    if (!binding) throw new Error(`Failed to create runtime policy binding '${id}'`);
    return binding;
  }

  async function unbindRuntimePolicy(bindingId: string): Promise<void> {
    await db.delete(runtimePolicyBindings).where(eq(runtimePolicyBindings.id, bindingId));
  }

  async function listRuntimePolicyBindings(policyId: string): Promise<RuntimePolicyBindingRecord[]> {
    return db.query.runtimePolicyBindings.findMany({
      where: eq(runtimePolicyBindings.policyId, policyId),
    });
  }

  async function getRuntimePoliciesForProject(projectId: string): Promise<RuntimePolicyRecord[]> {
    const rows = await db
      .select({ policy: runtimePolicies })
      .from(runtimePolicyBindings)
      .innerJoin(runtimePolicies, eq(runtimePolicyBindings.policyId, runtimePolicies.id))
      .where(and(eq(runtimePolicyBindings.projectId, projectId), isNull(runtimePolicyBindings.agentId)));
    return rows.map((r) => rowToPolicy(r.policy));
  }

  async function getRuntimePoliciesForAgent(agentId: string): Promise<RuntimePolicyRecord[]> {
    const rows = await db
      .select({ policy: runtimePolicies })
      .from(runtimePolicyBindings)
      .innerJoin(runtimePolicies, eq(runtimePolicyBindings.policyId, runtimePolicies.id))
      .where(and(eq(runtimePolicyBindings.agentId, agentId), isNull(runtimePolicyBindings.projectId)));
    return rows.map((r) => rowToPolicy(r.policy));
  }

  return {
    createRuntimePolicy,
    getRuntimePolicyById,
    listRuntimePolicies,
    updateRuntimePolicy,
    deleteRuntimePolicy,
    bindRuntimePolicy,
    listRuntimePolicyBindings,
    unbindRuntimePolicy,
    getRuntimePoliciesForProject,
    getRuntimePoliciesForAgent,
  };
}
