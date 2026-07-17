import { describe, expect, it, vi } from "vitest";
import { loadWorkerPrompts } from "../../agent-worker/src/promptLoader.js";

describe("loadWorkerPrompts", () => {
  it("loads a multiline system prompt from base64 and the user prompt from file", () => {
    const readFile = vi.fn(() => "Review this diff.\n");
    const result = loadWorkerPrompts({
      SYSTEM_PROMPT_BASE64: Buffer.from("System line one\nSystem line two", "utf8").toString("base64"),
      USER_PROMPT_FILE: "/tmp/review-prompt.txt",
    }, readFile);

    expect(result).toEqual({
      systemPrompt: "System line one\nSystem line two",
      userPrompt: "Review this diff.",
      systemPromptSource: "base64",
      userPromptSource: "file",
    });
    expect(readFile).toHaveBeenCalledWith("/tmp/review-prompt.txt", "utf8");
  });

  it("uses an inline system prompt when base64 is absent", () => {
    const result = loadWorkerPrompts({
      SYSTEM_PROMPT: "Inline system prompt",
      USER_PROMPT_FILE: "/tmp/prompt.txt",
    }, () => "User prompt");

    expect(result.systemPrompt).toBe("Inline system prompt");
    expect(result.systemPromptSource).toBe("env");
  });

  it("prefers base64 when both system prompt transports are present", () => {
    const result = loadWorkerPrompts({
      SYSTEM_PROMPT: "inline",
      SYSTEM_PROMPT_BASE64: Buffer.from("encoded", "utf8").toString("base64"),
      USER_PROMPT_FILE: "/tmp/prompt.txt",
    }, () => "User prompt");

    expect(result.systemPrompt).toBe("encoded");
    expect(result.systemPromptSource).toBe("base64");
  });

  it.each([
    ["missing system prompt", { USER_PROMPT_FILE: "/tmp/prompt.txt" }, (): string => "User prompt"],
    ["missing user prompt file", { SYSTEM_PROMPT: "System" }, (): string => "User prompt"],
    ["empty user prompt", { SYSTEM_PROMPT: "System", USER_PROMPT_FILE: "/tmp/prompt.txt" }, (): string => "  \n"],
  ])("rejects %s", (_label, env, readFile) => {
    expect(() => loadWorkerPrompts(env, readFile)).toThrow();
  });
});