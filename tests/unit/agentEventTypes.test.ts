import { describe, it, expect, beforeEach } from "vitest";
import {
  sanitizeValue,
  sanitizeEventData,
  normalizeAgentEvent,
  createSessionMetrics,
  updateSessionMetrics,
  resetSessionMetrics,
  type NormalizedAgentEvent,
  type SessionMetrics,
} from "../../src/agents/agentEventTypes.js";

// ── sanitizeValue ───────────────────────────────────────────────────────────

describe("sanitizeValue", () => {
  it("redacts GitHub personal access tokens (ghp_)", () => {
    const input = "token is ghp_ABCDEFghijklmnopqrstuvwxyz012345678901";
    expect(sanitizeValue(input)).not.toContain("ghp_");
    expect(sanitizeValue(input)).toContain("[REDACTED]");
  });

  it("redacts github_pat_ tokens", () => {
    const input = "auth github_pat_ABCDEFGHIJKLMNOPQRSTUV1234";
    expect(sanitizeValue(input)).not.toContain("github_pat_");
    expect(sanitizeValue(input)).toContain("[REDACTED]");
  });

  it("redacts Bearer tokens", () => {
    const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig";
    expect(sanitizeValue(input)).not.toContain("eyJhbGci");
    expect(sanitizeValue(input)).toContain("[REDACTED]");
  });

  it("redacts key=value secrets", () => {
    const input = "api_key=sk-12345abcdef password: mySecret123";
    const result = sanitizeValue(input);
    expect(result).not.toContain("sk-12345");
    expect(result).not.toContain("mySecret123");
  });

  it("preserves non-secret strings", () => {
    const input = "Reading file src/index.ts completed successfully";
    expect(sanitizeValue(input)).toBe(input);
  });

  it("redacts RSA private key blocks", () => {
    const input = "key: -----BEGIN RSA PRIVATE KEY-----\nMIIBog...\n-----END RSA PRIVATE KEY-----";
    expect(sanitizeValue(input)).toContain("[REDACTED]");
    expect(sanitizeValue(input)).not.toContain("MIIBog");
  });

  it("redacts ed25519 (OPENSSH) private key blocks", () => {
    const input = "key: -----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA...\n-----END OPENSSH PRIVATE KEY-----";
    expect(sanitizeValue(input)).toContain("[REDACTED]");
    expect(sanitizeValue(input)).not.toContain("b3BlbnNzaC1rZXktdjEAAAAA");
  });
});

// ── sanitizeEventData ───────────────────────────────────────────────────────

describe("sanitizeEventData", () => {
  it("returns null for null/undefined input", () => {
    expect(sanitizeEventData(null)).toBeNull();
    expect(sanitizeEventData(undefined)).toBeNull();
  });

  it("wraps non-object values", () => {
    expect(sanitizeEventData("hello")).toEqual({ value: "hello" });
    expect(sanitizeEventData(42)).toEqual({ value: 42 });
  });

  it("redacts keys named 'token'", () => {
    const result = sanitizeEventData({ name: "test", token: "secret123" });
    expect(result).toEqual({ name: "test", token: "[REDACTED]" });
  });

  it("redacts keys containing 'password'", () => {
    const result = sanitizeEventData({ user: "admin", password: "hunter2" });
    expect(result).toEqual({ user: "admin", password: "[REDACTED]" });
  });

  it("redacts keys containing 'secret'", () => {
    const result = sanitizeEventData({ clientSecret: "abc123" });
    expect(result).toEqual({ clientSecret: "[REDACTED]" });
  });

  it("deep-sanitizes nested objects", () => {
    const result = sanitizeEventData({
      tool: "read_file",
      input: { path: "/src/index.ts", authorization: "Bearer xyz" },
    });
    expect(result).toEqual({
      tool: "read_file",
      input: { path: "/src/index.ts", authorization: "[REDACTED]" },
    });
  });

  it("sanitizes string values within arrays", () => {
    const result = sanitizeEventData({
      args: ["normal", "Bearer eyJtoken"],
    });
    const args = (result as Record<string, unknown>)["args"] as string[];
    expect(args[0]).toBe("normal");
    expect(args[1]).toContain("[REDACTED]");
  });

  it("preserves non-secret data", () => {
    const input = { name: "read_file", status: "success", duration: 42 };
    expect(sanitizeEventData(input)).toEqual(input);
  });

  it("preserves session usage info token metrics", () => {
    const input = {
      tokenLimit: 200000,
      currentTokens: 12000,
      systemTokens: 500,
      conversationTokens: 10500,
      toolDefinitionsTokens: 1000,
    };

    expect(sanitizeEventData(input)).toEqual(input);
  });
});

