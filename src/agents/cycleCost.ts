import type { AgentLogEvent, CycleCost } from "../interfaces.js";

/** 1 GitHub AI credit = 1 AI Unit (AIU) = 1e9 nano-AIU. */
export const NANO_AIU_PER_CREDIT = 1_000_000_000;

/** 1 GitHub AI credit = $0.01 USD. */
export const USD_PER_CREDIT = 0.01;

/**
 * GitHub Copilot overage rate for one premium request ($0.04). Used to estimate
 * USD when the SDK reports the premium-request multiplier (`cost`) but not the
 * authoritative `totalNanoAiu`.
 */
export const USD_PER_PREMIUM_REQUEST = 0.04;

function readNum(data: Record<string, unknown>, key: string): number | null {
  const value = data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readStr(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Larger of two nullable numbers; null only when both are null. */
function pickMax(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/** Merged usage for a single LLM request (one `apiCallId`). */
interface RequestUsage {
  nanoAiu: number | null;
  cost: number | null;
  input: number;
  output: number;
  cached: number;
  cacheWrite: number;
}

/**
 * Compute the cost of a single agent cycle from its captured `assistant.usage`
 * events. The Copilot SDK reports usage **per LLM request**: `cost` (model
 * multiplier) and the nested `copilotUsage.totalNanoAiu` (GitHub-computed
 * nano-AI-Units) are each scoped to one request. A cycle makes many requests,
 * so the cycle total is their SUM.
 *
 * The SDK can emit the same request's usage more than once (e.g. a duplicate or
 * a live-then-final pair), so events are first grouped by request identity
 * (`apiCallId`/`providerCallId`, falling back to a content signature) and the
 * most complete snapshot is kept per request; only then are distinct requests
 * summed. This avoids double-counting duplicate emissions while still totalling
 * genuine multi-request cycles.
 */
export function computeCycleCost(events: readonly AgentLogEvent[] | undefined): CycleCost {
  const requests = new Map<string, RequestUsage>();
  let modelId: string | null = null;

  for (const event of events ?? []) {
    if (event.type !== "assistant.usage") continue;
    if (!event.data || typeof event.data !== "object") continue;
    const data = event.data as Record<string, unknown>;

    const nanoAiu = readNum(data, "totalNanoAiu");
    const cost = readNum(data, "cost");
    const input = readNum(data, "inputTokens") ?? 0;
    const output = readNum(data, "outputTokens") ?? 0;
    const cached = readNum(data, "cacheReadTokens") ?? 0;
    const cacheWrite = readNum(data, "cacheWriteTokens") ?? 0;
    const model = readStr(data, "model");
    if (model !== null) modelId = model;

    const key =
      readStr(data, "apiCallId") ??
      readStr(data, "providerCallId") ??
      `sig:${model ?? ""}|${input}|${output}|${cached}|${cacheWrite}|${cost ?? ""}|${nanoAiu ?? ""}`;

    const existing = requests.get(key);
    if (existing) {
      existing.nanoAiu = pickMax(existing.nanoAiu, nanoAiu);
      existing.cost = pickMax(existing.cost, cost);
      existing.input = Math.max(existing.input, input);
      existing.output = Math.max(existing.output, output);
      existing.cached = Math.max(existing.cached, cached);
      existing.cacheWrite = Math.max(existing.cacheWrite, cacheWrite);
    } else {
      requests.set(key, { nanoAiu, cost, input, output, cached, cacheWrite });
    }
  }

  let nanoAiu = 0;
  let priced = false;
  let premiumRequests = 0;
  let input = 0;
  let output = 0;
  let cached = 0;
  let cacheWrite = 0;
  for (const request of requests.values()) {
    if (request.nanoAiu !== null) {
      nanoAiu += request.nanoAiu;
      priced = true;
    }
    if (request.cost !== null) premiumRequests += request.cost;
    input += request.input;
    output += request.output;
    cached += request.cached;
    cacheWrite += request.cacheWrite;
  }

  const aiCredits = nanoAiu / NANO_AIU_PER_CREDIT;
  // Authoritative GitHub-computed cost when nano-AIU is present; otherwise fall
  // back to estimating USD from the premium-request multiplier.
  const usd = priced ? aiCredits * USD_PER_CREDIT : premiumRequests * USD_PER_PREMIUM_REQUEST;

  return {
    priced,
    aiCredits,
    usd,
    premiumRequests,
    tokens: { input, output, cached, cacheWrite },
    modelId,
  };
}

/** True when the cost object carries any signal worth persisting or surfacing. */
export function hasCostData(cost: CycleCost): boolean {
  return cost.priced
    || cost.premiumRequests > 0
    || cost.tokens.input > 0
    || cost.tokens.output > 0
    || cost.tokens.cached > 0
    || cost.tokens.cacheWrite > 0
    || cost.modelId !== null;
}
