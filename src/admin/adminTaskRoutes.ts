import type { IncomingMessage, ServerResponse } from "node:http";
import { getLogger } from "../logger.js";
import { makeTaskId } from "../interfaces.js";
import type { AgentCycle, StateTransition, Task } from "../interfaces.js";
import { writeJson, toIsoTimestamp } from "./adminRouteUtils.js";

const log = getLogger("admin-tasks");

/** Subset of state-store methods required by the task routes. */
export interface TaskRouteStore {
  getAllTasks(): Promise<Task[]>;
  getTask(id: ReturnType<typeof makeTaskId>): Promise<Task | null>;
  getAgentCycles(taskId: ReturnType<typeof makeTaskId>): Promise<AgentCycle[]>;
  getStateTransitions(taskId: ReturnType<typeof makeTaskId>): Promise<StateTransition[]>;
  getChangesForTask(taskId: ReturnType<typeof makeTaskId>): Promise<import("../interfaces.js").ChangePerRepository[]>;
  getChangesForTasks(taskIds: ReturnType<typeof makeTaskId>[]): Promise<import("../interfaces.js").ChangePerRepository[]>;
  pauseTask(taskId: ReturnType<typeof makeTaskId>): Promise<Task>;
  resumeTask(taskId: ReturnType<typeof makeTaskId>): Promise<Task>;
  retryTask(taskId: ReturnType<typeof makeTaskId>): Promise<Task>;
  abandonTask(taskId: ReturnType<typeof makeTaskId>): Promise<Task>;
  deleteTask(taskId: ReturnType<typeof makeTaskId>): Promise<void>;
  deleteTaskGroup(taskId: ReturnType<typeof makeTaskId>): Promise<void>;
}

export interface TaskRouteDeps {
  stateStore: TaskRouteStore;
  taskControl?: {
    resumeTask(taskId: ReturnType<typeof makeTaskId>): Promise<void>;
    retryTask(taskId: ReturnType<typeof makeTaskId>): Promise<void>;
  } | undefined;
}

/**
 * Try to handle a task-route request. Returns true if the request was
 * handled (response sent), false otherwise.
 */
