import { makeTaskId } from "../interfaces.js";
import type { AgentCycle, AgentLogEvent, Task } from "../interfaces.js";
import { agentLogBus, getTaskEventBuffer } from "../agents/agentEventBus.js";
import { normalizeAgentEvent } from "../agents/agentEventTypes.js";
import { writeJson, toIsoTimestamp } from "./adminRouteUtils.js";
import { deduplicateByTicket } from "./adminTaskRoutes.js";
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

    if (taskIdParam) {
      const taskId = makeTaskId(taskIdParam);
      const task = await deps.stateStore.getTask(taskId);
      if (!task) {
        writeJson(res, 404, { error: "Task not found" });
        return;
      }

      const cycles = await deps.stateStore.getAgentCycles(taskId);
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
    res.flushHeaders();

    for (const entry of streamEntries) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    if (taskIdParam) {
      const buffered = getTaskEventBuffer(taskIdParam);
      for (const event of buffered) {
        if (res.writable) {
          res.write(`data: ${JSON.stringify(serializeAgentEventEntry(event))}\n\n`);
        }
      }
    }

    const emittedTimestamps = new Set<string>();
    const eventListener = (event: AgentLogEvent): void => {
      if (taskIdParam && event.taskId !== taskIdParam) return;
      if (!res.writable) return;
      const key = `${event.timestamp}:${event.type}:${String(event.cycleNumber)}`;
      if (emittedTimestamps.has(key)) return;
      emittedTimestamps.add(key);
      res.write(`data: ${JSON.stringify(serializeAgentEventEntry(event))}\n\n`);
    };
    if (taskIdParam) {
      for (const event of getTaskEventBuffer(taskIdParam)) {
        emittedTimestamps.add(`${event.timestamp}:${event.type}:${String(event.cycleNumber)}`);
      }
    }
    agentLogBus.on("event", eventListener);

    const heartbeatLogs = setInterval(() => {
      if (!res.writable) { clearInterval(heartbeatLogs); return; }
      res.write(": heartbeat\n\n");
    }, 15_000);

    res.on("close", () => {
      agentLogBus.off("event", eventListener);
      clearInterval(heartbeatLogs);
    });
    // Do NOT call res.end() — keep connection open
  });

  router.add("GET", "/api/admin/events/stream", async (_req, res, _params) => {
    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.flushHeaders();

    const sendTasks = async (): Promise<void> => {
      if (!res.writable) return;
      try {
        const allTasks = await deps.stateStore.getAllTasks();
        const sorted = deduplicateByTicket(allTasks)
          .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
        res.write(`event: tasks\ndata: ${JSON.stringify(sorted)}\n\n`);
      } catch { /* ignore */ }
    };

    await sendTasks();

    const taskTimer = setInterval(() => void sendTasks(), 5_000);

    const heartbeatGlobal = setInterval(() => {
      if (!res.writable) { clearInterval(heartbeatGlobal); return; }
      res.write(": heartbeat\n\n");
    }, 15_000);

    res.on("close", () => {
      clearInterval(taskTimer);
      clearInterval(heartbeatGlobal);
    });
  });
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
