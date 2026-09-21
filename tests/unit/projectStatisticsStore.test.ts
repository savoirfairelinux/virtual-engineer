import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
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

function usageResult(
  credits: number,
  model: string,
  tokens?: { input: number; output: number; cached: number; cacheWrite: number },
): AgentResult {
  const usage: Record<string, unknown> = {
    apiCallId: `call-${randomUUID()}`,
    model,
    totalNanoAiu: credits * NANO_AIU_PER_CREDIT,
  };
  if (tokens) {
    usage["inputTokens"] = tokens.input;
    usage["outputTokens"] = tokens.output;
    usage["cacheReadTokens"] = tokens.cached;
    usage["cacheWriteTokens"] = tokens.cacheWrite;
  }
  const events: AgentLogEvent[] = [{
    type: "assistant.usage",
    timestamp: "2026-01-01T00:00:00.000Z",
    data: usage,
    taskId: "t",
    cycleNumber: 1,
  }];
  return {
    status: "success",
    summary: "ok",
    modifiedFiles: [],
    agentLogs: "",
    metadata: {},
    agentEvents: events,
  };
}

async function createTask(
  store: SqliteStateStore,
  projectId?: ProjectId,
): Promise<TaskId> {
  const taskId = makeTaskId(randomUUID());
  await store.createTask(taskId, makeTicketId(`TKT-${randomUUID()}`));
  if (projectId) await store.setTaskProjectId(taskId, projectId);
  return taskId;
}

async function completeTask(store: SqliteStateStore, taskId: TaskId): Promise<void> {
  await store.transition(taskId, "CONTEXT_BUILDING");
  await store.transition(taskId, "AGENT_RUNNING");
  await store.transition(taskId, "IN_REVIEW");
  await store.transition(taskId, "MERGED");
  await store.transition(taskId, "CLOSING");
  await store.transition(taskId, "DONE");
}

function retimeTask(
  dbPath: string,
  taskId: TaskId,
  createdAt: number,
  terminalAt?: number,
  terminalState: "DONE" | "FAILED" = "DONE",
): void {
  const db = new Database(dbPath);
  try {
    db.prepare("UPDATE tasks SET created_at = ?, updated_at = ? WHERE task_id = ?")
      .run(createdAt, createdAt, taskId);
    if (terminalAt !== undefined) {
      db.prepare("UPDATE state_transitions SET created_at = ? WHERE task_id = ? AND to_state = ?")
        .run(terminalAt, taskId, terminalState);
    }
  } finally {
    db.close();
  }
}

function retimeCycle(dbPath: string, taskId: TaskId, cycleNumber: number, createdAt: number): void {
  const db = new Database(dbPath);
  try {
    db.prepare("UPDATE agent_cycles SET created_at = ? WHERE task_id = ? AND cycle_number = ?")
      .run(createdAt, taskId, cycleNumber);
  } finally {
    db.close();
  }
}

