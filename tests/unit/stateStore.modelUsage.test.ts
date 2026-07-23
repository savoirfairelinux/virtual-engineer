import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "crypto";
import Database from "better-sqlite3";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { NANO_AIU_PER_CREDIT } from "../../src/agents/cycleCost.js";
import { tempDatabasePath } from "./helpers/tempDatabase.js";
import {
  makeTaskId,
  makeTicketId,
  type AgentLogEvent,
  type AgentResult,
  type ProjectId,
  type TaskId,
} from "../../src/interfaces.js";

function tempDbPath(): string {
  return tempDatabasePath("ve-model");
}

function pricedResult(credits: number, modelId: string): AgentResult {
  const events: AgentLogEvent[] = [
    {
      type: "assistant.usage",
      timestamp: "2026-01-01T00:00:00.000Z",
      data: { apiCallId: `call-${randomUUID()}`, totalNanoAiu: credits * NANO_AIU_PER_CREDIT, model: modelId },
      taskId: "t",
      cycleNumber: 1,
    },
  ];
  return { status: "success", summary: "ok", modifiedFiles: [], agentLogs: "", metadata: {}, agentEvents: events };
}

async function makeTaskForProject(store: SqliteStateStore, projectId?: ProjectId): Promise<TaskId> {
  const taskId = makeTaskId(randomUUID());
  await store.createTask(taskId, makeTicketId(`TKT-${randomUUID()}`));
  if (projectId) await store.setTaskProjectId(taskId, projectId);
  return taskId;
}

/** Insert an agent_cycles row directly with a null model snapshot but event log. */
function insertLegacyCycle(
  dbPath: string,
  row: { taskId: string; createdAtEpochSeconds: number; events: AgentLogEvent[] | null }
): void {
  const db = new Database(dbPath);
  try {
    db.prepare(
      `INSERT INTO agent_cycles
         (task_id, cycle_number, agent_result, validation_result, agent_events,
          cost_ai_credits, cost_usd, premium_requests,
          cost_input_tokens, cost_output_tokens, cost_cached_tokens, cost_cache_write_tokens,
          cost_model_id, created_at)
       VALUES (?, ?, ?, NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)`
    ).run(
      row.taskId,
      1,
      JSON.stringify({ status: "success", summary: "legacy", modifiedFiles: [], agentLogs: "", metadata: {} }),
      row.events ? JSON.stringify(row.events) : null,
      row.createdAtEpochSeconds
    );
  } finally {
    db.close();
  }
}

describe("SqliteStateStore — getModelUsageSummary", () => {
  let store: SqliteStateStore;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tempDbPath();
    store = await SqliteStateStore.create(dbPath);
  });

  afterEach(() => {
    store.close();
  });

  it("aggregates model distribution globally and per project, including legacy runs", async () => {
    const agent = await store.createAgent({
      name: "A",
      type: "coding",
      modelConfigJson: JSON.stringify({ model: "gpt-4.1" }),
      systemPromptId: "system_generic_code",
      instructionsPromptId: "instructions_generic_code",
      enabled: true,
    });
    const p1 = await store.createProject({ name: "BACKEND", type: "coding", agentId: agent.id });
    const p2 = await store.createProject({ name: "MOBILE", type: "coding", agentId: agent.id });

    const t1 = await makeTaskForProject(store, p1.id);
    await store.saveAgentCycle(t1, 1, pricedResult(2, "claude-sonnet"));
    await store.saveAgentCycle(t1, 2, pricedResult(1, "claude-sonnet"));
    await store.saveAgentCycle(t1, 3, pricedResult(1, "copilot/auto"));

    const t2 = await makeTaskForProject(store, p2.id);
    await store.saveAgentCycle(t2, 1, pricedResult(3, "claude-sonnet"));

    // Legacy run: no model snapshot, but events name the model.
    const t3 = await makeTaskForProject(store, p1.id);
    insertLegacyCycle(dbPath, {
      taskId: t3,
      createdAtEpochSeconds: Math.floor(Date.now() / 1000),
      events: pricedResult(5, "copilot/auto").agentEvents ?? null,
    });

    const summary = await store.getModelUsageSummary();

    expect(summary.totalRuns).toBe(5);
    const byModel = new Map(summary.byModel.map((m) => [m.modelId, m]));
    // claude-sonnet: 3 runs (t1 x2 + t2 x1); copilot/auto: 2 runs (t1 x1 + legacy t3).
    expect(byModel.get("claude-sonnet")?.runCount).toBe(3);
    expect(byModel.get("copilot/auto")?.runCount).toBe(2);
    expect(byModel.get("claude-sonnet")?.usd).toBeCloseTo(0.06, 6); // (2+1+3) credits = 6 → $0.06
    expect(byModel.get("copilot/auto")?.usd).toBeCloseTo(0.06, 6); // (1 + 5) credits = 6 → $0.06
    // Sorted by descending run count.
    expect(summary.byModel[0]?.modelId).toBe("claude-sonnet");

    const proj1 = summary.perProject.find((p) => p.projectId === p1.id);
    const p1Models = new Map(proj1?.models.map((m) => [m.modelId, m]));
    expect(p1Models.get("claude-sonnet")?.runCount).toBe(2);
    expect(p1Models.get("copilot/auto")?.runCount).toBe(2); // 1 priced + 1 legacy
    const proj2 = summary.perProject.find((p) => p.projectId === p2.id);
    expect(proj2?.models[0]?.modelId).toBe("claude-sonnet");
    expect(proj2?.models[0]?.runCount).toBe(1);
  });

  it("filters by trailing period via `since`", async () => {
    const agent = await store.createAgent({
      name: "A",
      type: "coding",
      modelConfigJson: JSON.stringify({ model: "gpt-4.1" }),
      systemPromptId: "system_generic_code",
      instructionsPromptId: "instructions_generic_code",
      enabled: true,
    });
    const p1 = await store.createProject({ name: "BACKEND", type: "coding", agentId: agent.id });
    const t1 = await makeTaskForProject(store, p1.id);

    const nowSec = Math.floor(Date.now() / 1000);
    insertLegacyCycle(dbPath, { taskId: t1, createdAtEpochSeconds: nowSec, events: pricedResult(1, "claude-sonnet").agentEvents ?? null });
    insertLegacyCycle(dbPath, {
      taskId: t1,
      createdAtEpochSeconds: nowSec - 60 * 24 * 60 * 60,
      events: pricedResult(1, "old-model").agentEvents ?? null,
    });

    const all = await store.getModelUsageSummary();
    expect(all.totalRuns).toBe(2);

    const recent = await store.getModelUsageSummary({ since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) });
    expect(recent.totalRuns).toBe(1);
    expect(recent.byModel[0]?.modelId).toBe("claude-sonnet");
    expect(recent.sinceEpochSeconds).not.toBeNull();
  });

  it("returns empty distribution when there are no cycles", async () => {
    const summary = await store.getModelUsageSummary();
    expect(summary.totalRuns).toBe(0);
    expect(summary.byModel).toEqual([]);
    expect(summary.perProject).toEqual([]);
  });
});
