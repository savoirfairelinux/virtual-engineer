import { describe, it, expect } from "vitest";
import { extractMetrics } from "../../src/admin/ui/views/TasksView/liveMetrics.js";
import type { MetricEntry } from "../../src/admin/ui/views/TasksView/liveMetrics.js";

function usage(data: Record<string, unknown>): MetricEntry {
  return { type: "assistant.usage", data };
}

function toolStart(data: Record<string, unknown> = {}): MetricEntry {
  return { type: "tool.execution_start", data };
}

describe("extractMetrics", () => {
  it("sums token usage across distinct requests", () => {
    const m = extractMetrics([
      usage({ apiCallId: "a", inputTokens: 100, outputTokens: 50 }),
      usage({ apiCallId: "b", inputTokens: 200, outputTokens: 100 }),
    ]);
    expect(m.inputTokens).toBe(300);
    expect(m.outputTokens).toBe(150);
  });

  it("counts duplicate usage emissions for the same request only once", () => {
    // Each request's usage event is emitted twice into the live stream.
    const m = extractMetrics([
      usage({ apiCallId: "req-1", input_tokens: 120, output_tokens: 40 }),
      usage({ apiCallId: "req-1", input_tokens: 120, output_tokens: 40 }),
    ]);
    expect(m.inputTokens).toBe(120);
    expect(m.outputTokens).toBe(40);
  });

  it("dedups by content signature when no apiCallId is present", () => {
    const m = extractMetrics([
      usage({ input_tokens: 80, output_tokens: 20 }),
      usage({ input_tokens: 80, output_tokens: 20 }),
    ]);
    expect(m.inputTokens).toBe(80);
    expect(m.outputTokens).toBe(20);
  });

  it("keeps the most complete snapshot per request (live-then-final)", () => {
    const m = extractMetrics([
      usage({ apiCallId: "r", input_tokens: 100, output_tokens: 0 }),
      usage({ apiCallId: "r", input_tokens: 100, output_tokens: 60 }),
    ]);
    expect(m.inputTokens).toBe(100);
    expect(m.outputTokens).toBe(60);
  });

  it("counts duplicate tool.execution_start events once by callId", () => {
    const m = extractMetrics([
      toolStart({ name: "read_file", callId: "read_file_1" }),
      toolStart({ name: "read_file", callId: "read_file_1" }),
      toolStart({ name: "grep", callId: "grep_2" }),
    ]);
    expect(m.toolCalls).toBe(2);
  });

  it("counts duplicate tool starts once by callNumber when callId is absent", () => {
    const m = extractMetrics([
      toolStart({ name: "read_file", callNumber: 1 }),
      toolStart({ name: "read_file", callNumber: 1 }),
    ]);
    expect(m.toolCalls).toBe(1);
  });

  it("counts every tool start when no identity is available", () => {
    const m = extractMetrics([toolStart(), toolStart()]);
    expect(m.toolCalls).toBe(2);
  });

  it("aggregates cache read/write token fields", () => {
    const m = extractMetrics([
      usage({ apiCallId: "a", cache_read: 30, cache_write: 10 }),
      usage({ apiCallId: "b", cacheReadTokens: 5, cacheWriteTokens: 2 }),
    ]);
    expect(m.cacheRead).toBe(35);
    expect(m.cacheWrite).toBe(12);
  });

  it("treats identical token counts from different models as distinct requests", () => {
    // Two requests with the same token counts but different models must NOT be
    // collapsed into one by the fallback signature.
    const m = extractMetrics([
      usage({ input_tokens: 100, output_tokens: 50, model: "gpt-4o" }),
      usage({ input_tokens: 100, output_tokens: 50, model: "claude-3-5-sonnet" }),
    ]);
    expect(m.inputTokens).toBe(200);
    expect(m.outputTokens).toBe(100);
  });

  it("still dedups same-model identical emissions when apiCallId is absent", () => {
    const m = extractMetrics([
      usage({ input_tokens: 80, output_tokens: 20, model: "gpt-4o" }),
      usage({ input_tokens: 80, output_tokens: 20, model: "gpt-4o" }),
    ]);
    expect(m.inputTokens).toBe(80);
    expect(m.outputTokens).toBe(20);
  });

  it("treats cost=0 and cost-absent as distinct signature components", () => {
    // A request with explicit cost=0 must not be merged with a request where
    // cost is absent (which also has the same token counts).
    const m = extractMetrics([
      usage({ input_tokens: 100, output_tokens: 50, model: "gpt-4o", cost: 0 }),
      usage({ input_tokens: 100, output_tokens: 50, model: "gpt-4o" }),
    ]);
    expect(m.inputTokens).toBe(200);
    expect(m.outputTokens).toBe(100);
  });
});
