import type { IncomingMessage, ServerResponse } from "node:http";
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
import { deduplicateByTicket } from "./adminTaskRoutes.js";
import { clearRequestAuthorization, getEffectivePermissions, requestCanAccessResource, setEffectivePermissions } from "./authContext.js";
import { ALL_RESOURCES, can, hasPotentialResourceAccess, type EffectivePermissions } from "./authorization/policyEngine.js";
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
  refreshAuthorization(req: IncomingMessage): Promise<EffectivePermissions | null>;
}

function canAccessTask(req: IncomingMessage, permission: "task.read" | "task.operate" | "task.delete", task: Task, project: ProjectRecord | null | undefined): boolean {
  const perms = getEffectivePermissions(req);
  if (!perms) return false;
  if (!project) return can(perms, permission, task.projectId);
  return requestCanAccessResource(req, permission, {
    type: "task",
    id: task.taskId,
    projectId: task.projectId ?? null,
    ownerUserId: project.ownerUserId ?? null,
  });
}

function retainsReadScope(previous: EffectivePermissions, current: EffectivePermissions): boolean {
  const permission = "task.read";
  if (can(current, permission)) return true;
  if (can(previous, permission)) return false;
  const previousScope = previous.grants.get(permission);
  if (previousScope && previousScope !== ALL_RESOURCES &&
      [...previousScope].some((id) => !can(current, permission, id))) return false;
  if (previous.resourceOwnerGrants.has(permission) && !current.resourceOwnerGrants.has(permission)) return false;
  if (previous.registeredUserGrants.has(permission) && !current.registeredUserGrants.has(permission)) return false;
  if (previous.projectOwnerGrants.has(permission)) {
    const delegated = previous.grants.get("project.owner");
    if (delegated === ALL_RESOURCES) {
      return current.projectOwnerGrants.has(permission) && can(current, "project.owner");
    }
    if (delegated && [...delegated].some((id) =>
      !can(current, permission, id) &&
      !(current.projectOwnerGrants.has(permission) && can(current, "project.owner", id)))) return false;
  }
  return true;
}

interface StreamGuard {
  isOpen(): boolean;
  stop(): void;
  refresh(): Promise<boolean>;
}

function streamGuard(req: IncomingMessage, res: ServerResponse, deps: StreamRouteDeps, collection: boolean, cleanup: () => void): StreamGuard {
  let closed = false;
  let checkId = 0;
  let appliedCheckId = 0;
  const dispose = (): void => {
    if (closed) return;
    closed = true;
    clearRequestAuthorization(req);
    cleanup();
  };
  res.once("close", dispose);
  const stop = (): void => {
    if (closed) return;
    dispose();
    if (res.writable) res.end();
  };
  const isOpen = (): boolean => !closed && res.writable;
  return {
    isOpen,
    stop,
    async refresh(): Promise<boolean> {
      if (!isOpen()) return false;
      const id = ++checkId;
      try {
        const current = await deps.refreshAuthorization(req);
        if (!isOpen()) return false;
        const previous = getEffectivePermissions(req);
        if (!current || !hasPotentialResourceAccess(current, "task.read") ||
            (collection && previous && !retainsReadScope(previous, current))) {
          stop();
          return false;
        }
        // A slower, overlapping check must not overwrite a newer decision.
        if (id < appliedCheckId) return false;
        appliedCheckId = id;
        setEffectivePermissions(req, current);
        return true;
      } catch {
        stop();
        return false;
      }
    },
  };
}

