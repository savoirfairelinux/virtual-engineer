/**
 * Normalized agent event types, sanitization, and metrics aggregation.
 *
 * This module provides:
 * - A stable event type system for the UI
 * - A centralized sanitizer to redact secrets before sending to clients
 * - A session metrics aggregator for tokens/tools/costs
 * - Result parsing for backward-compatible multi-repo support
 */

import type { AgentResult } from "../interfaces.js";

// ── Result normalization for backward compatibility ──────────────────────────

/**
 * Normalize agent result to always use flat modifiedFiles array for internal processing.
 * When result has repo-grouped format (object), flatten to ["repoKey/file1", "repoKey/file2"].
 * Preserves backward compatibility: single-repo results are already flat.
 */
export function normalizeAgentResult(result: AgentResult): AgentResult {
  // If modifiedFiles is already an array, return as-is
  if (Array.isArray(result.modifiedFiles)) {
    return result;
  }

  // If modifiedFiles is an object (repo-grouped format), flatten it
  if (
    typeof result.modifiedFiles === 'object' &&
    result.modifiedFiles !== null &&
    !Array.isArray(result.modifiedFiles)
  ) {
    const repoGrouped = result.modifiedFiles as Record<string, string[]>;
    const flattened: string[] = [];
    for (const [repoKey, files] of Object.entries(repoGrouped)) {
      if (Array.isArray(files)) {
        flattened.push(
          ...files.map((file) => (repoKey === 'superproject' ? file : `${repoKey}/${file}`))
        );
      }
    }
    return { ...result, modifiedFiles: flattened };
  }

  // Fallback: return as-is
  return result;
}

/**
 * Get file count from agent result, supporting both flat and repo-grouped formats.
 */
export function getModifiedFileCount(
  modifiedFiles: unknown
): number {
  if (Array.isArray(modifiedFiles)) {
    return modifiedFiles.length;
  }
  if (typeof modifiedFiles === 'object' && modifiedFiles !== null) {
    let count = 0;
    for (const files of Object.values(modifiedFiles as Record<string, unknown>)) {
      if (Array.isArray(files)) {
        count += files.length;
      }
    }
    return count;
  }
  return 0;
}

// ── Normalized event types ──────────────────────────────────────────────────

export const AGENT_EVENT_CATEGORIES = ["all", "tools", "usage", "errors", "session", "review"] as const;
export type AgentEventCategory = (typeof AGENT_EVENT_CATEGORIES)[number];

export interface NormalizedAgentEvent {
  /** Stable event type for the UI */
  type: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Task ID */
  taskId: string;
  /** Agent cycle number */
  cycleNumber: number;
  /** Human-readable summary message */
  message: string;
  /** UI filter category */
  category: AgentEventCategory;
  /** Sanitized data payload (secrets redacted) */
  data: Record<string, unknown> | null;
  /** Log level for display */
  level: "info" | "warn" | "error" | "debug";
}

