import { describe, it, expect } from "vitest";
import {
  computeCycleCost,
  hasCostData,
  NANO_AIU_PER_CREDIT,
  USD_PER_CREDIT,
  USD_PER_PREMIUM_REQUEST,
} from "../../src/agents/cycleCost.js";
import type { AgentLogEvent } from "../../src/interfaces.js";

function usage(data: Record<string, unknown>): AgentLogEvent {
  return {
    type: "assistant.usage",
    timestamp: "2026-01-01T00:00:00.000Z",
    data,
    taskId: "task-1",
    cycleNumber: 1,
  };
}

describe("computeCycleCost", () => {
  it("returns an unpriced zero-cost result for no events", () => {
    const cost = computeCycleCost(undefined);
    expect(cost.priced).toBe(false);
    expect(cost.aiCredits).toBe(0);
    expect(cost.usd).toBe(0);
    expect(cost.premiumRequests).toBe(0);
    expect(cost.modelId).toBeNull();
    expect(hasCostData(cost)).toBe(false);
  });

  it("ignores non-usage events", () => {
    const events: AgentLogEvent[] = [
      { type: "assistant.message", timestamp: "t", data: { totalNanoAiu: 5e9 }, taskId: "t", cycleNumber: 1 },
    ];
    const cost = computeCycleCost(events);
    expect(cost.priced).toBe(false);
    expect(cost.aiCredits).toBe(0);
  });

  it("converts a single totalNanoAiu into AI credits and USD", () => {
    const cost = computeCycleCost([usage({ totalNanoAiu: 2 * NANO_AIU_PER_CREDIT })]);
    expect(cost.priced).toBe(true);
    expect(cost.aiCredits).toBe(2);
    expect(cost.usd).toBeCloseTo(2 * USD_PER_CREDIT, 10);
  });

  it("sums per-request usage across distinct requests", () => {
    const cost = computeCycleCost([
      usage({ apiCallId: "call-1", totalNanoAiu: 1 * NANO_AIU_PER_CREDIT, cost: 0.5, inputTokens: 100, outputTokens: 20 }),
      usage({ apiCallId: "call-2", totalNanoAiu: 3 * NANO_AIU_PER_CREDIT, cost: 1.5, inputTokens: 200, outputTokens: 30 }),
    ]);
    expect(cost.aiCredits).toBe(4);
    expect(cost.usd).toBeCloseTo(4 * USD_PER_CREDIT, 10);
    expect(cost.premiumRequests).toBeCloseTo(2.0, 10);
    expect(cost.tokens.input).toBe(300);
    expect(cost.tokens.output).toBe(50);
  });

  it("deduplicates repeated emissions of the same request by apiCallId", () => {
    const cost = computeCycleCost([
      usage({ apiCallId: "call-1", totalNanoAiu: 2 * NANO_AIU_PER_CREDIT, cost: 1.0, inputTokens: 100, outputTokens: 20 }),
      usage({ apiCallId: "call-1", totalNanoAiu: 2 * NANO_AIU_PER_CREDIT, cost: 1.0, inputTokens: 100, outputTokens: 20 }),
    ]);
    expect(cost.aiCredits).toBe(2);
    expect(cost.premiumRequests).toBeCloseTo(1.0, 10);
    expect(cost.tokens.input).toBe(100);
    expect(cost.tokens.output).toBe(20);
  });

  it("deduplicates byte-identical emissions that lack a call id (content signature)", () => {
    const cost = computeCycleCost([
      usage({ inputTokens: 14416, outputTokens: 3912, cacheReadTokens: 1536, model: "gpt-5.4-mini" }),
      usage({ inputTokens: 14416, outputTokens: 3912, cacheReadTokens: 1536, model: "gpt-5.4-mini" }),
    ]);
    expect(cost.tokens.input).toBe(14416);
    expect(cost.tokens.output).toBe(3912);
    expect(cost.tokens.cached).toBe(1536);
  });

  it("merges a partial then final emission of the same request", () => {
    const cost = computeCycleCost([
      usage({ apiCallId: "call-1", inputTokens: 100, outputTokens: 0 }),
      usage({ apiCallId: "call-1", inputTokens: 100, outputTokens: 50, cost: 1.0, totalNanoAiu: 1 * NANO_AIU_PER_CREDIT }),
    ]);
    expect(cost.tokens.input).toBe(100);
    expect(cost.tokens.output).toBe(50);
    expect(cost.premiumRequests).toBeCloseTo(1.0, 10);
    expect(cost.aiCredits).toBe(1);
  });

  it("sums token counts across distinct requests and resolves the last model id", () => {
    const cost = computeCycleCost([
      usage({ apiCallId: "a", inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1, model: "gpt-4.1" }),
      usage({ apiCallId: "b", inputTokens: 7, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 0, model: "claude-opus" }),
    ]);
    expect(cost.tokens.input).toBe(17);
    expect(cost.tokens.output).toBe(8);
    expect(cost.tokens.cached).toBe(6);
    expect(cost.tokens.cacheWrite).toBe(1);
    expect(cost.modelId).toBe("claude-opus");
  });

  it("estimates USD from the premium-request multiplier when nano-AIU is absent", () => {
    const cost = computeCycleCost([usage({ cost: 0.25, inputTokens: 50, outputTokens: 10 })]);
    expect(cost.priced).toBe(false);
    expect(cost.premiumRequests).toBeCloseTo(0.25, 10);
    expect(cost.usd).toBeCloseTo(0.25 * USD_PER_PREMIUM_REQUEST, 10);
    expect(cost.aiCredits).toBe(0);
    expect(hasCostData(cost)).toBe(true);
  });

  it("prefers authoritative nano-AIU pricing over the premium-request estimate", () => {
    const cost = computeCycleCost([usage({ totalNanoAiu: 2 * NANO_AIU_PER_CREDIT, cost: 5 })]);
    expect(cost.priced).toBe(true);
    expect(cost.usd).toBeCloseTo(2 * USD_PER_CREDIT, 10);
  });

  it("skips malformed usage payloads without throwing", () => {
    const events: AgentLogEvent[] = [
      { type: "assistant.usage", timestamp: "t", data: null as unknown as Record<string, unknown>, taskId: "t", cycleNumber: 1 },
      { type: "assistant.usage", timestamp: "t", data: "oops" as unknown as Record<string, unknown>, taskId: "t", cycleNumber: 1 },
      usage({ totalNanoAiu: NANO_AIU_PER_CREDIT }),
    ];
    const cost = computeCycleCost(events);
    expect(cost.aiCredits).toBe(1);
  });

  it("ignores non-finite numeric fields", () => {
    const cost = computeCycleCost([usage({ totalNanoAiu: Number.NaN, inputTokens: Number.POSITIVE_INFINITY })]);
    expect(cost.priced).toBe(false);
    expect(cost.tokens.input).toBe(0);
  });
});
