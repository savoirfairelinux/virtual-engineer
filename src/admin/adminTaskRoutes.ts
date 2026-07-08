import { getLogger } from "../logger.js";
import { makeTaskId } from "../interfaces.js";
import type { AgentCycle, StateTransition, Task } from "../interfaces.js";
import { writeJson, toIsoTimestamp } from "./adminRouteUtils.js";
import { recordAudit, type AuditCapableStore } from "./adminAudit.js";
import type { Router } from "./router.js";

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
  auditStore?: AuditCapableStore | undefined;
  taskControl?: {
    resumeTask(taskId: ReturnType<typeof makeTaskId>): Promise<void>;
    retryTask(taskId: ReturnType<typeof makeTaskId>): Promise<void>;
  } | undefined;
}

/** Register task routes on the given router. */
export function registerTaskRoutes(router: Router, deps: TaskRouteDeps): void {
  router.add("GET", "/api/admin/tasks", async (_req, res, _params) => {
    const tasks = await deps.stateStore.getAllTasks();
    const deduplicated = deduplicateByTicket(tasks)
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
    const allChanges = await deps.stateStore.getChangesForTasks(deduplicated.map((t) => t.taskId));
    const cprReviewUrlByTaskId = new Map<string, string>();
    for (const c of allChanges) {
      if (c.reviewUrl && !cprReviewUrlByTaskId.has(c.taskId)) {
        cprReviewUrlByTaskId.set(c.taskId, c.reviewUrl);
      }
    }
    writeJson(res, 200, {
      tasks: deduplicated.map((t) => {
        const s = serializeTask(t);
        if (!s["reviewUrl"]) s["reviewUrl"] = cprReviewUrlByTaskId.get(t.taskId) ?? null;
        return s;
      }),
    });
  }, { permission: "task.read", collection: true });

  router.add("GET", "/api/admin/tasks/:id", async (_req, res, params) => {
    const taskId = makeTaskId(params["id"] ?? "");
    const task = await deps.stateStore.getTask(taskId);
    if (!task) { writeJson(res, 404, { error: "Task not found" }); return; }
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
    if (!serialized["reviewUrl"]) {
      const firstUrl = changesPerRepo.find((c) => c.reviewUrl)?.reviewUrl;
      if (firstUrl) serialized["reviewUrl"] = firstUrl;
    }
    writeJson(res, 200, { task: serialized });
  }, { permission: "task.read", resourceParam: "id" });

  router.add("DELETE", "/api/admin/tasks/:id", async (req, res, params) => {
    const taskId = makeTaskId(params["id"] ?? "");
    try {
      const taskToDelete = await deps.stateStore.getTask(taskId);
      if (!taskToDelete) { writeJson(res, 404, { error: "Task not found" }); return; }
      await deps.stateStore.deleteTaskGroup(taskId);
      recordAudit(deps.auditStore, req, { action: "task.delete", targetType: "task", targetId: taskId, details: { ticketId: taskToDelete.ticketId, state: taskToDelete.state } });
      writeJson(res, 200, { ok: true });
    } catch (err: unknown) {
      log.warn({ err }, "delete task failed");
      const msg = err instanceof Error ? err.message : "Operation failed";
      const status = msg.includes("non-terminal") ? 409 : 400;
      writeJson(res, status, { error: msg });
    }
  }, { permission: "task.delete", resourceParam: "id" });

  router.add("GET", "/api/admin/tasks/:id/cycles", async (_req, res, params) => {
    const taskId = makeTaskId(params["id"] ?? "");
    const task = await deps.stateStore.getTask(taskId);
    if (!task) { writeJson(res, 404, { error: "Task not found" }); return; }
    const cycles = await deps.stateStore.getAgentCycles(taskId);
    writeJson(res, 200, { cycles: cycles.map(serializeCycle) });
  }, { permission: "task.read", resourceParam: "id" });

  router.add("GET", "/api/admin/tasks/:id/transitions", async (_req, res, params) => {
    const taskId = makeTaskId(params["id"] ?? "");
    const task = await deps.stateStore.getTask(taskId);
    if (!task) { writeJson(res, 404, { error: "Task not found" }); return; }
    const transitions = await deps.stateStore.getStateTransitions(taskId);
    writeJson(res, 200, { transitions: transitions.map(serializeTransition) });
  }, { permission: "task.read", resourceParam: "id" });

  router.add("PATCH", "/api/admin/tasks/:id/pause", async (req, res, params) => {
    const taskId = makeTaskId(params["id"] ?? "");
    try {
      const task = await deps.stateStore.pauseTask(taskId);
      recordAudit(deps.auditStore, req, { action: "task.pause", targetType: "task", targetId: taskId, details: { ticketId: task.ticketId, state: task.state } });
      writeJson(res, 200, { task: serializeTask(task) });
    } catch (err: unknown) {
      log.warn({ err }, "pause task failed");
      writeJson(res, 400, { error: "Operation failed" });
    }
  }, { permission: "task.operate", resourceParam: "id" });

  router.add("PATCH", "/api/admin/tasks/:id/resume", async (req, res, params) => {
    const taskId = makeTaskId(params["id"] ?? "");
    try {
      const task = await deps.stateStore.resumeTask(taskId);
      void deps.taskControl?.resumeTask(taskId).catch((err: unknown) => {
        log.error({ err, taskId }, "resume task workflow trigger failed");
      });
      recordAudit(deps.auditStore, req, { action: "task.resume", targetType: "task", targetId: taskId, details: { ticketId: task.ticketId, state: task.state } });
      writeJson(res, 200, { task: serializeTask(task) });
    } catch (err: unknown) {
      log.warn({ err }, "resume task failed");
      writeJson(res, 400, { error: "Operation failed" });
    }
  }, { permission: "task.operate", resourceParam: "id" });

  router.add("POST", "/api/admin/tasks/:id/retry", async (req, res, params) => {
    const taskId = makeTaskId(params["id"] ?? "");
    try {
      const task = await deps.stateStore.retryTask(taskId);
      void deps.taskControl?.retryTask(taskId).catch((err: unknown) => {
        log.error({ err, taskId }, "retry task workflow trigger failed");
      });
      recordAudit(deps.auditStore, req, { action: "task.retry", targetType: "task", targetId: taskId, details: { ticketId: task.ticketId, state: task.state } });
      writeJson(res, 200, { task: serializeTask(task) });
    } catch (err: unknown) {
      log.warn({ err }, "retry task failed");
      writeJson(res, 400, { error: "Operation failed" });
    }
  }, { permission: "task.operate", resourceParam: "id" });

  router.add("POST", "/api/admin/tasks/:id/abandon", async (req, res, params) => {
    const taskId = makeTaskId(params["id"] ?? "");
    try {
      const task = await deps.stateStore.abandonTask(taskId);
      recordAudit(deps.auditStore, req, { action: "task.abandon", targetType: "task", targetId: taskId, details: { ticketId: task.ticketId, state: task.state } });
      writeJson(res, 200, { task: serializeTask(task) });
    } catch (err: unknown) {
      log.warn({ err }, "abandon task failed");
      writeJson(res, 400, { error: "Operation failed" });
    }
  }, { permission: "task.operate", resourceParam: "id" });
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
  const startMs = cycle.createdAt instanceof Date ? cycle.createdAt.getTime() : cycle.createdAt * 1000;
  const lastEvent = (cycle.result.agentEvents as Array<{ timestamp: string }> | undefined)?.at(-1);
  const endMs = lastEvent ? new Date(lastEvent.timestamp).getTime() : null;
  const durationMs = endMs !== null && endMs > startMs ? endMs - startMs : null;
  return {
    id: cycle.id,
    taskId: cycle.taskId,
    cycleNumber: cycle.cycleNumber,
    result: cycle.result,
    validationResult: cycle.validationResult,
    createdAt: toIsoTimestamp(cycle.createdAt),
    durationMs,
    cost: cycle.cost ?? null,
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
