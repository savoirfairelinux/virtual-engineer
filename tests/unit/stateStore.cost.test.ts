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
  return tempDatabasePath("ve-cost");
}

function pricedResult(credits: number, modelId = "claude-sonnet"): AgentResult {
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

async function makeTaskForProject(
  store: SqliteStateStore,
  projectId?: ProjectId
): Promise<TaskId> {
  const taskId = makeTaskId(randomUUID());
  await store.createTask(taskId, makeTicketId(`TKT-${randomUUID()}`));
  if (projectId) await store.setTaskProjectId(taskId, projectId);
  return taskId;
}

/** Insert an agent_cycles row directly, bypassing the store's cost snapshot. */
function insertRawCycle(
  dbPath: string,
  row: {
    taskId: string;
    createdAtEpochSeconds: number;
    costUsd: number | null;
    costAiCredits: number | null;
    agentEvents: string | null;
    /** When set, events are embedded in the serialized AgentResult (predates the agent_events column). */
    resultEvents?: unknown;
  }
): void {
  const db = new Database(dbPath);
  try {
    db.prepare(
      `INSERT INTO agent_cycles
         (task_id, cycle_number, agent_result, validation_result, agent_events,
          cost_ai_credits, cost_usd, premium_requests,
          cost_input_tokens, cost_output_tokens, cost_cached_tokens, cost_cache_write_tokens,
          cost_model_id, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?)`
    ).run(
      row.taskId,
      1,
      JSON.stringify({
        status: "success",
        summary: "legacy",
        modifiedFiles: [],
        agentLogs: "",
        metadata: {},
        ...(row.resultEvents !== undefined ? { agentEvents: row.resultEvents } : {}),
      }),
      row.agentEvents,
      row.costAiCredits,
      row.costUsd,
      row.createdAtEpochSeconds
    );
  } finally {
    db.close();
  }
}

describe("SqliteStateStore — getCostSummary", () => {
  let store: SqliteStateStore;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tempDbPath();
    store = await SqliteStateStore.create(dbPath);
  });

  afterEach(() => {
    store.close();
  });

  it("aggregates cost per project and instance-wide, including legacy runs", async () => {
    const agent = await store.createAgent({
      name: "A",
      type: "coding",
      modelConfigJson: JSON.stringify({ model: "gpt-4.1" }),
      systemPromptId: "system_generic_code",
      instructionsPromptId: "instructions_generic_code",
      enabled: true,
    });
    const p1 = await store.createProject({ name: "PLATFORM", type: "coding", agentId: agent.id });
    const p2 = await store.createProject({ name: "MOBILE", type: "coding", agentId: agent.id });

    const t1 = await makeTaskForProject(store, p1.id);
    await store.saveAgentCycle(t1, 1, pricedResult(2));
    await store.saveAgentCycle(t1, 2, pricedResult(1));

    const t2 = await makeTaskForProject(store, p2.id);
    await store.saveAgentCycle(t2, 1, pricedResult(3));

    // Legacy run on an unassigned task: no cost snapshot, but priced events.
    const t3 = await makeTaskForProject(store);
    insertRawCycle(dbPath, {
      taskId: t3,
      createdAtEpochSeconds: Math.floor(Date.now() / 1000),
      costUsd: null,
      costAiCredits: null,
      agentEvents: JSON.stringify(pricedResult(5).agentEvents),
    });

    const summary = await store.getCostSummary();

    expect(summary.totalRuns).toBe(4);
    expect(summary.totalAiCredits).toBeCloseTo(11, 6);
    expect(summary.totalUsd).toBeCloseTo(0.11, 6);
    expect(summary.sinceEpochSeconds).toBeNull();

    const byId = new Map(summary.perProject.map((p) => [p.projectId, p]));
    expect(byId.get(p1.id)?.usd).toBeCloseTo(0.03, 6);
    expect(byId.get(p1.id)?.runCount).toBe(2);
    expect(byId.get(p1.id)?.projectName).toBe("PLATFORM");
    expect(byId.get(p2.id)?.usd).toBeCloseTo(0.03, 6);
    expect(byId.get(p2.id)?.runCount).toBe(1);
    // Unassigned legacy bucket (projectId null).
    const unassigned = summary.perProject.find((p) => p.projectId === null);
    expect(unassigned?.usd).toBeCloseTo(0.05, 6);
    expect(unassigned?.runCount).toBe(1);

    // Sorted by descending USD: unassigned ($0.05) first.
    expect(summary.perProject[0]?.projectId).toBeNull();
  });

  it("recomputes legacy cost from agent_result when the agent_events column is null", async () => {
    const agent = await store.createAgent({
      name: "A",
      type: "coding",
      modelConfigJson: JSON.stringify({ model: "gpt-4.1" }),
      systemPromptId: "system_generic_code",
      instructionsPromptId: "instructions_generic_code",
      enabled: true,
    });
    const p1 = await store.createProject({ name: "PLATFORM", type: "coding", agentId: agent.id });
    const t1 = await makeTaskForProject(store, p1.id);

    // Row predating the agent_events column: events live only in agent_result.
    insertRawCycle(dbPath, {
      taskId: t1,
      createdAtEpochSeconds: Math.floor(Date.now() / 1000),
      costUsd: null,
      costAiCredits: null,
      agentEvents: null,
      resultEvents: pricedResult(4).agentEvents,
    });

    const summary = await store.getCostSummary();
    expect(summary.totalRuns).toBe(1);
    expect(summary.totalAiCredits).toBeCloseTo(4, 6);
    expect(summary.totalUsd).toBeCloseTo(0.04, 6);
    expect(summary.perProject[0]?.projectId).toBe(p1.id);
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
    const p1 = await store.createProject({ name: "PLATFORM", type: "coding", agentId: agent.id });
    const t1 = await makeTaskForProject(store, p1.id);

    const nowSec = Math.floor(Date.now() / 1000);
    insertRawCycle(dbPath, { taskId: t1, createdAtEpochSeconds: nowSec, costUsd: 0.1, costAiCredits: 10, agentEvents: null });
    insertRawCycle(dbPath, {
      taskId: t1,
      createdAtEpochSeconds: nowSec - 60 * 24 * 60 * 60, // 60 days ago
      costUsd: 0.5,
      costAiCredits: 50,
      agentEvents: null,
    });

    const all = await store.getCostSummary();
    expect(all.totalRuns).toBe(2);
    expect(all.totalUsd).toBeCloseTo(0.6, 6);

    const recent = await store.getCostSummary({ since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) });
    expect(recent.totalRuns).toBe(1);
    expect(recent.totalUsd).toBeCloseTo(0.1, 6);
    expect(recent.sinceEpochSeconds).not.toBeNull();
  });

  it("returns an empty summary when there are no cycles", async () => {
    const summary = await store.getCostSummary();
    expect(summary.totalRuns).toBe(0);
    expect(summary.totalUsd).toBe(0);
    expect(summary.perProject).toEqual([]);
  });
});