export interface ToolMetrics {
  name: string;
  callCount: number;
  lastStatus: "running" | "success" | "error" | "unknown";
  lastStartTime: string | null;
  lastEndTime: string | null;
  /** Duration in ms of the last completed call */
  lastDurationMs: number | null;
  /** Total duration in ms across all calls */
  totalDurationMs: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

export interface SessionMetrics {
  /** Per-tool metrics */
  tools: Record<string, ToolMetrics>;
  /** Total tool call count */
  totalToolCalls: number;
  /** Currently running tool name, or null */
  activeToolName: string | null;
  /** Cumulative token usage (summed across distinct requests) */
  tokenUsage: TokenUsage;
  /** Number of usage events received */
  usageEventCount: number;
  /** Session start time */
  sessionStartTime: string | null;
  /** Session end time */
  sessionEndTime: string | null;
  /** Whether quota info is available (always false - not exposed by SDK/CLI) */
  quotaAvailable: false;
  /** Explanation for unavailable quota */
  quotaMessage: string;
  /**
   * Internal: per-request token snapshots for dedup.
   * Maps request key → last-seen {input, output, cacheRead, cacheWrite} so
   * live-then-final pairs are handled via delta (not first-wins).
   */
  requestSnapshots: Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>;
  /** Internal: tool-call identities already counted (dedup). */
  countedToolCallIds: Set<string>;
}

// ── Secret patterns for sanitization ────────────────────────────────────────

// ⚠️ SECURITY: These patterns match common secret formats to redact before
// sending event data to the UI. Conservative approach: redact if uncertain.
const SECRET_PATTERNS: readonly RegExp[] = [
  // GitHub tokens (ghp_, gho_, ghs_, ghr_, github_pat_)
  /\bgh[posr]_[A-Za-z0-9_]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  // Generic API keys / tokens / passwords in key=value or key: value
  /(?:(?:api[_-]?key|api[_-]?token|auth[_-]?token|password|secret|credential|access[_-]?token|private[_-]?key|ssh[_-]?key)\s*[:=]\s*)\S+/gi,
  // Bearer tokens
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  // SSH private key blocks
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
  // Home directory paths with username
  /\/home\/[a-z_][a-z0-9_-]*/gi,
  // IP addresses with port (potential internal infra)
  /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}\b/g,
];

const REDACTED = "[REDACTED]";

/**
 * Sanitize a string value by redacting known secret patterns.
 */
export function sanitizeValue(value: string): string {
  let result = value;
  for (const pattern of SECRET_PATTERNS) {
    // Reset lastIndex for global regexps
    pattern.lastIndex = 0;
    result = result.replace(pattern, REDACTED);
  }
  return result;
}

/**
 * Deep-sanitize an object, redacting string values that match secret patterns.
 * Returns a new object — does not mutate the input.
 */
export function sanitizeEventData(data: unknown): Record<string, unknown> | null {
  if (data === null || data === undefined) return null;
  if (typeof data !== "object") {
    return typeof data === "string" ? { value: sanitizeValue(data) } : { value: data };
  }
  return sanitizeRecord(data as Record<string, unknown>);
}

