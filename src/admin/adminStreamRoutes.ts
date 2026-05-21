import type { IncomingMessage, ServerResponse } from "node:http";
import { makeTaskId } from "../interfaces.js";
import type { AgentCycle, AgentLogEvent, Task } from "../interfaces.js";
import { agentLogBus, getTaskEventBuffer } from "../agents/agentEventBus.js";
import { normalizeAgentEvent } from "../agents/agentEventTypes.js";
import { writeJson, toIsoTimestamp } from "./adminRouteUtils.js";
import { deduplicateByTicket } from "./adminTaskRoutes.js";

/** Subset of state-store methods required by the stream routes. */
export interface StreamRouteStore {
  getTask(id: ReturnType<typeof makeTaskId>): Promise<Task | null>;
  getAgentCycles(taskId: ReturnType<typeof makeTaskId>): Promise<AgentCycle[]>;
  getAllTasks(): Promise<Task[]>;
}

export interface StreamRouteDeps {
  stateStore: StreamRouteStore;
}

/**
 * Try to handle a stream-route (SSE) request. Returns true if the request was
 * handled (response sent / connection held open), false otherwise.
 */
export async function handleStreamRoutes(
  _request: IncomingMessage,
  response: ServerResponse,
  path: string,
  method: string,
  deps: StreamRouteDeps,
): Promise<boolean> {
  // SSE endpoint for live logs
  if (path === "/api/admin/logs/stream") {
    if (method !== "GET") {
      writeJson(response, 405, { error: "Method not allowed" });
      return true;
    }
    const requestUrl = new URL(_request.url ?? "/", "http://127.0.0.1");
    const taskIdParam = requestUrl.searchParams.get("taskId");
    let streamEntries: Array<Record<string, unknown>> = [];

    if (taskIdParam) {
      const taskId = makeTaskId(taskIdParam);
      const task = await deps.stateStore.getTask(taskId);
      if (!task) {
        writeJson(response, 404, { error: "Task not found" });
        return true;
      }

      const cycles = await deps.stateStore.getAgentCycles(taskId);
      streamEntries = cycles.flatMap((cycle) => serializeAgentLogEntries(cycle));
    } else {
      streamEntries = [
        { timestamp: new Date().toISOString(), taskId: null, level: "info", message: "Admin API stream started", source: "admin" },
        { timestamp: new Date().toISOString(), taskId: null, level: "info", message: "Listening for live logs...", source: "admin" },
      ];
    }

    response.statusCode = 200;
    response.setHeader("content-type", "text/event-stream");
    response.setHeader("cache-control", "no-cache");
    response.setHeader("connection", "keep-alive");
    response.flushHeaders();

    for (const entry of streamEntries) {
      response.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    // Replay buffered live events for the current in-flight cycle
    if (taskIdParam) {
      const buffered = getTaskEventBuffer(taskIdParam);
      for (const event of buffered) {
        if (response.writable) {
          response.write(`data: ${JSON.stringify(serializeAgentEventEntry(event))}\n\n`);
        }
      }
    }

    // Subscribe to live events filtered by taskId
    const emittedTimestamps = new Set<string>();
    const eventListener = (event: AgentLogEvent): void => {
      if (taskIdParam && event.taskId !== taskIdParam) return;
      if (!response.writable) return;
      const key = `${event.timestamp}:${event.type}:${String(event.cycleNumber)}`;
      if (emittedTimestamps.has(key)) return;
      emittedTimestamps.add(key);
      response.write(`data: ${JSON.stringify(serializeAgentEventEntry(event))}\n\n`);
    };
    // Seed dedup set from the buffer we already sent
    if (taskIdParam) {
      for (const event of getTaskEventBuffer(taskIdParam)) {
        emittedTimestamps.add(`${event.timestamp}:${event.type}:${String(event.cycleNumber)}`);
      }
    }
    agentLogBus.on("event", eventListener);

    // Heartbeat every 15s to keep connection alive
    const heartbeatLogs = setInterval(() => {
      if (!response.writable) { clearInterval(heartbeatLogs); return; }
      response.write(": heartbeat\n\n");
    }, 15_000);

    // Clean up on client disconnect
    response.on("close", () => {
      agentLogBus.off("event", eventListener);
      clearInterval(heartbeatLogs);
    });

    // Do NOT call response.end() — keep connection open
    return true;
  }

  // SSE endpoint for global events (tasks, providers)
  if (path === "/api/admin/events/stream") {
    if (method !== "GET") {
      writeJson(response, 405, { error: "Method not allowed" });
      return true;
    }

    response.statusCode = 200;
    response.setHeader("content-type", "text/event-stream");
    response.setHeader("cache-control", "no-cache");
    response.setHeader("connection", "keep-alive");
    response.flushHeaders();

    const sendTasks = async (): Promise<void> => {
      if (!response.writable) return;
      try {
        const allTasks = await deps.stateStore.getAllTasks();
        const sorted = deduplicateByTicket(allTasks)
          .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
        response.write(`event: tasks\ndata: ${JSON.stringify(sorted)}\n\n`);
      } catch { /* ignore */ }
    };

    // Send initial tasks immediately
    await sendTasks();

    // Poll tasks every 5s
    const taskTimer = setInterval(() => void sendTasks(), 5_000);

    // Heartbeat every 15s
    const heartbeatGlobal = setInterval(() => {
      if (!response.writable) { clearInterval(heartbeatGlobal); return; }
      response.write(": heartbeat\n\n");
    }, 15_000);

    // Clean up on disconnect
    response.on("close", () => {
      clearInterval(taskTimer);
      clearInterval(heartbeatGlobal);
    });

    return true;
  }

  return false;
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
