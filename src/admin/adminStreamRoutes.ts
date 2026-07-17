import { makeTaskId } from "../interfaces.js";
import type { AgentCycle, AgentLogEvent, Task } from "../interfaces.js";
import { agentLogBus, getTaskEventBuffer } from "../agents/agentEventBus.js";
import { normalizeAgentEvent } from "../agents/agentEventTypes.js";
import { writeJson, toIsoTimestamp } from "./adminRouteUtils.js";
import { deduplicateByTicket, filterTasksByReadScope } from "./adminTaskRoutes.js";
import { getEffectivePermissions } from "./authContext.js";
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
}

/** Register SSE stream routes on the given router. */
export function registerStreamRoutes(router: Router, deps: StreamRouteDeps): void {
  router.add("GET", "/api/admin/logs/stream", async (req, res, _params) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const taskIdParam = requestUrl.searchParams.get("taskId");
    let streamEntries: Array<Record<string, unknown>> = [];
    const pendingLiveEvents: AgentLogEvent[] = [];
    let writeLiveEvent: ((event: AgentLogEvent) => void) | null = null;
    let authorizationQueue = Promise.resolve();
    const taskProjects = new Map<string, Task["projectId"] | null>();
    let closed = false;
    let heartbeatLogs: ReturnType<typeof setInterval> | undefined;
    const cleanup = (): void => {
      closed = true;
      agentLogBus.off("event", eventListener);
      taskProjects.clear();
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
        let projectId = taskProjects.get(event.taskId);
        if (projectId === undefined) {
          const task = await deps.stateStore.getTask(makeTaskId(event.taskId));
          projectId = task?.projectId ?? null;
          taskProjects.set(event.taskId, projectId);
        }
        if (projectId === null) return;
        const perms = getEffectivePermissions(req);
        if (perms && !can(perms, "task.read", projectId)) return;
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
      const perms = getEffectivePermissions(req);
      if (perms && !can(perms, "task.read", task.projectId)) {
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
      streamEntries = cycles.flatMap((cycle) => serializeAgentLogEntries(cycle));
    } else {
      streamEntries = [
        { timestamp: new Date().toISOString(), taskId: null, level: "info", message: "Admin API stream started", source: "admin" },
        { timestamp: new Date().toISOString(), taskId: null, level: "info", message: "Listening for live logs...", source: "admin" },
      ];
    }

    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.socket?.setNoDelay(true);
    res.flushHeaders();

    const emittedKeys = new Set<string>();
    const writeEntry = (entry: Record<string, unknown>): void => {
      const key = streamEntryKey(entry);
      if (emittedKeys.has(key)) return;
      emittedKeys.add(key);
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    };

    writeEntry({
      timestamp: new Date().toISOString(),
      taskId: taskIdParam,
      level: "info",
      message: "Live log stream connected",
      source: "admin",
      type: "stream.connected",
    });

    for (const entry of streamEntries) {
      writeEntry(entry);
    }

    if (taskIdParam) {
      const buffered = getTaskEventBuffer(taskIdParam);
      for (const event of buffered) {
        if (res.writable) {
          writeEntry(serializeAgentEventEntry(event));
        }
      }
    }

    writeLiveEvent = (event: AgentLogEvent): void => {
      if (!res.writable) return;
      writeEntry(serializeAgentEventEntry(event));
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
        const sorted = filterTasksByReadScope(req, deduplicateByTicket(allTasks))
          .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
        res.write(`event: tasks\ndata: ${JSON.stringify(sorted)}\n\n`);
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

// ─── Serializers ────────────────────────────────────────────────────────────

/** Serialize all log entries for an agent cycle into the admin log-stream shape. */
function serializeAgentLogEntries(cycle: AgentCycle): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  const rawLogs = cycle.result.agentLogs.trim();

  if (rawLogs.length > 0) {
    entries.push(
      ...rawLogs
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => ({
          timestamp: toIsoTimestamp(cycle.createdAt),
          taskId: cycle.taskId,
          level: "info",
          message: line,
          source: "agent",
        }))
    );
  }

  if (cycle.result.agentEvents?.length) {
    entries.push(...cycle.result.agentEvents.map((event) => serializeAgentEventEntry(event)));
  }

  return entries;
}

/** Serialize a single AgentLogEvent into the admin log-stream shape. */
function serializeAgentEventEntry(event: AgentLogEvent): Record<string, unknown> {
  const normalized = normalizeAgentEvent(event);
  return {
    timestamp: normalized.timestamp,
    taskId: normalized.taskId,
    level: normalized.level,
    message: normalized.message,
    source: "agent",
    type: normalized.type,
    category: normalized.category,
    cycleNumber: normalized.cycleNumber,
    data: normalized.data,
  };
}

/** Build a deterministic key used to deduplicate SSE entries. */
function streamEntryKey(entry: Record<string, unknown>): string {
  const parts = [
    String(entry["timestamp"] ?? ""),
    String(entry["taskId"] ?? ""),
    String(entry["cycleNumber"] ?? ""),
    String(entry["type"] ?? ""),
    String(entry["level"] ?? ""),
    String(entry["message"] ?? ""),
  ];
  const data = entry["data"];
  if (data !== undefined) {
    try {
      parts.push(typeof data === "string" ? data : JSON.stringify(data));
    } catch {
      parts.push(String(data));
    }
  }
  return parts.join("|");
}