/** Recursively sanitize a plain object, redacting secret-looking keys and string values. */
function sanitizeRecord(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    // Skip keys that are likely to contain secrets entirely
    const lowerKey = key.toLowerCase();
    // Allowlist: metric keys that contain "token" but are NOT secrets
    const isMetricKey =
      lowerKey === "inputtokens" ||
      lowerKey === "outputtokens" ||
      lowerKey === "totaltokens" ||
      lowerKey === "tokenlimit" ||
      lowerKey === "currenttokens" ||
      lowerKey === "systemtokens" ||
      lowerKey === "conversationtokens" ||
      lowerKey === "tooldefinitionstokens" ||
      lowerKey === "cachereadtokens" ||
      lowerKey === "cachewritetokens" ||
      lowerKey === "prompttokens" ||
      lowerKey === "completiontokens" ||
      lowerKey === "input_tokens" ||
      lowerKey === "output_tokens" ||
      lowerKey === "total_tokens" ||
      lowerKey === "cache_read_tokens" ||
      lowerKey === "cache_write_tokens" ||
      lowerKey === "cachereadinputtokens" ||
      lowerKey === "cachecreationinputtokens";
    if (
      !isMetricKey &&
      (lowerKey.includes("token") ||
       lowerKey.includes("secret") ||
       lowerKey.includes("password") ||
       lowerKey.includes("credential") ||
       lowerKey.includes("private_key") ||
       lowerKey.includes("authorization"))
    ) {
      result[key] = REDACTED;
      continue;
    }
    if (typeof value === "string") {
      result[key] = sanitizeValue(value);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        typeof item === "string"
          ? sanitizeValue(item)
          : typeof item === "object" && item !== null
            ? sanitizeRecord(item as Record<string, unknown>)
            : item
      );
    } else if (typeof value === "object" && value !== null) {
      result[key] = sanitizeRecord(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ── Event type → category mapping ───────────────────────────────────────────

/** Return true when a stderr.line event's line content matches the tool-output prefix pattern. */
function isToolStderrLine(data: Record<string, unknown> | null): boolean {
  const line = readStr(data, ["line"]);
  return typeof line === "string" && /^\[tool\]\s+#\d+\s+/.test(line);
}

/** Map an event type string to its UI filter category. */
function categorizeEvent(type: string, data: Record<string, unknown> | null): AgentEventCategory {
  if (type.startsWith("review.")) return "review";
  if (type.startsWith("tool.")) return "tools";
  if (type === "stderr.line" && isToolStderrLine(data)) return "tools";
  if (type === "assistant.usage" || type === "session.usage_info") return "usage";
  if (type === "session.error") return "errors";
  if (
    type === "session.start" ||
    type === "session.end" ||
    type === "permission.requested"
  ) {
    return "session";
  }
  // Non-tool stderr.line and assistant.* are general log lines.
  return "all";
}

/** Map an event type string to its display log level. */
function eventLevel(type: string): "info" | "warn" | "error" | "debug" {
  if (type === "session.error" || type === "review.failed") return "error";
  if (type === "permission.requested") return "warn";
  if (type === "assistant.streaming_delta") return "debug";
  return "info";
}

// ── Normalize raw AgentLogEvent → NormalizedAgentEvent ──────────────────────

interface RawAgentLogEvent {
  type: string;
  timestamp: string;
  data: unknown;
  taskId: string;
  cycleNumber: number;
}

/**
 * Normalize a raw agent event into a structured, sanitized UI event.
 */
export function normalizeAgentEvent(raw: RawAgentLogEvent): NormalizedAgentEvent {
  const sanitizedData = sanitizeEventData(raw.data);
  return {
    type: raw.type,
    timestamp: raw.timestamp,
    taskId: raw.taskId,
    cycleNumber: raw.cycleNumber,
    message: buildEventMessage(raw.type, sanitizedData),
    category: categorizeEvent(raw.type, sanitizedData),
    data: sanitizedData,
    level: eventLevel(raw.type),
  };
}

/** Read the first non-empty string value for any key from data, searching common SDK wrapper paths. */
function readStr(data: Record<string, unknown> | null, keys: readonly string[]): string | null {
  if (!data) return null;
  // Direct keys
  for (const key of keys) {
    const v = data[key];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  // Search one level deeper in common SDK wrappers
  const wrappers = ["toolCall", "tool", "function", "data", "toolUse"];
  for (const wrapper of wrappers) {
    const sub = data[wrapper];
    if (typeof sub === "object" && sub !== null) {
      const subRec = sub as Record<string, unknown>;
      for (const key of keys) {
        const v = subRec[key];
        if (typeof v === "string" && v.trim().length > 0) return v;
      }
      // Two levels deep: e.g. toolCall.function.name
      for (const inner of wrappers) {
        const sub2 = subRec[inner];
        if (typeof sub2 === "object" && sub2 !== null) {
          const sub2Rec = sub2 as Record<string, unknown>;
          for (const key of keys) {
            const v = sub2Rec[key];
            if (typeof v === "string" && v.trim().length > 0) return v;
          }
        }
      }
    }
  }
  return null;
}

/** Read the first finite numeric value for any key from data, searching common SDK wrapper paths. */
function readNum(data: Record<string, unknown> | null, keys: readonly string[]): number | null {
  if (!data) return null;
  // Direct keys
  for (const key of keys) {
    const v = data[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  // Search one level deeper in common SDK wrappers
  for (const wrapper of ["usage", "data", "metrics", "tokenUsage"]) {
    const sub = data[wrapper];
    if (typeof sub === "object" && sub !== null) {
      const subRec = sub as Record<string, unknown>;
      for (const key of keys) {
        const v = subRec[key];
        if (typeof v === "number" && Number.isFinite(v)) return v;
      }
    }
  }
  return null;
}

/** Extract the tool input/arguments object from an event data record, traversing common nesting patterns. */
function readToolInput(data: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!data) return null;

  const directInput = data["input"];
  if (typeof directInput === "object" && directInput !== null) {
    return directInput as Record<string, unknown>;
  }

  const directArgs = data["arguments"];
  if (typeof directArgs === "object" && directArgs !== null) {
    return directArgs as Record<string, unknown>;
  }

  for (const wrapper of ["toolCall", "tool", "function", "data", "toolUse"]) {
    const nested = data[wrapper];
    if (typeof nested !== "object" || nested === null) continue;
    const nestedRecord = nested as Record<string, unknown>;

    const nestedInput = nestedRecord["input"];
    if (typeof nestedInput === "object" && nestedInput !== null) {
      return nestedInput as Record<string, unknown>;
    }

    const nestedArgs = nestedRecord["arguments"];
    if (typeof nestedArgs === "object" && nestedArgs !== null) {
      return nestedArgs as Record<string, unknown>;
    }

    const fn = nestedRecord["function"];
    if (typeof fn !== "object" || fn === null) continue;
    const fnRecord = fn as Record<string, unknown>;

    const fnInput = fnRecord["input"];
    if (typeof fnInput === "object" && fnInput !== null) {
      return fnInput as Record<string, unknown>;
    }

    const fnArgs = fnRecord["arguments"];
    if (typeof fnArgs === "object" && fnArgs !== null) {
      return fnArgs as Record<string, unknown>;
    }
  }

  return null;
}

/** Build a human-readable summary message for a given event type and sanitized data payload. */
function buildEventMessage(type: string, data: Record<string, unknown> | null): string {
  switch (type) {
    case "stderr.line":
      return readStr(data, ["line"]) ?? "";
    case "tool.execution_start": {
      const name = readStr(data, ["name", "tool", "toolName"]);
      // Try to extract the most useful argument to show inline
      let detail = readToolFilePath(data);
      if (!detail) {
        const input = readToolInput(data);
        if (input) {
          const cmd = input["command"] ?? input["cmd"];
          if (typeof cmd === "string" && cmd.trim()) {
            detail = cmd.trim();
          } else {
            const pattern = input["pattern"] ?? input["query"] ?? input["regex"];
            if (typeof pattern === "string" && pattern.trim()) {
              detail = pattern.trim();
            }
          }
        }
      }
      if (name && detail) return `▶ ${name}(${detail})`;
      return name ? `▶ ${name}` : "▶ tool started";
    }
    case "tool.execution_complete": {
      const name = readStr(data, ["name", "tool", "toolName"]);
      const duration = readNum(data, ["durationMs"]);
      const output = readStr(data, ["output", "content"]);
      const status = readStr(data, ["status", "result"]);
      const failed = status === "error";
      const durationLabel = duration != null ? ` (${duration}ms)` : "";
      const statusLabel = status ? ` ${status}` : "";
      const outputLabel = output ? ` → ${output.slice(0, 80)}` : "";
      if (name) return `${failed ? "✗" : "✓"} ${name}${statusLabel}${durationLabel}${outputLabel}`;
      return `${failed ? "✗" : "✓"} tool completed${statusLabel}${durationLabel}${outputLabel}`;
    }
    case "tool.execution_progress": {
      const name = readStr(data, ["name", "tool", "toolName"]);
      const msg = readStr(data, ["message", "progress"]);
      return name ? `⟳ ${name}: ${msg ?? "in progress"}` : (msg ?? "tool progress");
    }
    case "assistant.message": {
      const content = readStr(data, ["content", "text", "message"]);
      return content ? `💬 ${content.slice(0, 400)}` : "assistant message";
    }
    case "assistant.streaming_delta": {
      const delta = readStr(data, ["delta", "content", "text"]);
      return delta ? `…${delta.slice(0, 100)}` : "…";
    }
    case "assistant.usage": {
      const input = readNum(data, ["inputTokens", "input_tokens", "promptTokens"]);
      const output = readNum(data, ["outputTokens", "output_tokens", "completionTokens"]);
      const parts: string[] = [];
      if (input !== null) parts.push(`in:${input}`);
      if (output !== null) parts.push(`out:${output}`);
      return parts.length > 0 ? `📊 tokens ${parts.join(" ")}` : "📊 usage update";
    }
    case "session.usage_info": {
      const tokens = readNum(data, ["tokens", "totalTokens", "total_tokens"]);
      const input = readNum(data, ["inputTokens", "input_tokens", "promptTokens"]);
      const output = readNum(data, ["outputTokens", "output_tokens", "completionTokens"]);
      const parts: string[] = [];
      if (input !== null) parts.push(`in:${input}`);
      if (output !== null) parts.push(`out:${output}`);
      if (tokens !== null && parts.length === 0) parts.push(`total:${tokens}`);
      return parts.length > 0 ? `📊 ${parts.join(" ")}` : "📊 usage info";
    }
    case "session.start":
      return "🟢 Session started";
    case "session.end":
      return "🔴 Session ended";
    case "session.error": {
      const msg = readStr(data, ["message", "error", "reason"]);
      return msg ? `❌ ${msg}` : "❌ Error occurred";
    }
    case "permission.requested": {
      const tool = readStr(data, ["tool", "name", "toolName"]);
      return tool ? `🔐 Permission: ${tool}` : "🔐 Permission requested";
    }
    case "skills.fetch_start":
      return buildSkillFetchMessage("Fetching skills from", data);
    case "skills.fetch_complete":
      return buildSkillFetchMessage("Fetched skills from", data);
    case "skills.fetch_failed": {
      const message = buildSkillFetchMessage("Failed to fetch skills from", data);
      const reason = readStr(data, ["message", "error", "reason"]);
      return reason ? `${message}: ${reason}` : message;
    }
    // ── Review lifecycle events ───────────────────────────────────────────
    case "review.started":
      return "📝 Review started";
    case "review.prompt_built":
      return "📝 Review prompt built";
    case "review.agent_started":
      return "📝 Review agent running…";
    case "review.agent_completed": {
      const chars = readNum(data, ["outputLength", "chars"]);
      return chars !== null ? `📝 Review agent completed (${chars} chars)` : "📝 Review agent completed";
    }
    case "review.parsing":
      return "📝 Parsing review result…";
    case "review.posting_comments": {
      const count = readNum(data, ["commentCount", "comments"]);
      const vote = readNum(data, ["vote", "score"]);
      const parts: string[] = [];
      if (count !== null) parts.push(`${count} comment${count !== 1 ? "s" : ""}`);
      if (vote !== null) parts.push(`vote ${vote > 0 ? "+" : ""}${vote}`);
      return parts.length > 0 ? `📝 Posting review: ${parts.join(", ")}` : "📝 Posting review…";
    }
    case "review.completed": {
      const count = readNum(data, ["commentCount", "comments"]);
      const vote = readNum(data, ["vote", "score"]);
      const parts: string[] = [];
      if (count !== null) parts.push(`${count} comment${count !== 1 ? "s" : ""}`);
      if (vote !== null) parts.push(`vote ${vote > 0 ? "+" : ""}${vote}`);
      return parts.length > 0 ? `✅ Review completed: ${parts.join(", ")}` : "✅ Review completed";
    }
    case "review.failed": {
      const msg = readStr(data, ["message", "error", "reason"]);
      return msg ? `❌ Review failed: ${msg}` : "❌ Review failed";
    }
    default:
      return type;
  }
}

/** Build a human-readable message for remote skill fetch events. */
function buildSkillFetchMessage(prefix: string, data: Record<string, unknown> | null): string {
  const source = readStr(data, ["source", "repo", "repository", "url"]) ?? "unknown source";
  const agent = readStr(data, ["agent", "agentName"]);
  const skills = formatSkillSelection(data?.["skills"]);
  const details = [`skills: ${skills}`];
  if (agent) details.push(`agent: ${agent}`);
  return `${prefix} ${source} (${details.join(" · ")})`;
}

/** Format the selected remote skill list from worker event payloads. */
function formatSkillSelection(value: unknown): string {
  if (value === "all") return "all skills";
  if (Array.isArray(value)) {
    const skills = value
      .filter((skill): skill is string => typeof skill === "string" && skill.trim().length > 0)
      .map((skill) => skill.trim());
    return skills.length > 0 ? skills.join(", ") : "no explicit skills";
  }
  return "no explicit skills";
}

/** Extract a file path from a tool event's input for inline display in the event message. */
function readToolFilePath(data: Record<string, unknown> | null): string | null {
  if (!data) return null;
  const input = readToolInput(data);
  if (input) {
    for (const key of ["path", "file_path", "target_file", "filePath"]) {
      const v = input[key];
      if (typeof v === "string" && v.trim().length > 0) return v;
    }
  }
  // Check top-level
  for (const key of ["path", "file_path", "filePath"]) {
    const v = data[key];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

/**
 * Accumulate per-request token usage, deduping duplicate SDK emissions.
 *
 * The Copilot SDK reports usage **per LLM request** and can emit the same
 * request's usage more than once (a duplicate or a live-then-final pair where
 * the first event has outputTokens=0 and the second has the real value). Events
 * are grouped by request identity (`apiCallId`/`providerCallId`, falling back to
 * a content signature); a per-request snapshot is maintained and deltas applied
 * on subsequent emissions so later, more-complete snapshots are not discarded.
 * `totalTokens` is always derived from `inputTokens + outputTokens` to avoid
 * additive overcounting when the SDK includes a per-request `totalTokens` field.
 */
function accumulateRequestUsage(
  metrics: SessionMetrics,
  data: Record<string, unknown> | null
): void {
  const i = readNum(data, ["inputTokens", "input_tokens", "promptTokens"]) ?? 0;
  const o = readNum(data, ["outputTokens", "output_tokens", "completionTokens"]) ?? 0;
  const cr = readNum(data, ["cacheReadTokens", "cache_read_tokens", "cacheReadInputTokens"]) ?? 0;
  const cw = readNum(data, ["cacheWriteTokens", "cache_write_tokens", "cacheCreationInputTokens"]) ?? 0;
  const model = readStr(data, ["model", "modelId"]);
  const cost = readNum(data, ["cost"]);
  const nanoAiu = readNum(data, ["totalNanoAiu"]);

  const key =
    readStr(data, ["apiCallId", "providerCallId"]) ??
    `sig:${model ?? ""}|${i}|${o}|${cr}|${cw}|${cost ?? ""}|${nanoAiu ?? ""}`;

  const usage = metrics.tokenUsage;
  const existing = metrics.requestSnapshots.get(key);
  if (existing) {
    // Apply only the delta: later emissions in a live-then-final pair carry more
    // complete token counts (e.g. outputTokens goes from 0 to the real value).
    usage.inputTokens += Math.max(0, i - existing.input);
    usage.outputTokens += Math.max(0, o - existing.output);
    usage.cacheReadTokens += Math.max(0, cr - existing.cacheRead);
    usage.cacheWriteTokens += Math.max(0, cw - existing.cacheWrite);
    existing.input = Math.max(existing.input, i);
    existing.output = Math.max(existing.output, o);
    existing.cacheRead = Math.max(existing.cacheRead, cr);
    existing.cacheWrite = Math.max(existing.cacheWrite, cw);
  } else {
    metrics.requestSnapshots.set(key, { input: i, output: o, cacheRead: cr, cacheWrite: cw });
    usage.inputTokens += i;
    usage.outputTokens += o;
    usage.cacheReadTokens += cr;
    usage.cacheWriteTokens += cw;
  }

  // Always derive from accumulated input/output to avoid additive overcounting.
  usage.totalTokens = usage.inputTokens + usage.outputTokens;
}

// ── Session metrics aggregator ──────────────────────────────────────────────

/**
 * Create a fresh SessionMetrics object.
 */
export function createSessionMetrics(): SessionMetrics {
  return {
    tools: {},
    totalToolCalls: 0,
    activeToolName: null,
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    },
    usageEventCount: 0,
    sessionStartTime: null,
    sessionEndTime: null,
    quotaAvailable: false,
    quotaMessage: "Not exposed by current SDK/CLI",
    requestSnapshots: new Map(),
    countedToolCallIds: new Set<string>(),
  };
}

/**
 * Update session metrics from a normalized event.
 * Mutates the metrics object in place for performance.
 */
export function updateSessionMetrics(
  metrics: SessionMetrics,
  event: NormalizedAgentEvent
): void {
  switch (event.type) {
    case "session.start":
      metrics.sessionStartTime = event.timestamp;
      break;

    case "session.end":
      metrics.sessionEndTime = event.timestamp;
      metrics.activeToolName = null;
      break;

    case "tool.execution_start": {
      const name = readStr(event.data, ["name", "tool", "toolName"]) ?? "unknown";
      // Dedup duplicate SDK emissions when an explicit call identity is present;
      // without one, count each event (cannot prove it is a duplicate).
      const callId = readStr(event.data, ["callId", "toolCallId", "id"]);
      const callNumber = readNum(event.data, ["callNumber"]);
      const callKey = callId ?? (callNumber !== null ? `${name}#${callNumber}` : null);
      if (callKey !== null) {
        if (metrics.countedToolCallIds.has(callKey)) {
          metrics.activeToolName = name;
          break;
        }
        metrics.countedToolCallIds.add(callKey);
      }
      metrics.totalToolCalls++;
      metrics.activeToolName = name;
      if (!metrics.tools[name]) {
        metrics.tools[name] = {
          name,
          callCount: 0,
          lastStatus: "unknown",
          lastStartTime: null,
          lastEndTime: null,
          lastDurationMs: null,
          totalDurationMs: 0,
        };
      }
      const tool = metrics.tools[name]!;
      tool.callCount++;
      tool.lastStatus = "running";
      tool.lastStartTime = event.timestamp;
      tool.lastEndTime = null;
      tool.lastDurationMs = null;
      break;
    }

    case "tool.execution_complete": {
      const name = readStr(event.data, ["name", "tool", "toolName"]) ?? "unknown";
      if (metrics.activeToolName === name) {
        metrics.activeToolName = null;
      }
      const tool = metrics.tools[name];
      if (tool) {
        const status = readStr(event.data, ["status", "result"]);
        tool.lastStatus = status === "error" ? "error" : "success";
        tool.lastEndTime = event.timestamp;
        if (tool.lastStartTime) {
          const duration = new Date(event.timestamp).getTime() - new Date(tool.lastStartTime).getTime();
          if (duration >= 0) {
            tool.lastDurationMs = duration;
            tool.totalDurationMs += duration;
          }
        }
      }
      break;
    }

    case "assistant.usage":
    case "session.usage_info": {
      metrics.usageEventCount++;
      accumulateRequestUsage(metrics, event.data);
      break;
    }

    default:
      break;
  }
}

/**
 * Reset session metrics (e.g. between cycles).
 */
export function resetSessionMetrics(metrics: SessionMetrics): void {
  metrics.tools = {};
  metrics.totalToolCalls = 0;
  metrics.activeToolName = null;
  metrics.tokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  };
  metrics.usageEventCount = 0;
  metrics.sessionStartTime = null;
  metrics.sessionEndTime = null;
  metrics.requestSnapshots = new Map();
  metrics.countedToolCallIds = new Set<string>();
}
