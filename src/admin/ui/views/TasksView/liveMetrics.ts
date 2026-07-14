/**
 * Pure metric aggregation for the live task log stream.
 *
 * Extracted from `LiveLogs.tsx` so it can be unit-tested without a DOM. The
 * Copilot SDK / agent-worker can emit each `assistant.usage` and
 * `tool.execution_*` event more than once into the live stream (a duplicate or
 * a live-then-final pair). Summing every event blindly therefore inflates the
 * live counters (~2x). This module dedups by request / tool-call identity
 * before summing, mirroring `computeCycleCost` so the live display matches the
 * eventually-persisted cycle figures.
 */

/** Minimal shape of a live-stream entry needed for metric extraction. */
export interface MetricEntry {
  type?: string | undefined;
  data?: unknown;
}

export interface Metrics {
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface TokenTotalsInput {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Provider-reported total input, including uncached, cache-read, and cache-write tokens. */
export function totalInputTokens(usage: TokenTotalsInput): number {
  return usage.inputTokens + usage.cacheRead + usage.cacheWrite;
}

/** All tokens processed by the model: total input plus generated output. */
export function totalProcessedTokens(usage: TokenTotalsInput): number {
  return totalInputTokens(usage) + usage.outputTokens;
}

const USAGE_TYPES = new Set(["MODEL_USAGE", "assistant.usage", "session.usage_info"]);

function isToolStart(type: string | undefined): boolean {
  return type === "TOOL_CALL" || type === "tool.execution_start";
}

function asRecord(data: unknown): Record<string, unknown> {
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

function readNum(d: Record<string, unknown>, keys: readonly string[]): number {
  for (const k of keys) {
    const v = d[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return 0;
}

function readStr(d: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = d[k];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

/** Returns the numeric value of a single field, or `null` if absent/non-finite. */
function readNullableNum(d: Record<string, unknown>, key: string): number | null {
  const v = d[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function extractMetrics(events: readonly MetricEntry[]): Metrics {
  const usageByRequest = new Map<string, UsageTotals>();
  const seenToolIds = new Set<string>();
  let toolCalls = 0;

  for (const ev of events) {
    if (isToolStart(ev.type)) {
      const d = asRecord(ev.data);
      // Dedup only when the SDK gives us an explicit tool-call identity;
      // without one, count each event (cannot prove it is a duplicate).
      // Include tool name in the callNumber key so distinct tools with the
      // same callNumber are not collapsed (mirrors agentEventTypes.ts keying).
      const name = readStr(d, ["name", "tool", "toolName"]) ?? "unknown";
      const numericCall = typeof d["callNumber"] === "number" ? `${name}#${d["callNumber"]}` : null;
      const id = readStr(d, ["callId", "toolCallId", "id"]) ?? numericCall;
      if (id !== null) {
        if (seenToolIds.has(id)) continue;
        seenToolIds.add(id);
      }
      toolCalls++;
      continue;
    }

    if (ev.type !== undefined && USAGE_TYPES.has(ev.type) && ev.data && typeof ev.data === "object") {
      const d = ev.data as Record<string, unknown>;
      const input = readNum(d, ["input_tokens", "inputTokens", "promptTokens"]);
      const output = readNum(d, ["output_tokens", "outputTokens", "completionTokens"]);
      const cacheRead = readNum(d, ["cache_read", "cacheReadTokens", "cache_read_tokens"]);
      const cacheWrite = readNum(d, ["cache_write", "cacheWriteTokens", "cache_write_tokens"]);
      const model = readStr(d, ["model", "modelId"]);
      // Use nullable reads for cost/nanoAiu so explicit 0 and absent produce
      // different key components — matching computeCycleCost's signature.
      const cost = readNullableNum(d, "cost");
      const nanoAiu = readNullableNum(d, "totalNanoAiu");
      const key =
        readStr(d, ["apiCallId", "providerCallId"]) ??
        `sig:${model ?? ""}|${input}|${output}|${cacheRead}|${cacheWrite}|${cost ?? ""}|${nanoAiu ?? ""}`;
      const existing = usageByRequest.get(key);
      if (existing) {
        // Keep the most complete snapshot for this request (live-then-final).
        existing.input = Math.max(existing.input, input);
        existing.output = Math.max(existing.output, output);
        existing.cacheRead = Math.max(existing.cacheRead, cacheRead);
        existing.cacheWrite = Math.max(existing.cacheWrite, cacheWrite);
      } else {
        usageByRequest.set(key, { input, output, cacheRead, cacheWrite });
      }
    }
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const u of usageByRequest.values()) {
    inputTokens += u.input;
    outputTokens += u.output;
    cacheRead += u.cacheRead;
    cacheWrite += u.cacheWrite;
  }

  return { toolCalls, inputTokens, outputTokens, cacheRead, cacheWrite };
}