describe("SqliteStateStore — getProjectStatistics", () => {
  let store: SqliteStateStore;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tempDatabasePath("ve-project-statistics");
    store = await SqliteStateStore.create(dbPath);
  });

  afterEach(() => {
    store.close();
  });

  it("aggregates the project, filters the period, and excludes other projects", async () => {
    const agent = await store.createAgent({
      name: "Statistics agent",
      type: "coding",
      modelConfigJson: JSON.stringify({ model: "gpt-4.1" }),
      systemPromptId: "system_generic_code",
      instructionsPromptId: "instructions_generic_code",
      enabled: true,
    });
    const project = await store.createProject({ name: "PLATFORM", type: "coding", agentId: agent.id });
    const otherProject = await store.createProject({ name: "MOBILE", type: "coding", agentId: agent.id });
    const now = Math.floor(Date.now() / 1000);
    const sevenDaysAgo = now - 7 * 24 * 60 * 60;

    const activeTask = await createTask(store, project.id);
    await store.transition(activeTask, "CONTEXT_BUILDING");
    await store.transition(activeTask, "AGENT_RUNNING");
    await store.saveAgentCycle(activeTask, 1, usageResult(2, "active-model"));
    retimeTask(dbPath, activeTask, now - 2 * 24 * 60 * 60);
    retimeCycle(dbPath, activeTask, 1, now - 60 * 60);

    const doneTask = await createTask(store, project.id);
    await completeTask(store, doneTask);
    await store.saveAgentCycle(
      doneTask,
      1,
      usageResult(1, "done-model", { input: 100, output: 40, cached: 20, cacheWrite: 5 }),
      { status: "passed", testOutput: "ok", lintOutput: "ok", durationMs: 100 },
    );
    await store.saveAgentCycle(
      doneTask,
      2,
      usageResult(3, "done-model"),
      { status: "failed", testOutput: "failed", lintOutput: "ok", durationMs: 200 },
    );
    retimeTask(dbPath, doneTask, now - 2 * 24 * 60 * 60, now - 24 * 60 * 60);
    retimeCycle(dbPath, doneTask, 1, now - 23 * 60 * 60);
    retimeCycle(dbPath, doneTask, 2, now - 22 * 60 * 60);

    const oldFailedTask = await createTask(store, project.id);
    await store.transition(oldFailedTask, "FAILED");
    await store.saveAgentCycle(oldFailedTask, 9, usageResult(20, "old-model"));
    retimeTask(dbPath, oldFailedTask, now - 40 * 24 * 60 * 60, now - 39 * 24 * 60 * 60, "FAILED");
    retimeCycle(dbPath, oldFailedTask, 9, now - 39 * 24 * 60 * 60);

    const otherProjectTask = await createTask(store, otherProject.id);
    await store.saveAgentCycle(otherProjectTask, 1, usageResult(50, "other-model"));

    const unassignedTask = await createTask(store);
    await store.saveAgentCycle(unassignedTask, 1, usageResult(60, "unassigned-model"));

    const statistics = await store.getProjectStatistics(project.id, {
      since: new Date(sevenDaysAgo * 1000),
    });

    expect(statistics.projectId).toBe(project.id);
    expect(statistics.sinceEpochSeconds).toBe(sevenDaysAgo);
    expect(statistics.current).toMatchObject({
      taskCount: 3,
      byBucket: { active: 1, watching: 0, done: 1, failed: 1 },
      byState: { AGENT_RUNNING: 1, DONE: 1, FAILED: 1 },
    });
    expect(statistics.period).toMatchObject({
      tasksCreated: 2,
      terminalTasks: 1,
      terminalByBucket: { active: 0, watching: 0, done: 1, failed: 0 },
    });
    expect(statistics.execution).toMatchObject({
      cycles: 3,
      tasksWithCycles: 2,
      retryTasks: 1,
      averageCyclesPerTask: 1.5,
      validation: { samples: 2, passed: 1, failed: 1, skipped: 0 },
    });
    expect(statistics.timing).toEqual({
      samples: 1,
      averageSeconds: 24 * 60 * 60,
      medianSeconds: 24 * 60 * 60,
    });
    expect(statistics.cost).toMatchObject({
      totalRuns: 3,
      totalUsd: expect.closeTo(0.06, 6),
      totalAiCredits: expect.closeTo(6, 6),
      totalTokens: { input: 100, output: 40, cached: 20, cacheWrite: 5 },
      totalRunsWithTokens: 1,
    });
    expect(statistics.cost.byBucket).toEqual(expect.arrayContaining([
      expect.objectContaining({ workflowBucket: "active", runCount: 1 }),
      expect.objectContaining({ workflowBucket: "done", runCount: 2 }),
    ]));
    expect(statistics.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: "active-model", workflowBucket: "active", runCount: 1 }),
      expect.objectContaining({ modelId: "done-model", workflowBucket: "done", runCount: 2 }),
    ]));
    expect(statistics.liveConcurrency).toBeNull();
  });

  it("returns measured zeroes and null averages for a project without activity", async () => {
    const agent = await store.createAgent({
      name: "Empty statistics agent",
      type: "coding",
      modelConfigJson: JSON.stringify({ model: "gpt-4.1" }),
      systemPromptId: "system_generic_code",
      instructionsPromptId: "instructions_generic_code",
      enabled: true,
    });
    const project = await store.createProject({ name: "EMPTY", type: "coding", agentId: agent.id });

    const statistics = await store.getProjectStatistics(project.id, {
      since: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });

    expect(statistics.current.taskCount).toBe(0);
    expect(statistics.period.tasksCreated).toBe(0);
    expect(statistics.execution.cycles).toBe(0);
    expect(statistics.execution.averageCyclesPerTask).toBeNull();
    expect(statistics.timing).toEqual({ samples: 0, averageSeconds: null, medianSeconds: null });
    expect(statistics.cost.totalRunsWithTokens).toBe(0);
    expect(statistics.cost.totalTokens).toEqual({ input: 0, output: 0, cached: 0, cacheWrite: 0 });
  });
});