// ── normalizeAgentEvent ─────────────────────────────────────────────────────

describe("normalizeAgentEvent", () => {
  const baseEvent = {
    type: "tool.execution_start",
    timestamp: "2026-04-21T10:00:00.000Z",
    taskId: "task-1",
    cycleNumber: 1,
    data: { name: "read_file", input: { path: "/src/index.ts" } },
  };

  it("produces a NormalizedAgentEvent with correct category", () => {
    const result = normalizeAgentEvent(baseEvent);
    expect(result.type).toBe("tool.execution_start");
    expect(result.category).toBe("tools");
    expect(result.level).toBe("info");
    expect(result.taskId).toBe("task-1");
    expect(result.cycleNumber).toBe(1);
  });

  it("builds human-readable message for tool start", () => {
    const result = normalizeAgentEvent(baseEvent);
    expect(result.message).toContain("read_file");
    expect(result.message).toContain("/src/index.ts");
  });

  it("keeps the full bash command in tool start messages", () => {
    const result = normalizeAgentEvent({
      ...baseEvent,
      data: { name: "bash", input: { command: "git status && git diff -- src/admin/dashboard.ts" } },
    });
    expect(result.message).toContain("git status && git diff -- src/admin/dashboard.ts");
  });

  it("builds message for tool complete", () => {
    const result = normalizeAgentEvent({
      ...baseEvent,
      type: "tool.execution_complete",
      data: { name: "write_file", status: "success" },
    });
    expect(result.category).toBe("tools");
    expect(result.message).toContain("write_file");
  });

  it("categorizes session.error as errors", () => {
    const result = normalizeAgentEvent({
      ...baseEvent,
      type: "session.error",
      data: { message: "Rate limit exceeded" },
    });
    expect(result.category).toBe("errors");
    expect(result.level).toBe("error");
    expect(result.message).toContain("Rate limit exceeded");
  });

  it("categorizes assistant.usage as usage", () => {
    const result = normalizeAgentEvent({
      ...baseEvent,
      type: "assistant.usage",
      data: { inputTokens: 100, outputTokens: 50 },
    });
    expect(result.category).toBe("usage");
    expect(result.message).toContain("in:100");
    expect(result.message).toContain("out:50");
  });

  it("categorizes session.usage_info as usage", () => {
    const result = normalizeAgentEvent({
      ...baseEvent,
      type: "session.usage_info",
      data: { totalTokens: 500 },
    });
    expect(result.category).toBe("usage");
  });

  it("categorizes session.start as session", () => {
    const result = normalizeAgentEvent({
      ...baseEvent,
      type: "session.start",
      data: {},
    });
    expect(result.category).toBe("session");
  });

  it("categorizes session.end as session", () => {
    const result = normalizeAgentEvent({
      ...baseEvent,
      type: "session.end",
      data: {},
    });
    expect(result.category).toBe("session");
  });

  it("categorizes permission.requested as session with warn level", () => {
    const result = normalizeAgentEvent({
      ...baseEvent,
      type: "permission.requested",
      data: { tool: "shell_exec" },
    });
    expect(result.category).toBe("session");
    expect(result.level).toBe("warn");
    expect(result.message).toContain("shell_exec");
  });

  it("categorizes stderr.line as all", () => {
    const result = normalizeAgentEvent({
      ...baseEvent,
      type: "stderr.line",
      data: { line: "some log output" },
    });
    expect(result.category).toBe("all");
    expect(result.message).toBe("some log output");
  });

  it("sanitizes data in normalized events", () => {
    const result = normalizeAgentEvent({
      ...baseEvent,
      data: { name: "test", token: "ghp_secrettoken123456789012345678901234" },
    });
    expect(result.data).toBeDefined();
    expect((result.data as Record<string, unknown>)["token"]).toBe("[REDACTED]");
  });

  it("handles assistant.streaming_delta as debug level", () => {
    const result = normalizeAgentEvent({
      ...baseEvent,
      type: "assistant.streaming_delta",
      data: { delta: "some text" },
    });
    expect(result.level).toBe("debug");
    expect(result.category).toBe("all");
  });

  it("handles tool.execution_progress", () => {
    const result = normalizeAgentEvent({
      ...baseEvent,
      type: "tool.execution_progress",
      data: { name: "shell_exec", message: "50% complete" },
    });
    expect(result.category).toBe("tools");
    expect(result.message).toContain("shell_exec");
    expect(result.message).toContain("50% complete");
  });
});

