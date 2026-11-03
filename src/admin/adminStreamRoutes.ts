import { makeTaskId } from "../interfaces.js";
import type { AgentCycle, AgentLogEvent, ProjectId, ProjectRecord, Task, TaskId } from "../interfaces.js";
import { agentLogBus, getTaskEventBuffer } from "../agents/agentEventBus.js";
import { writeJson } from "./adminRouteUtils.js";
import {
  readLastEventId,
  selectLogStreamReplay,
  serializeAgentEventEntry,
  streamEntryId,
  streamEntryKey,
  type LogStreamEntry,
  type LogStreamReplay,
} from "./logStreamReplay.js";
import { createTaskPermissionResolver, createTaskProjectNameResolver, deduplicateByTicket, filterTasksByReadAccess, filterTasksByReadScope } from "./adminTaskRoutes.js";
import { getEffectivePermissions } from "./authContext.js";
import { requestCanAccessResource } from "./authContext.js";
import { can } from "./authorization/policyEngine.js";
import type { Router } from "./router.js";

/** Subset of state-store methods required by the stream routes. */
export interface StreamRouteStore {
  getTask(id: ReturnType<typeof makeTaskId>): Promise<Task | null>;
  getAgentCycles(taskId: ReturnType<typeof makeTaskId>): Promise<AgentCycle[]>;
  getAllTasks(): Promise<Task[]>;
}

export interface StreamRouteDeps {
  stateStore: StreamRouteStore;
  projectStore?: { getProjectById(id: ProjectId): Promise<ProjectRecord | null> } | undefined;
  isTaskWaiting?: ((taskId: TaskId) => boolean) | undefined;
}

async function canReadTask(req: import("node:http").IncomingMessage, task: Task, deps: StreamRouteDeps): Promise<boolean> {
  const perms = getEffectivePermissions(req);
  if (!perms) return false;
  if (task.projectId == null) return can(perms, "task.read");
  const project = await deps.projectStore?.getProjectById(task.projectId);
  if (!project) return can(perms, "task.read", task.projectId);
  return requestCanAccessResource(req, "task.read", {
    type: "task",
    id: task.taskId,
    projectId: task.projectId,
    ownerUserId: project.ownerUserId ?? null,
  });
}

