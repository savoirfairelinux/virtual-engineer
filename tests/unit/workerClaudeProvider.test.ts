import { describe, expect, it } from "vitest";
import { extractClaudeToolName, normalizeClaudeUsage } from "../../agent-worker/src/providers/claude.js";

describe("Claude worker provider", () => {
  it("returns the precise tool name", () => {
    expect(extractClaudeToolName({ type: "tool_use", name: "Bash" })).toBe("Bash");
  });

  it.each([
    { type: "tool_use" },
    { type: "tool_use", name: "" },
    { type: "tool_use", name: "   " },
  ])("rejects a tool block without a precise name", (block) => {
    expect(extractClaudeToolName(block)).toBeNull();
  });

  it("preserves the Claude message id as the usage request identity", () => {
    expect(normalizeClaudeUsage({
      id: "msg_01ABC",
      usage: { input_tokens: 100, output_tokens: 25 },
    }, "claude-sonnet-4-6")).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      model: "claude-sonnet-4-6",
      providerCallId: "msg_01ABC",
    });
  });
});