// ── SessionMetrics ──────────────────────────────────────────────────────────

describe("SessionMetrics", () => {
  let metrics: SessionMetrics;

  beforeEach(() => {
    metrics = createSessionMetrics();
  });

  it("starts with zero values", () => {
    expect(metrics.totalToolCalls).toBe(0);
    expect(metrics.activeToolName).toBeNull();
    expect(metrics.tokenUsage.inputTokens).toBe(0);
    expect(metrics.tokenUsage.outputTokens).toBe(0);
    expect(metrics.tokenUsage.cacheReadTokens).toBe(0);
    expect(metrics.tokenUsage.cacheWriteTokens).toBe(0);
    expect(metrics.usageEventCount).toBe(0);
    expect(metrics.quotaAvailable).toBe(false);
    expect(metrics.quotaMessage).toBeTruthy();
  });

  it("tracks tool calls on tool.execution_start", () => {
    const event = makeNormEvent("tool.execution_start", { name: "read_file" }, "tools");
    updateSessionMetrics(metrics, event);
    expect(metrics.totalToolCalls).toBe(1);
    expect(metrics.activeToolName).toBe("read_file");
    expect(metrics.tools["read_file"]).toBeDefined();
    expect(metrics.tools["read_file"]!.callCount).toBe(1);
    expect(metrics.tools["read_file"]!.lastStatus).toBe("running");
  });

  it("clears active tool on tool.execution_complete", () => {
    updateSessionMetrics(metrics, makeNormEvent("tool.execution_start", { name: "read_file" }, "tools"));
    updateSessionMetrics(metrics, makeNormEvent("tool.execution_complete", { name: "read_file", status: "success" }, "tools"));
    expect(metrics.activeToolName).toBeNull();
    expect(metrics.tools["read_file"]!.lastStatus).toBe("success");
  });

  it("tracks error status on tool completion", () => {
    updateSessionMetrics(metrics, makeNormEvent("tool.execution_start", { name: "shell_exec" }, "tools"));
    updateSessionMetrics(metrics, makeNormEvent("tool.execution_complete", { name: "shell_exec", status: "error" }, "tools"));
    expect(metrics.tools["shell_exec"]!.lastStatus).toBe("error");
  });

  it("counts multiple calls to the same tool", () => {
    updateSessionMetrics(metrics, makeNormEvent("tool.execution_start", { name: "read_file" }, "tools"));
    updateSessionMetrics(metrics, makeNormEvent("tool.execution_complete", { name: "read_file" }, "tools"));
    updateSessionMetrics(metrics, makeNormEvent("tool.execution_start", { name: "read_file" }, "tools"));
    updateSessionMetrics(metrics, makeNormEvent("tool.execution_complete", { name: "read_file" }, "tools"));
    expect(metrics.tools["read_file"]!.callCount).toBe(2);
    expect(metrics.totalToolCalls).toBe(2);
  });

  it("accumulates token usage from assistant.usage events", () => {
    updateSessionMetrics(metrics, makeNormEvent("assistant.usage", {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
    }, "usage"));
    expect(metrics.tokenUsage.inputTokens).toBe(100);
    expect(metrics.tokenUsage.outputTokens).toBe(50);
    expect(metrics.tokenUsage.cacheReadTokens).toBe(20);
    expect(metrics.tokenUsage.cacheWriteTokens).toBe(10);
    expect(metrics.tokenUsage.totalTokens).toBe(150);
    expect(metrics.usageEventCount).toBe(1);
  });

  it("keeps the latest cumulative token totals across usage events", () => {
    updateSessionMetrics(metrics, makeNormEvent("assistant.usage", { inputTokens: 100, outputTokens: 50 }, "usage"));
    updateSessionMetrics(metrics, makeNormEvent("assistant.usage", { inputTokens: 200, outputTokens: 100 }, "usage"));
    expect(metrics.tokenUsage.inputTokens).toBe(200);
    expect(metrics.tokenUsage.outputTokens).toBe(100);
    expect(metrics.tokenUsage.totalTokens).toBe(300);
    expect(metrics.usageEventCount).toBe(2);
  });

  it("does not double count assistant and session usage variants for the same turn", () => {
    updateSessionMetrics(metrics, makeNormEvent("assistant.usage", {
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      totalTokens: 150,
    }, "usage"));
    updateSessionMetrics(metrics, makeNormEvent("session.usage_info", {
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      totalTokens: 150,
    }, "usage"));

    expect(metrics.tokenUsage.inputTokens).toBe(120);
    expect(metrics.tokenUsage.outputTokens).toBe(30);
    expect(metrics.tokenUsage.cacheReadTokens).toBe(10);
    expect(metrics.tokenUsage.cacheWriteTokens).toBe(5);
    expect(metrics.tokenUsage.totalTokens).toBe(150);
    expect(metrics.usageEventCount).toBe(2);
  });

  it("handles session.usage_info with totalTokens only", () => {
    updateSessionMetrics(metrics, makeNormEvent("session.usage_info", { totalTokens: 500 }, "usage"));
    expect(metrics.tokenUsage.totalTokens).toBe(500);
  });

  it("tracks session start/end", () => {
    const startTime = "2026-04-21T10:00:00.000Z";
    const endTime = "2026-04-21T10:05:00.000Z";
    updateSessionMetrics(metrics, { ...makeNormEvent("session.start", {}, "session"), timestamp: startTime });
    expect(metrics.sessionStartTime).toBe(startTime);

    updateSessionMetrics(metrics, { ...makeNormEvent("session.end", {}, "session"), timestamp: endTime });
    expect(metrics.sessionEndTime).toBe(endTime);
    expect(metrics.activeToolName).toBeNull();
  });

  it("resets metrics correctly", () => {
    updateSessionMetrics(metrics, makeNormEvent("tool.execution_start", { name: "read_file" }, "tools"));
    updateSessionMetrics(metrics, makeNormEvent("assistant.usage", { inputTokens: 100 }, "usage"));
    resetSessionMetrics(metrics);
    expect(metrics.totalToolCalls).toBe(0);
    expect(metrics.activeToolName).toBeNull();
    expect(metrics.tokenUsage.inputTokens).toBe(0);
    expect(metrics.usageEventCount).toBe(0);
    expect(Object.keys(metrics.tools)).toHaveLength(0);
  });

  it("calculates tool duration from timestamps", () => {
    const start = makeNormEvent("tool.execution_start", { name: "write_file" }, "tools");
    start.timestamp = "2026-04-21T10:00:00.000Z";
    updateSessionMetrics(metrics, start);

    const complete = makeNormEvent("tool.execution_complete", { name: "write_file" }, "tools");
    complete.timestamp = "2026-04-21T10:00:02.500Z";
    updateSessionMetrics(metrics, complete);

    expect(metrics.tools["write_file"]!.lastDurationMs).toBe(2500);
    expect(metrics.tools["write_file"]!.totalDurationMs).toBe(2500);
  });

  it("ignores unknown event types without error", () => {
    expect(() => {
      updateSessionMetrics(metrics, makeNormEvent("unknown.event", {}, "all"));
    }).not.toThrow();
    expect(metrics.totalToolCalls).toBe(0);
  });

  it("quota is always unavailable (not exposed by SDK/CLI)", () => {
    expect(metrics.quotaAvailable).toBe(false);
    expect(metrics.quotaMessage).toBeTruthy();
    // Even after processing events, quota stays unavailable
    updateSessionMetrics(metrics, makeNormEvent("assistant.usage", { inputTokens: 100 }, "usage"));
    expect(metrics.quotaAvailable).toBe(false);
  });
});

