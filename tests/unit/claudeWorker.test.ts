import { describe, expect, it } from "vitest";
import { buildClaudeQueryOptions } from "../../agent-worker/src/providers/claude.js";

describe("Claude worker native profile", () => {
  it("preserves the Claude Code preset for review and requests structured output", () => {
    const outputSchema = {
      type: "object",
      properties: { vote: { enum: [-1, 0, 1] } },
      required: ["vote"],
      additionalProperties: false,
    };

    const options = buildClaudeQueryOptions({
      model: "claude-sonnet-4-6",
      agentInstructions: "review policy",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "review",
      reviewOutputSchema: outputSchema,
    });

    expect(options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "review policy",
    });
    expect(options.outputFormat).toEqual({ type: "json_schema", schema: outputSchema });
    expect(options.tools).toEqual(["Read", "Glob", "Grep"]);
    expect(options.permissionMode).toBe("dontAsk");
  });

  it("maps advanced effort, thinking, turn, and cost limits to the SDK", () => {
    const options = buildClaudeQueryOptions({
      model: "claude-opus-4-6",
      agentInstructions: "policy",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    }, {
      effort: "max",
      thinkingMode: "enabled",
      thinkingBudgetTokens: 12_000,
      maxTurns: 30,
      maxBudgetUsd: 8.5,
    });

    expect(options).toMatchObject({
      effort: "max",
      thinking: { type: "enabled", budgetTokens: 12_000 },
      maxTurns: 30,
      maxBudgetUsd: 8.5,
    });
  });
});