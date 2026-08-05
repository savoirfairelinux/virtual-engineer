import type { AgentLogEvent } from "../interfaces.js";
import { agentLogBus, pushToTaskBuffer } from "../agents/agentEventBus.js";

/**
 * Parse a single stderr line from the review container.
 * If it is a structured `__ve_event` JSON line, parse it and emit on the bus.
 * Otherwise wrap it as a generic `stderr.line` event.
 *
 * Mutates `collectedEvents` (appends the produced event) and pushes/emits it
 * on the shared live-log bus, mirroring the review container's stdout event
 * handling so a review's stderr diagnostics show up in the same log stream.
 */
export function processReviewStderrLine(
  line: string,
  taskId: string,
  cycleNumber: number,
  collectedEvents: AgentLogEvent[]
): void {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed["__ve_event"] === true) {
      const event: AgentLogEvent = {
        type: typeof parsed["type"] === "string" ? parsed["type"] : "unknown",
        timestamp: typeof parsed["ts"] === "string" ? parsed["ts"] : new Date().toISOString(),
        data: parsed["data"] ?? null,
        taskId,
        cycleNumber,
      };
      collectedEvents.push(event);
      pushToTaskBuffer(event);
      agentLogBus.emit("event", event);
      return;
    }
  } catch {
    // Not JSON — fall through to plain text handling.
  }

  // Plain text stderr line.
  const event: AgentLogEvent = {
    type: "stderr.line",
    timestamp: new Date().toISOString(),
    data: { line },
    taskId,
    cycleNumber,
  };
  collectedEvents.push(event);
  pushToTaskBuffer(event);
  agentLogBus.emit("event", event);
}