// ── Deep-search in SDK event structures ─────────────────────────────────────

describe("normalizeAgentEvent — deep SDK structures", () => {
  const baseEvent = {
    type: "tool.execution_start",
    timestamp: "2026-04-21T10:00:00.000Z",
    taskId: "task-1",
    cycleNumber: 1,
    data: {},
  };

  it("extracts tool name from nested toolCall.function.name", () => {
    const result = normalizeAgentEvent({
      ...baseEvent,
      data: { toolCall: { function: { name: "write_to_file" } } },
    });
    expect(result.message).toContain("write_to_file");
  });

  it("extracts tool name from nested tool.name", () => {
    const result = normalizeAgentEvent({
      ...baseEvent,
      data: { tool: { name: "read_file" } },
    });
    expect(result.message).toContain("read_file");
  });

  it("extracts tool name from toolUse.name", () => {
    const result = normalizeAgentEvent({
      ...baseEvent,
      data: { toolUse: { name: "shell_exec" } },
    });
    expect(result.message).toContain("shell_exec");
  });

  it("extracts nested tool command from toolCall.function.arguments", () => {
    const result = normalizeAgentEvent({
      ...baseEvent,
      data: { toolCall: { function: { name: "bash", arguments: { command: "git status --short" } } } },
    });
    expect(result.message).toContain("bash");
    expect(result.message).toContain("git status --short");
  });

  it("extracts nested tool search pattern from toolCall.function.arguments", () => {
    const result = normalizeAgentEvent({
      ...baseEvent,
      data: { toolCall: { function: { name: "grep_search", arguments: { query: "tokenUsage" } } } },
    });
    expect(result.message).toContain("grep_search");
    expect(result.message).toContain("tokenUsage");
  });

  it("extracts assistant.message content from data.content", () => {
    const result = normalizeAgentEvent({
      ...baseEvent,
      type: "assistant.message",
      data: { data: { content: "I'll modify the file now" } },
    });
    expect(result.message).toContain("I'll modify the file now");
  });

  it("extracts assistant.message content from direct content", () => {
    const result = normalizeAgentEvent({
      ...baseEvent,
      type: "assistant.message",
      data: { content: "Direct content message" },
    });
    expect(result.message).toContain("Direct content message");
  });

  it("extracts usage tokens from nested usage object", () => {
    const result = normalizeAgentEvent({
      ...baseEvent,
      type: "assistant.usage",
      data: { usage: { inputTokens: 1500, outputTokens: 300 } },
    });
    expect(result.message).toContain("in:1500");
    expect(result.message).toContain("out:300");
  });

  it("extracts usage tokens from direct fields", () => {
    const result = normalizeAgentEvent({
      ...baseEvent,
      type: "assistant.usage",
      data: { inputTokens: 500, outputTokens: 200 },
    });
    expect(result.message).toContain("in:500");
    expect(result.message).toContain("out:200");
  });

  it("extracts session.usage_info tokens from nested data", () => {
    const result = normalizeAgentEvent({
      ...baseEvent,
      type: "session.usage_info",
      data: { usage: { totalTokens: 2000 } },
    });
    expect(result.message).toContain("total:2000");
  });

  it("extracts tool.execution_complete name from nested structure", () => {
    const result = normalizeAgentEvent({
      ...baseEvent,
      type: "tool.execution_complete",
      data: { tool: { name: "replace_string" }, status: "success" },
    });
    expect(result.message).toContain("replace_string");
    expect(result.message).toContain("success");
  });

  it("renders tool.execution_complete failures as failures", () => {
    const result = normalizeAgentEvent({
      ...baseEvent,
      type: "tool.execution_complete",
      data: { tool: { name: "shell_exec" }, status: "error" },
    });
    expect(result.message).toContain("shell_exec");
    expect(result.message).toContain("error");
    expect(result.message.startsWith("✗")).toBe(true);
  });

  it("falls back to generic message when no content found in assistant.message", () => {
    const result = normalizeAgentEvent({
      ...baseEvent,
      type: "assistant.message",
      data: {},
    });
    expect(result.message).toBe("assistant message");
  });

  it("falls back to generic message when no tokens found in usage", () => {
    const result = normalizeAgentEvent({
      ...baseEvent,
      type: "assistant.usage",
      data: {},
    });
    expect(result.message).toBe("📊 usage update");
  });
});