/** Register SSE stream routes on the given router. */
export function registerStreamRoutes(router: Router, deps: StreamRouteDeps): void {
  router.add("GET", "/api/admin/logs/stream", async (req, res, _params) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const taskIdParam = requestUrl.searchParams.get("taskId");
    let replay: LogStreamReplay | null = null;
    const pendingLiveEvents: AgentLogEvent[] = [];
    let writeLiveEvent: ((event: AgentLogEvent) => void) | null = null;
    let authorizationQueue = Promise.resolve();
    const taskAccess = new Map<string, boolean>();
    let closed = false;
    let heartbeatLogs: ReturnType<typeof setInterval> | undefined;
    const cleanup = (): void => {
      closed = true;
      agentLogBus.off("event", eventListener);
      taskAccess.clear();
      if (heartbeatLogs !== undefined) clearInterval(heartbeatLogs);
    };
    const eventListener = (event: AgentLogEvent): void => {
      if (closed) return;
      if (taskIdParam) {
        if (event.taskId !== taskIdParam) return;
        if (writeLiveEvent) {
          writeLiveEvent(event);
        } else {
          if (pendingLiveEvents.length >= 500) pendingLiveEvents.shift();
          pendingLiveEvents.push(event);
        }
        return;
      }

      authorizationQueue = authorizationQueue.then(async () => {
        if (!res.writable) return;
        let allowed = taskAccess.get(event.taskId);
        if (allowed === undefined) {
          const task = await deps.stateStore.getTask(makeTaskId(event.taskId));
          allowed = task ? await canReadTask(req, task, deps) : false;
          taskAccess.set(event.taskId, allowed);
        }
        if (!allowed) return;
        writeLiveEvent?.(event);
      }).catch(() => undefined);
    };
    res.once("close", cleanup);

    if (taskIdParam) {
      const taskId = makeTaskId(taskIdParam);
      const task = await deps.stateStore.getTask(taskId);
      if (closed) return;
      if (!task) {
        writeJson(res, 404, { error: "Task not found" });
        return;
      }

      // Enforce project-scoped task.read: streaming a task's logs must respect
      // the caller's scope (agent logs can contain cross-project source/secrets).
      if (!await canReadTask(req, task, deps)) {
        writeJson(res, 403, { error: "forbidden", permission: "task.read" });
        return;
      }

      agentLogBus.on("event", eventListener);
      let cycles: AgentCycle[];
      try {
        cycles = await deps.stateStore.getAgentCycles(taskId);
      } catch (err) {
        cleanup();
        throw err;
      }
      if (closed) return;
      // Bounded newest-first replay, read synchronously with the live buffer so
      // no event can slip between the replay and the live listener below.
      replay = selectLogStreamReplay(
        cycles,
        getTaskEventBuffer(taskIdParam),
        readLastEventId(req.headers["last-event-id"]),
      );
    }

    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.socket?.setNoDelay(true);
    res.flushHeaders();

    // Deduplicate the replayed backlog without letting a long-lived global
    // stream retain every key it has ever emitted.
    const MAX_EMITTED_KEYS = 5_000;
    const emittedKeys = new Set<string>();
    const writeEntry = (entry: LogStreamEntry, key = streamEntryKey(entry), id?: string): void => {
      if (emittedKeys.has(key)) return;
      if (emittedKeys.size >= MAX_EMITTED_KEYS) {
        const oldest = emittedKeys.values().next().value;
        if (oldest !== undefined) emittedKeys.delete(oldest);
      }
      emittedKeys.add(key);
      res.write(`${id === undefined ? "" : `id: ${id}\n`}data: ${JSON.stringify(entry)}\n\n`);
    };

    writeEntry({
      timestamp: new Date().toISOString(),
      taskId: taskIdParam,
      level: "info",
      message: "Live log stream connected",
      source: "admin",
      type: "stream.connected",
      ...(replay ? { data: replay.summary } : {}),
    });

    if (replay) {
      for (const { entry, key, id } of replay.entries) writeEntry(entry, key, id);
    } else {
      writeEntry({ timestamp: new Date().toISOString(), taskId: null, level: "info", message: "Admin API stream started", source: "admin" });
      writeEntry({ timestamp: new Date().toISOString(), taskId: null, level: "info", message: "Listening for live logs...", source: "admin" });
    }

    writeLiveEvent = (event: AgentLogEvent): void => {
      if (!res.writable) return;
      const entry = serializeAgentEventEntry(event);
      const key = streamEntryKey(entry);
      // Task streams tag entries with ids so a reconnect can resume after them.
      writeEntry(entry, key, taskIdParam ? streamEntryId(key) : undefined);
    };
    for (const event of pendingLiveEvents) {
      writeLiveEvent(event);
    }
    pendingLiveEvents.length = 0;
    if (!taskIdParam) agentLogBus.on("event", eventListener);

    heartbeatLogs = setInterval(() => {
      if (!res.writable) { clearInterval(heartbeatLogs); return; }
      res.write(": heartbeat\n\n");
    }, 15_000);
    // Do NOT call res.end() — keep connection open
  }, { permission: "task.read", collection: true });

  router.add("GET", "/api/admin/events/stream", async (req, res, _params) => {
    let closed = false;
    let taskTimer: ReturnType<typeof setInterval> | undefined;
    let heartbeatGlobal: ReturnType<typeof setInterval> | undefined;
    const cleanup = (): void => {
      closed = true;
      if (taskTimer !== undefined) clearInterval(taskTimer);
      if (heartbeatGlobal !== undefined) clearInterval(heartbeatGlobal);
    };
    res.once("close", cleanup);
    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.flushHeaders();

    const sendTasks = async (): Promise<void> => {
      if (closed || !res.writable) return;
      try {
        const allTasks = await deps.stateStore.getAllTasks();
        if (closed || !res.writable) return;
        const candidates = deduplicateByTicket(allTasks);
        const visible = deps.projectStore
          ? await filterTasksByReadAccess(req, candidates, deps.projectStore)
          : filterTasksByReadScope(req, candidates);
        const sorted = visible
          .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
        const resolvePermissions = createTaskPermissionResolver(req, deps.projectStore);
        const resolveProjectName = createTaskProjectNameResolver(deps.projectStore);
        const serialized = await Promise.all(sorted.map(async (task) => ({
          ...task,
          waitingForAgentSlot: deps.isTaskWaiting?.(task.taskId) ?? false,
          permissions: await resolvePermissions(task),
          projectName: await resolveProjectName(task),
        })));
        if (closed || !res.writable) return;
        res.write(`event: tasks\ndata: ${JSON.stringify(serialized)}\n\n`);
      } catch { /* ignore */ }
    };

    await sendTasks();
    if (closed) return;

    taskTimer = setInterval(() => void sendTasks(), 5_000);

    heartbeatGlobal = setInterval(() => {
      if (!res.writable) { clearInterval(heartbeatGlobal); return; }
      res.write(": heartbeat\n\n");
    }, 15_000);
  }, { permission: "task.read", collection: true });
}