export async function handleTasksRoute(
  _request: IncomingMessage,
  response: ServerResponse,
  path: string,
  method: string,
  deps: TaskRouteDeps,
): Promise<boolean> {
  if (path === "/api/admin/tasks") {
    if (method !== "GET") {
      writeJson(response, 405, { error: "Method not allowed" });
      return true;
    }
    const tasks = await deps.stateStore.getAllTasks();
    const deduplicated = deduplicateByTicket(tasks)
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
    // Augment each task with a fallback reviewUrl from change_per_repository (one batch query)
    const allChanges = await deps.stateStore.getChangesForTasks(deduplicated.map((t) => t.taskId));
    const cprReviewUrlByTaskId = new Map<string, string>();
    for (const c of allChanges) {
      if (c.reviewUrl && !cprReviewUrlByTaskId.has(c.taskId)) {
        cprReviewUrlByTaskId.set(c.taskId, c.reviewUrl);
      }
    }
    writeJson(response, 200, {
      tasks: deduplicated.map((t) => {
        const s = serializeTask(t);
        if (!s["reviewUrl"]) s["reviewUrl"] = cprReviewUrlByTaskId.get(t.taskId) ?? null;
        return s;
      }),
    });
    return true;
  }

  const taskMatch = /^\/api\/admin\/tasks\/([^/]+)$/.exec(path);
  if (taskMatch) {
    if (method === "DELETE") {
      const taskId = makeTaskId(decodeURIComponent(taskMatch[1] ?? ""));
      try {
        const taskToDelete = await deps.stateStore.getTask(taskId);
        if (!taskToDelete) {
          writeJson(response, 404, { error: "Task not found" });
          return true;
        }
        await deps.stateStore.deleteTaskGroup(taskId);
        writeJson(response, 200, { ok: true });
      } catch (err: unknown) {
        log.warn({ err }, "delete task failed");
        const msg = err instanceof Error ? err.message : "Operation failed";
        const status = msg.includes("non-terminal") ? 409 : 400;
        writeJson(response, status, { error: msg });
      }
      return true;
    }
    if (method !== "GET") {
      writeJson(response, 405, { error: "Method not allowed" });
      return true;
    }
    const taskId = makeTaskId(decodeURIComponent(taskMatch[1] ?? ""));
    const task = await deps.stateStore.getTask(taskId);
    if (!task) {
      writeJson(response, 404, { error: "Task not found" });
      return true;
    }
    const changesPerRepo = await deps.stateStore.getChangesForTask(taskId);
    const serialized = serializeTask(task) as Record<string, unknown>;
    serialized["changesPerRepo"] = changesPerRepo.map((c) => ({
      repoKey: c.repoKey,
      changeId: c.changeId,
      reviewUrl: c.reviewUrl,
      status: c.status,
      reviewSystem: c.reviewSystem,
      commitIndex: c.commitIndex,
      subjectHash: c.subjectHash,
    }));
    // Populate fallback reviewUrl from CPR when the task-level URL is not set
    if (!serialized["reviewUrl"]) {
      const firstUrl = changesPerRepo.find((c) => c.reviewUrl)?.reviewUrl;
      if (firstUrl) serialized["reviewUrl"] = firstUrl;
    }
    writeJson(response, 200, { task: serialized });
    return true;
  }

  const cyclesMatch = /^\/api\/admin\/tasks\/([^/]+)\/cycles$/.exec(path);
  if (cyclesMatch) {
    if (method !== "GET") {
      writeJson(response, 405, { error: "Method not allowed" });
      return true;
    }
    const taskId = makeTaskId(decodeURIComponent(cyclesMatch[1] ?? ""));
    const task = await deps.stateStore.getTask(taskId);
    if (!task) {
      writeJson(response, 404, { error: "Task not found" });
      return true;
    }
    const cycles = await deps.stateStore.getAgentCycles(taskId);
    writeJson(response, 200, { cycles: cycles.map(serializeCycle) });
    return true;
  }

  const transitionsMatch = /^\/api\/admin\/tasks\/([^/]+)\/transitions$/.exec(path);
  if (transitionsMatch) {
    if (method !== "GET") {
      writeJson(response, 405, { error: "Method not allowed" });
      return true;
    }
    const taskId = makeTaskId(decodeURIComponent(transitionsMatch[1] ?? ""));
    const task = await deps.stateStore.getTask(taskId);
    if (!task) {
      writeJson(response, 404, { error: "Task not found" });
      return true;
    }
    const transitions = await deps.stateStore.getStateTransitions(taskId);
    writeJson(response, 200, { transitions: transitions.map(serializeTransition) });
    return true;
  }

  const pauseMatch = /^\/api\/admin\/tasks\/([^/]+)\/pause$/.exec(path);
  if (pauseMatch && method === "PATCH") {
    const taskId = makeTaskId(decodeURIComponent(pauseMatch[1] ?? ""));
    try {
      const task = await deps.stateStore.pauseTask(taskId);
      writeJson(response, 200, { task: serializeTask(task) });
    } catch (err: unknown) {
      log.warn({ err }, "pause task failed");
      writeJson(response, 400, { error: "Operation failed" });
    }
    return true;
  }

  const resumeMatch = /^\/api\/admin\/tasks\/([^/]+)\/resume$/.exec(path);
  if (resumeMatch && method === "PATCH") {
    const taskId = makeTaskId(decodeURIComponent(resumeMatch[1] ?? ""));
    try {
      const task = await deps.stateStore.resumeTask(taskId);
      void deps.taskControl?.resumeTask(taskId).catch((err: unknown) => {
        log.error({ err, taskId }, "resume task workflow trigger failed");
      });
      writeJson(response, 200, { task: serializeTask(task) });
    } catch (err: unknown) {
      log.warn({ err }, "resume task failed");
      writeJson(response, 400, { error: "Operation failed" });
    }
    return true;
  }

  const retryMatch = /^\/api\/admin\/tasks\/([^/]+)\/retry$/.exec(path);
  if (retryMatch && method === "POST") {
    const taskId = makeTaskId(decodeURIComponent(retryMatch[1] ?? ""));
    try {
      const task = await deps.stateStore.retryTask(taskId);
      void deps.taskControl?.retryTask(taskId).catch((err: unknown) => {
        log.error({ err, taskId }, "retry task workflow trigger failed");
      });
      writeJson(response, 200, { task: serializeTask(task) });
    } catch (err: unknown) {
      log.warn({ err }, "retry task failed");
      writeJson(response, 400, { error: "Operation failed" });
    }
    return true;
  }

  const abandonMatch = /^\/api\/admin\/tasks\/([^/]+)\/abandon$/.exec(path);
  if (abandonMatch && method === "POST") {
    const taskId = makeTaskId(decodeURIComponent(abandonMatch[1] ?? ""));
    try {
      const task = await deps.stateStore.abandonTask(taskId);
      writeJson(response, 200, { task: serializeTask(task) });
    } catch (err: unknown) {
      log.warn({ err }, "abandon task failed");
      writeJson(response, 400, { error: "Operation failed" });
    }
    return true;
  }

  return false;
}