// ── Filter categories ───────────────────────────────────────────────────────

describe("normalizeAgentEvent — filter categories", () => {
  const base = {
    timestamp: "2026-04-21T10:00:00.000Z",
    taskId: "task-1",
    cycleNumber: 1,
    data: {},
  };

  it("categorizes non-tool stderr.line as 'all' (hidden when specific filter active)", () => {
    const result = normalizeAgentEvent({ ...base, type: "stderr.line", data: { line: "test" } });
    expect(result.category).toBe("all");
  });

  it("categorizes raw tool stderr lines as 'tools'", () => {
    const result = normalizeAgentEvent({ ...base, type: "stderr.line", data: { line: "[tool] #7 bash(git status)" } });
    expect(result.category).toBe("tools");
  });

  it("categorizes assistant.message as 'all'", () => {
    const result = normalizeAgentEvent({ ...base, type: "assistant.message", data: {} });
    expect(result.category).toBe("all");
  });

  it("categorizes tool events as 'tools'", () => {
    expect(normalizeAgentEvent({ ...base, type: "tool.execution_start", data: {} }).category).toBe("tools");
    expect(normalizeAgentEvent({ ...base, type: "tool.execution_complete", data: {} }).category).toBe("tools");
    expect(normalizeAgentEvent({ ...base, type: "tool.execution_progress", data: {} }).category).toBe("tools");
  });

  it("categorizes usage events as 'usage'", () => {
    expect(normalizeAgentEvent({ ...base, type: "assistant.usage", data: {} }).category).toBe("usage");
    expect(normalizeAgentEvent({ ...base, type: "session.usage_info", data: {} }).category).toBe("usage");
  });

  it("categorizes session.error as 'errors'", () => {
    expect(normalizeAgentEvent({ ...base, type: "session.error", data: {} }).category).toBe("errors");
  });

  it("does NOT leak 'all' category events into specific filter views", () => {
    // Category 'all' events should only appear when filter is 'all'
    const stderrEvent = normalizeAgentEvent({ ...base, type: "stderr.line", data: { line: "test" } });
    const msgEvent = normalizeAgentEvent({ ...base, type: "assistant.message", data: {} });
    // Both should be 'all' — not 'errors', not 'tools'
    expect(stderrEvent.category).toBe("all");
    expect(msgEvent.category).toBe("all");
    expect(stderrEvent.category).not.toBe("errors");
    expect(msgEvent.category).not.toBe("errors");
  });
});

// ── helpers ─────────────────────────────────────────────────────────────────

function makeNormEvent(
  type: string,
  data: Record<string, unknown>,
  category: "all" | "tools" | "usage" | "errors" | "session"
): NormalizedAgentEvent {
  return {
    type,
    timestamp: new Date().toISOString(),
    taskId: "task-1",
    cycleNumber: 1,
    message: "",
    category,
    data,
    level: "info",
  };
}
