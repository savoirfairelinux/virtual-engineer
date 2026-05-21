/**
 * Shared event bus and per-task live event buffers for streaming agent logs.
 *
 * Both the coding-agent adapter and the review orchestrator emit events through
 * this bus. SSE endpoints in the admin server subscribe to it so the dashboard
 * can show live logs regardless of task type.
 */

import { EventEmitter } from "events";
import type { AgentLogEvent } from "../interfaces.js";

/** Global event bus — listeners subscribe via `agentLogBus.on("event", ...)`. */
export const agentLogBus = new EventEmitter();

// ── Per-task live event buffer ────────────────────────────────────────────────
// Retains the most recent live events per active task so that SSE clients
// connecting mid-cycle receive what they missed.  Cleared when a task cycle
// finishes (callers invoke clearTaskEventBuffer).
const LIVE_BUFFER_MAX = 500;
const taskEventBuffers = new Map<string, AgentLogEvent[]>();

/** Return the live event buffer for a task (empty array if none exists). */
export function getTaskEventBuffer(taskId: string): AgentLogEvent[] {
  return taskEventBuffers.get(taskId) ?? [];
}

/** Remove a task's event buffer, e.g. when a cycle finishes. */
export function clearTaskEventBuffer(taskId: string): void {
  taskEventBuffers.delete(taskId);
}

/** Append an event to the task's live buffer, evicting oldest entries beyond LIVE_BUFFER_MAX. */
export function pushToTaskBuffer(event: AgentLogEvent): void {
  let buf = taskEventBuffers.get(event.taskId);
  if (!buf) {
    buf = [];
    taskEventBuffers.set(event.taskId, buf);
  }
  buf.push(event);
  if (buf.length > LIVE_BUFFER_MAX) {
    buf.splice(0, buf.length - LIVE_BUFFER_MAX);
  }
}
