/**
 * Bounded history replay for the task-scoped admin log stream.
 *
 * A task's persisted cycles can hold thousands of log lines and events. A
 * (re)connecting stream walks that history newest-first and normalizes only
 * the entries it replays, so older history is never sanitized or written.
 * Replayed entries carry compact SSE ids; a client that reconnects with
 * `Last-Event-ID` receives only what followed its last entry.
 */

import { createHash } from "node:crypto";
import type { AgentCycle, AgentLogEvent } from "../interfaces.js";
import { normalizeAgentEvent } from "../agents/agentEventTypes.js";
import { toIsoTimestamp } from "./adminRouteUtils.js";

/** Most history entries replayed per connection; matches the admin UI live-log window. */
export const LOG_STREAM_REPLAY_LIMIT = 500;

/** Most candidates normalized per replay, so duplicate-heavy history stays bounded. */
const REPLAY_SCAN_LIMIT = LOG_STREAM_REPLAY_LIMIT * 2;

const EVENT_ID_LENGTH = 16;
const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;

export type LogStreamEntry = Record<string, unknown>;

export interface LogStreamReplayEntry {
  readonly entry: LogStreamEntry;
  readonly key: string;
  readonly id: string;
}

export interface LogStreamReplaySummary {
  /** True when the replay continues directly after the client's `Last-Event-ID`. */
  readonly resumed: boolean;
  readonly replayed: number;
  /** Older history entries left out of this replay. */
  readonly omitted: number;
  readonly limit: number;
}

export interface LogStreamReplay {
  /** Replayed entries, oldest first. */
  readonly entries: readonly LogStreamReplayEntry[];
  readonly summary: LogStreamReplaySummary;
}

/**
 * Select the newest history entries to replay from persisted cycles and the
 * live buffer. History is ordered cycle by cycle (log lines, then events) and
 * followed by the buffer; when the buffer overlaps persisted events, the newest
 * copy keeps its position.
 */
export function selectLogStreamReplay(
  cycles: readonly AgentCycle[],
  buffered: readonly AgentLogEvent[],
  lastEventId: string | undefined,
): LogStreamReplay {
  const newestFirst: LogStreamReplayEntry[] = [];
  const keys = new Set<string>();
  const candidates = replayCandidatesNewestFirst(cycles, buffered);
  let examined = 0;
  let exhausted = false;
  let resumed = false;

  while (newestFirst.length < LOG_STREAM_REPLAY_LIMIT && examined < REPLAY_SCAN_LIMIT) {
    const candidate = candidates.next();
    if (candidate.done) {
      exhausted = true;
      break;
    }
    examined += 1;
    const key = streamEntryKey(candidate.value);
    if (keys.has(key)) continue;
    keys.add(key);
    const id = streamEntryId(key);
    if (id === lastEventId) {
      resumed = true;
      break;
    }
    newestFirst.push({ entry: candidate.value, key, id });
  }

  const omitted = resumed || exhausted
    ? 0
    : Math.max(0, countReplayCandidates(cycles, buffered) - examined);
  return {
    entries: newestFirst.reverse(),
    summary: { resumed, replayed: newestFirst.length, omitted, limit: LOG_STREAM_REPLAY_LIMIT },
  };
}

/** Return a `Last-Event-ID` header value when it has the format this stream issues. */
export function readLastEventId(header: unknown): string | undefined {
  return typeof header === "string" && EVENT_ID_PATTERN.test(header) ? header : undefined;
}

/** Derive the compact SSE event id of an entry from its deduplication key. */
export function streamEntryId(key: string): string {
  return createHash("sha256").update(key).digest("base64url").slice(0, EVENT_ID_LENGTH);
}

/** Serialize a single AgentLogEvent into the admin log-stream shape. */
export function serializeAgentEventEntry(event: AgentLogEvent): LogStreamEntry {
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
export function streamEntryKey(entry: LogStreamEntry): string {
  const parts = [
    toKeyPart(entry["timestamp"]),
    toKeyPart(entry["taskId"]),
    toKeyPart(entry["cycleNumber"]),
    toKeyPart(entry["type"]),
    toKeyPart(entry["level"]),
    toKeyPart(entry["message"]),
  ];
  const data = entry["data"];
  if (data !== undefined) {
    try {
      parts.push(typeof data === "string" ? data : JSON.stringify(data));
    } catch {
      parts.push(toKeyPart(data));
    }
  }
  return parts.join("|");
}

/** Lazily serialize history newest-first so unreplayed entries are never normalized. */
function* replayCandidatesNewestFirst(
  cycles: readonly AgentCycle[],
  buffered: readonly AgentLogEvent[],
): Generator<LogStreamEntry> {
  for (const event of newestFirst(buffered)) yield serializeAgentEventEntry(event);
  for (const cycle of newestFirst(cycles)) {
    for (const event of newestFirst(cycle.result.agentEvents ?? [])) yield serializeAgentEventEntry(event);
    const timestamp = toIsoTimestamp(cycle.createdAt);
    for (const line of nonEmptyLinesNewestFirst(cycle.result.agentLogs)) {
      yield { timestamp, taskId: cycle.taskId, level: "info", message: line, source: "agent" };
    }
  }
}

function countReplayCandidates(cycles: readonly AgentCycle[], buffered: readonly AgentLogEvent[]): number {
  let total = buffered.length;
  for (const cycle of cycles) {
    total += cycle.result.agentEvents?.length ?? 0;
    const lines = nonEmptyLinesNewestFirst(cycle.result.agentLogs);
    while (!lines.next().done) total += 1;
  }
  return total;
}

function* newestFirst<T>(items: readonly T[]): Generator<T> {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined) yield item;
  }
}

/** Yield the non-blank lines of a log from the end, without splitting the whole text. */
function* nonEmptyLinesNewestFirst(text: string): Generator<string> {
  const logs = text.trim();
  let end = logs.length;
  while (end > 0) {
    const newline = logs.lastIndexOf("\n", end - 1);
    const line = logs.slice(newline + 1, end);
    const content = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (content.trim().length > 0) yield content;
    end = newline;
  }
}

/** Stringify an unknown log-entry field without risking `[object Object]` output. */
function toKeyPart(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}
