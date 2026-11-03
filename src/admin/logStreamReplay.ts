/**
 * Bounded history replay for the task-scoped admin log stream.
 *
 * A task's persisted cycles can hold thousands of log lines and events. A
 * (re)connecting stream walks that history newest-first and normalizes only
 * the entries it replays, so older history is never sanitized or written.
 * Replayed entries carry compact SSE ids; a client that reconnects with a
 * `Last-Event-ID` naming one record still in the live buffer receives only
 * what followed it.
 */

import { createHash } from "node:crypto";
import type { AgentCycle, AgentLogEvent } from "../interfaces.js";
import { normalizeAgentEvent } from "../agents/agentEventTypes.js";
import { toIsoTimestamp } from "./adminRouteUtils.js";

/** Most history entries replayed per connection; matches the admin UI live-log window. */
export const LOG_STREAM_REPLAY_LIMIT = 500;

/** Most candidates examined per replay, live buffer included, so duplicate-heavy history stays bounded. */
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
  /** True when the replay continues directly after a `Last-Event-ID` naming exactly one buffered record. */
  readonly resumed: boolean;
  readonly replayed: number;
  /** Older history records left out of this replay; a record both persisted and buffered counts once. */
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
 * followed by the buffer. A running review persists the same events it
 * buffers; such a persisted copy is skipped, so the buffered copy keeps its
 * position and the record is counted once.
 *
 * Only the live buffer keeps the order in which entries were streamed: a
 * completed cycle stores plain output apart from its events. A cursor is
 * therefore resumed only when it names exactly one buffered record; identical
 * records share an id, so a cursor matching several does not say which one the
 * client received. Any other cursor gets a fresh replay.
 */
export function selectLogStreamReplay(
  cycles: readonly AgentCycle[],
  buffered: readonly AgentLogEvent[],
  lastEventId: string | undefined,
): LogStreamReplay {
  // The event bus keeps at most 500 events per task; the slice bounds this regardless.
  const liveEvents = buffered.slice(-LOG_STREAM_REPLAY_LIMIT);
  const live = liveEvents.map((event) => replayEntry(serializeAgentEventEntry(event)));
  const matches = live.flatMap(({ id }, index) => (id === lastEventId ? [index] : []));
  const resumeAfter = matches.length === 1 ? matches[0] : undefined;
  const copies = bufferedCopyPositions(cycles.at(-1), liveEvents);
  const candidates = replayCandidatesNewestFirst(live, resumeAfter, cycles, copies);
  const newestFirst: LogStreamReplayEntry[] = [];
  const keys = new Set<string>();
  let examined = 0;
  let exhausted = false;

  while (newestFirst.length < LOG_STREAM_REPLAY_LIMIT && examined < REPLAY_SCAN_LIMIT) {
    const candidate = candidates.next();
    if (candidate.done) {
      exhausted = true;
      break;
    }
    examined += 1;
    if (keys.has(candidate.value.key)) continue;
    keys.add(candidate.value.key);
    newestFirst.push(candidate.value);
  }

  const resumed = resumeAfter !== undefined;
  const omitted = resumed || exhausted
    ? 0
    : Math.max(0, buffered.length + countHistoryRecords(cycles) - copies.size - examined);
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

function replayEntry(entry: LogStreamEntry): LogStreamReplayEntry {
  const key = streamEntryKey(entry);
  return { entry, key, id: streamEntryId(key) };
}

const NO_POSITIONS: ReadonlySet<number> = new Set();

/**
 * Yield candidates newest-first: the serialized live buffer down to any resume
 * cursor, then, for a fresh replay, persisted history serialized lazily so
 * unreplayed entries are never normalized.
 */
function* replayCandidatesNewestFirst(
  live: readonly LogStreamReplayEntry[],
  resumeAfter: number | undefined,
  cycles: readonly AgentCycle[],
  copies: ReadonlySet<number>,
): Generator<LogStreamReplayEntry> {
  for (let index = live.length - 1; index > (resumeAfter ?? -1); index -= 1) {
    const entry = live[index];
    if (entry !== undefined) yield entry;
  }
  // A resumed client already holds everything up to its cursor.
  if (resumeAfter !== undefined) return;
  for (let cycleIndex = cycles.length - 1; cycleIndex >= 0; cycleIndex -= 1) {
    const cycle = cycles[cycleIndex];
    if (cycle === undefined) continue;
    const events = cycle.result.agentEvents ?? [];
    const skipped = cycleIndex === cycles.length - 1 ? copies : NO_POSITIONS;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event !== undefined && !skipped.has(index)) yield replayEntry(serializeAgentEventEntry(event));
    }
    const timestamp = toIsoTimestamp(cycle.createdAt);
    for (const line of nonEmptyLinesNewestFirst(cycle.result.agentLogs)) {
      yield replayEntry({ timestamp, taskId: cycle.taskId, level: "info", message: line, source: "agent" });
    }
  }
}

/** Count persisted records without reading any payload. */
function countHistoryRecords(cycles: readonly AgentCycle[]): number {
  let total = 0;
  for (const cycle of cycles) {
    total += cycle.result.agentEvents?.length ?? 0;
    const lines = nonEmptyLinesNewestFirst(cycle.result.agentLogs);
    while (!lines.next().done) total += 1;
  }
  return total;
}

/**
 * Positions, among the newest cycle's events, of persisted copies of buffered
 * events. The buffer holds the running cycle's latest events, and a running
 * review persists a prefix of that same stream, so a copy can only sit among
 * the cycle's last `liveEvents.length` events. Only those are compared, and a
 * payload is serialized only once cycle, timestamp, and type already match.
 */
function bufferedCopyPositions(
  newest: AgentCycle | undefined,
  liveEvents: readonly AgentLogEvent[],
): ReadonlySet<number> {
  const events = newest?.result.agentEvents ?? [];
  if (liveEvents.length === 0 || events.length === 0) return NO_POSITIONS;
  const prefixes = new Set<string>();
  const identities = new Set<string>();
  for (const event of liveEvents) {
    const identity = eventIdentity(event);
    if (identity === undefined) continue;
    prefixes.add(eventPrefix(event));
    identities.add(identity);
  }
  const copies = new Set<number>();
  for (let index = Math.max(0, events.length - liveEvents.length); index < events.length; index += 1) {
    const event = events[index];
    if (event === undefined || !prefixes.has(eventPrefix(event))) continue;
    const identity = eventIdentity(event);
    if (identity !== undefined && identities.has(identity)) copies.add(index);
  }
  return copies;
}

function eventPrefix(event: AgentLogEvent): string {
  return `${event.cycleNumber}|${event.timestamp}|${event.type}`;
}

/** Raw identity of an event; undefined when its payload cannot be serialized, and so cannot have been persisted. */
function eventIdentity(event: AgentLogEvent): string | undefined {
  try {
    return `${eventPrefix(event)}|${JSON.stringify(event.data) ?? ""}`;
  } catch {
    return undefined;
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
