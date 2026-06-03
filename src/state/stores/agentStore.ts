import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type {
  AgentId,
  AgentRecord,
  AgentType,
} from "../../interfaces.js";
import {
  agents,
  appConcurrency,
  projects,
} from "../schema.js";
import * as schema from "../schema.js";

export interface AgentStoreApi {
  createAgent(input: {
    id?: string;
    name: string;
    type: AgentType;
    modelConfigJson: string;
    integrationId?: string | null;
    systemPromptId?: string | null;
    instructionsPromptId?: string | null;
    feedbackInstructionsPromptId?: string | null;
    maxConcurrent?: number;
    enabled?: boolean;
  }): Promise<AgentRecord>;
  getAgentById(id: AgentId): Promise<AgentRecord | null>;
  listAgents(filter?: { type?: AgentType; enabled?: boolean }): Promise<AgentRecord[]>;
  updateAgent(
    id: AgentId,
    partial: Partial<Pick<AgentRecord, "name" | "type" | "modelConfigJson" | "integrationId" | "systemPromptId" | "instructionsPromptId" | "feedbackInstructionsPromptId" | "maxConcurrent" | "enabled">>
  ): Promise<AgentRecord>;
  deleteAgent(id: AgentId): Promise<void>;
  setAgentEnabled(id: AgentId, enabled: boolean): Promise<void>;
  getGlobalConcurrencyLimit(): Promise<number | null>;
  setGlobalConcurrencyLimit(value: number | null): Promise<void>;
}

interface AgentStoreContext {
  db: BetterSQLite3Database<typeof schema>;
}

export function createAgentStore(context: AgentStoreContext): AgentStoreApi {
  const { db } = context;

  function rowToAgent(row: typeof agents.$inferSelect): AgentRecord {
    return {
      id: row.id as AgentId,
      name: row.name,
      type: row.type,
      modelConfigJson: row.modelConfigJson,
      integrationId: row.integrationId ?? null,
      systemPromptId: row.systemPromptId ?? null,
      instructionsPromptId: row.instructionsPromptId ?? null,
      feedbackInstructionsPromptId: row.feedbackInstructionsPromptId ?? null,
      maxConcurrent: row.maxConcurrent,
      enabled: row.enabled === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async function createAgent(input: {
    id?: string;
    name: string;
    type: AgentType;
    modelConfigJson: string;
    integrationId?: string | null;
    systemPromptId?: string | null;
    instructionsPromptId?: string | null;
    feedbackInstructionsPromptId?: string | null;
    maxConcurrent?: number;
    enabled?: boolean;
  }): Promise<AgentRecord> {
    const now = new Date();
    const id = input.id ?? randomUUID();
    await db.insert(agents).values({
      id,
      name: input.name,
      type: input.type,
      modelConfigJson: input.modelConfigJson,
      integrationId: input.integrationId ?? null,
      systemPromptId: input.systemPromptId ?? null,
      instructionsPromptId: input.instructionsPromptId ?? null,
      feedbackInstructionsPromptId: input.feedbackInstructionsPromptId ?? null,
      maxConcurrent: input.maxConcurrent ?? 1,
      enabled: input.enabled === false ? 0 : 1,
      createdAt: now,
      updatedAt: now,
    });
    const created = await getAgentById(id as AgentId);
    if (!created) throw new Error(`Failed to create agent ${id}`);
    return created;
  }

  async function getAgentById(id: AgentId): Promise<AgentRecord | null> {
    const row = await db.query.agents.findFirst({ where: eq(agents.id, id) });
    return row ? rowToAgent(row) : null;
  }

  async function listAgents(filter?: { type?: AgentType; enabled?: boolean }): Promise<AgentRecord[]> {
    const rows = await db.query.agents.findMany({
      orderBy: (table, { asc }) => [asc(table.name)],
    });
    let result = rows.map((row) => rowToAgent(row));
    if (filter?.type !== undefined) result = result.filter((agent) => agent.type === filter.type);
    if (filter?.enabled !== undefined) result = result.filter((agent) => agent.enabled === filter.enabled);
    return result;
  }

  async function updateAgent(
    id: AgentId,
    partial: Partial<Pick<AgentRecord, "name" | "type" | "modelConfigJson" | "integrationId" | "systemPromptId" | "instructionsPromptId" | "feedbackInstructionsPromptId" | "maxConcurrent" | "enabled">>
  ): Promise<AgentRecord> {
    const existing = await getAgentById(id);
    if (!existing) throw new Error(`Agent not found: ${id}`);
    const now = new Date();
    const update: Record<string, unknown> = { updatedAt: now };
    if (partial.name !== undefined) update["name"] = partial.name;
    if (partial.type !== undefined) update["type"] = partial.type;
    if (partial.modelConfigJson !== undefined) update["modelConfigJson"] = partial.modelConfigJson;
    if (partial.integrationId !== undefined) update["integrationId"] = partial.integrationId;
    if (partial.systemPromptId !== undefined) update["systemPromptId"] = partial.systemPromptId;
    if (partial.instructionsPromptId !== undefined) update["instructionsPromptId"] = partial.instructionsPromptId;
    if (partial.feedbackInstructionsPromptId !== undefined) update["feedbackInstructionsPromptId"] = partial.feedbackInstructionsPromptId;
    if (partial.maxConcurrent !== undefined) update["maxConcurrent"] = partial.maxConcurrent;
    if (partial.enabled !== undefined) update["enabled"] = partial.enabled ? 1 : 0;
    await db.update(agents).set(update).where(eq(agents.id, id));
    const updated = await getAgentById(id);
    if (!updated) throw new Error(`Agent disappeared after update: ${id}`);
    return updated;
  }

  async function deleteAgent(id: AgentId): Promise<void> {
    const referenced = await db.query.projects.findFirst({
      where: eq(projects.agentId, id),
    });
    if (referenced) {
      throw new Error(`Cannot delete agent ${id}: still referenced by one or more projects`);
    }
    await db.delete(agents).where(eq(agents.id, id));
  }

  async function setAgentEnabled(id: AgentId, enabled: boolean): Promise<void> {
    const existing = await getAgentById(id);
    if (!existing) throw new Error(`Agent not found: ${id}`);
    await db
      .update(agents)
      .set({ enabled: enabled ? 1 : 0, updatedAt: new Date() })
      .where(eq(agents.id, id));
  }

  async function getGlobalConcurrencyLimit(): Promise<number | null> {
    const row = await db.query.appConcurrency.findFirst({ where: eq(appConcurrency.id, "global") });
    if (!row) return null;
    return row.maxConcurrent ?? null;
  }

  async function setGlobalConcurrencyLimit(value: number | null): Promise<void> {
    const now = new Date();
    const existing = await db.query.appConcurrency.findFirst({ where: eq(appConcurrency.id, "global") });
    if (existing) {
      await db
        .update(appConcurrency)
        .set({ maxConcurrent: value, updatedAt: now })
        .where(eq(appConcurrency.id, "global"));
    } else {
      await db.insert(appConcurrency).values({ id: "global", maxConcurrent: value, updatedAt: now });
    }
  }

  return {
    createAgent,
    getAgentById,
    listAgents,
    updateAgent,
    deleteAgent,
    setAgentEnabled,
    getGlobalConcurrencyLimit,
    setGlobalConcurrencyLimit,
  };
}