async function loadProjects(tasks: readonly Task[], deps: StreamRouteDeps): Promise<Map<ProjectId, ProjectRecord | null | undefined>> {
  const ids = new Set(tasks.flatMap((task) => task.projectId == null ? [] : [task.projectId]));
  return new Map(await Promise.all([...ids].map(async (id) => [id, await deps.projectStore?.getProjectById(id)] as const)));
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
    // Track delivered resources only to detect loss of access, never to authorize writes.
    const observedTasks = new Set<TaskId>();
    let checkingIdle = false;
    let heartbeatLogs: ReturnType<typeof setInterval> | undefined;
    const guard = streamGuard(req, res, deps, !taskIdParam, () => {
      agentLogBus.off("event", eventListener);
      pendingLiveEvents.length = 0;
      observedTasks.clear();
      if (heartbeatLogs !== undefined) clearInterval(heartbeatLogs);
    });

    const authorizeTask = async (id: TaskId, closeOnDenial: boolean): Promise<boolean> => {
      const task = await deps.stateStore.getTask(id);
      const project = task?.projectId == null ? undefined : await deps.projectStore?.getProjectById(task.projectId);
      if (!await guard.refresh()) return false;
      if (task && canAccessTask(req, "task.read", task, project)) return true;
      if (closeOnDenial) guard.stop();
      return false;
    };

    const eventListener = (event: AgentLogEvent): void => {
      if (!guard.isOpen() || (taskIdParam && event.taskId !== taskIdParam)) return;
      if (!writeLiveEvent) {
        if (pendingLiveEvents.length >= 500) pendingLiveEvents.shift();
        pendingLiveEvents.push(event);
        return;
      }

      authorizationQueue = authorizationQueue.then(async () => {
        if (!guard.isOpen()) return;
        const id = makeTaskId(event.taskId);
        if (await authorizeTask(id, !!taskIdParam || observedTasks.has(id)) && guard.isOpen()) {
          if (!taskIdParam) observedTasks.add(id);
          writeLiveEvent?.(event);
        }
      }).catch(() => guard.stop());
    };

    if (taskIdParam) {
      const taskId = makeTaskId(taskIdParam);
      const task = await deps.stateStore.getTask(taskId);
      if (!guard.isOpen()) return;
      if (!task) {
        writeJson(res, 404, { error: "Task not found" });
        return;
      }

      // Enforce project-scoped task.read: streaming a task's logs must respect
      // the caller's scope (agent logs can contain cross-project source/secrets).
      const project = task.projectId == null ? undefined : await deps.projectStore?.getProjectById(task.projectId);
      if (!await guard.refresh()) return;
      if (!canAccessTask(req, "task.read", task, project)) {
        writeJson(res, 403, { error: "forbidden", permission: "task.read" });
        return;
      }

      agentLogBus.on("event", eventListener);
      let cycles: AgentCycle[];
      try {
        cycles = await deps.stateStore.getAgentCycles(taskId);
      } catch (err) {
        if (!guard.isOpen()) return;
        // Let the request error handler return its normal pre-stream 500.
        agentLogBus.off("event", eventListener);
        throw err;
      }
      if (!guard.isOpen() || !await authorizeTask(taskId, true) || !guard.isOpen()) return;
      // Bounded newest-first replay, read synchronously with the live buffer so
      // no event can slip between the replay and the live listener below.
      replay = selectLogStreamReplay(
        cycles,
        getTaskEventBuffer(taskIdParam),
        readLastEventId(req.headers["last-event-id"]),
      );
    } else if (!await guard.refresh()) return;
    if (!guard.isOpen()) return;

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
      if (!guard.isOpen()) return;
      const entry = serializeAgentEventEntry(event);
      const key = streamEntryKey(entry);
      // Task streams tag entries with ids so a reconnect can resume after them.
      writeEntry(entry, key, taskIdParam ? streamEntryId(key) : undefined);
    };
    for (const event of pendingLiveEvents) {
      eventListener(event);
    }
    pendingLiveEvents.length = 0;
    if (!taskIdParam) agentLogBus.on("event", eventListener);

    const heartbeat = async (): Promise<void> => {
      if (!guard.isOpen() || checkingIdle) return;
      checkingIdle = true;
      try {
        if (taskIdParam) {
          if (!await authorizeTask(makeTaskId(taskIdParam), true)) return;
        } else {
          const checkedTasks = new Set(observedTasks);
          const tasks = checkedTasks.size
            ? (await deps.stateStore.getAllTasks()).filter((task) => checkedTasks.has(task.taskId))
            : [];
          const projects = await loadProjects(tasks, deps);
          if (!await guard.refresh()) return;
          if (tasks.some((task) => !canAccessTask(req, "task.read", task, task.projectId == null ? undefined : projects.get(task.projectId)))) {
            guard.stop();
            return;
          }
          const present = new Set(tasks.map((task) => task.taskId));
          // Don't prune tasks first observed while this heartbeat was awaiting storage.
          for (const id of checkedTasks) if (!present.has(id)) observedTasks.delete(id);
        }
        if (guard.isOpen()) res.write(": heartbeat\n\n");
      } catch {
        guard.stop();
      } finally {
        checkingIdle = false;
      }
    };
    heartbeatLogs = setInterval(() => void heartbeat(), 15_000);
  }, { permission: "task.read", collection: true });

  router.add("GET", "/api/admin/events/stream", async (req, res, _params) => {
    let sending = false;
    let previousVisible = new Set<TaskId>();
    let taskTimer: ReturnType<typeof setInterval> | undefined;
    let heartbeatGlobal: ReturnType<typeof setInterval> | undefined;
    const guard = streamGuard(req, res, deps, true, () => {
      previousVisible.clear();
      if (taskTimer !== undefined) clearInterval(taskTimer);
      if (heartbeatGlobal !== undefined) clearInterval(heartbeatGlobal);
    });
    if (!await guard.refresh() || !guard.isOpen()) return;
    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.flushHeaders();

    const sendTasks = async (): Promise<void> => {
      if (!guard.isOpen() || sending) return;
      sending = true;
      try {
        const allTasks = await deps.stateStore.getAllTasks();
        const projects = await loadProjects(allTasks, deps);
        if (!await guard.refresh() || !guard.isOpen()) return;
        const projectFor = (task: Task): ProjectRecord | null | undefined =>
          task.projectId == null ? undefined : projects.get(task.projectId);
        const canRead = (task: Task): boolean => canAccessTask(req, "task.read", task, projectFor(task));
        if (allTasks.some((task) => previousVisible.has(task.taskId) && !canRead(task))) {
          guard.stop();
          return;
        }
        const visible = deduplicateByTicket(allTasks).filter(canRead)
          .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
        const serialized = visible.map((task) => {
          const project = projectFor(task);
          return {
            ...task,
            waitingForAgentSlot: deps.isTaskWaiting?.(task.taskId) ?? false,
            permissions: {
              operate: canAccessTask(req, "task.operate", task, project),
              delete: canAccessTask(req, "task.delete", task, project),
            },
            projectName: project?.name ?? null,
          };
        });
        previousVisible = new Set(visible.map((task) => task.taskId));
        res.write(`event: tasks\ndata: ${JSON.stringify(serialized)}\n\n`);
      } catch {
        guard.stop();
      } finally {
        sending = false;
      }
    };

    taskTimer = setInterval(() => void sendTasks(), 5_000);
    heartbeatGlobal = setInterval(() => {
      void guard.refresh().then((allowed) => {
        if (allowed && guard.isOpen()) res.write(": heartbeat\n\n");
      });
    }, 15_000);
    await sendTasks();
  }, { permission: "task.read", collection: true });
}