// ─── Serializers & helpers (exported for SSE streams & events route) ────────

/** Returns true if task b is a strictly newer candidate than task a. */
function pickLatest(a: Task | undefined, b: Task): boolean {
  if (!a) return true;
  if (b.updatedAt.getTime() > a.updatedAt.getTime()) return true;
  if (b.updatedAt.getTime() === a.updatedAt.getTime() && b.createdAt.getTime() > a.createdAt.getTime()) return true;
  return false;
}

/** Deduplicate tasks, keeping the most-recent per ticketId and per externalChangeId. */
export function deduplicateByTicket(tasks: Task[]): Task[] {
  const byTicket = new Map<string, Task>();
  for (const task of tasks) {
    if (pickLatest(byTicket.get(task.ticketId), task)) {
      byTicket.set(task.ticketId, task);
    }
  }

  const byChangeId = new Map<string, Task>();
  for (const task of byTicket.values()) {
    if (!task.externalChangeId) continue;
    if (pickLatest(byChangeId.get(task.externalChangeId), task)) {
      byChangeId.set(task.externalChangeId, task);
    }
  }

  return Array.from(byTicket.values()).filter((task) => {
    if (task.externalChangeId) {
      return byChangeId.get(task.externalChangeId) === task;
    }
    return true;
  });
}

/** Serialize a Task to the admin API response shape. */
export function serializeTask(task: Task): Record<string, unknown> {
  return {
    taskId: task.taskId,
    taskType: task.taskType,
    ticketId: task.ticketId,
    ticketSourceLabel: task.ticketSourceLabel,
    ticketTitle: task.ticketTitle,
    ticketDescription: task.ticketDescription,
    state: task.state,
    gerritChangeId: task.externalChangeId,
    currentPatchset: task.currentPatchset,
    reviewedPatchset: task.reviewedPatchset,
    cycleCount: task.cycleCount,
    failureReason: task.failureReason,
    ticketUrl: task.ticketUrl,
    reviewUrl: task.reviewUrl,
    displayId: task.displayId ?? task.ticketId,
    createdAt: toIsoTimestamp(task.createdAt),
    updatedAt: toIsoTimestamp(task.updatedAt),
  };
}

/** Serialize an AgentCycle to the admin API response shape. */
export function serializeCycle(cycle: AgentCycle): Record<string, unknown> {
  return {
    id: cycle.id,
    taskId: cycle.taskId,
    cycleNumber: cycle.cycleNumber,
    result: cycle.result,
    validationResult: cycle.validationResult,
    createdAt: toIsoTimestamp(cycle.createdAt),
  };
}

/** Serialize a StateTransition to the admin API response shape. */
export function serializeTransition(transition: StateTransition): Record<string, unknown> {
  return {
    id: transition.id,
    taskId: transition.taskId,
    fromState: transition.fromState,
    toState: transition.toState,
    metadata: transition.metadata,
    createdAt: toIsoTimestamp(transition.createdAt),
  };
}
