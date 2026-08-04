/**
 * Tests for host-side tool-authorization validation
 * (src/agents/toolAuthorizationValidation.ts).
 */
import { describe, it, expect } from "vitest";
import {
  validateToolAuthorization,
  normalizeModelConfigToolAuthorization,
  ToolAuthorizationConfigError,
  NETWORK_FLOOR_TOOLS,
  REVIEW_FLOOR_TOOLS,
} from "../../src/agents/toolAuthorizationValidation.js";

describe("validateToolAuthorization (Claude/Copilot)", () => {
  it("accepts valid blockedTools", () => {
    const result = validateToolAuthorization("claude", "coding", {
      blockedTools: ["Read", "Edit", "Bash(rm:*)"],
    });
    expect(result).toEqual({
      blockedTools: ["Read", "Edit", "Bash(rm:*)"],
    });
  });

  it("accepts mcp__server__tool patterns in blockedTools", () => {
    const result = validateToolAuthorization("copilot", "coding", {
      blockedTools: ["mcp__ve-submission__ve_submit_changes"],
    });
    expect(result).toEqual({ blockedTools: ["mcp__ve-submission__ve_submit_changes"] });
  });

  it("rejects allowedTools (no longer supported)", () => {
    expect(() => validateToolAuthorization("claude", "coding", { allowedTools: ["Read"] }))
      .toThrow(/allowedTools is not supported/i);
  });

  it("rejects blocking a review-floor tool for review-type agents", () => {
    expect(() => validateToolAuthorization("claude", "review", { blockedTools: ["Read"] }))
      .toThrow(/required for review/i);
    expect(() => validateToolAuthorization("claude", "review", { blockedTools: ["Grep"] }))
      .toThrow(/required for review/i);
  });

  it("allows blocking a review-floor tool for coding agents", () => {
    const result = validateToolAuthorization("claude", "coding", { blockedTools: ["Read"] });
    expect(result).toEqual({ blockedTools: ["Read"] });
  });

  it("rejects malformed patterns", () => {
    expect(() => validateToolAuthorization("claude", "coding", { blockedTools: ["Read; rm -rf /"] }))
      .toThrow(/not a valid tool pattern/i);
  });

  it("rejects more than 100 entries", () => {
    const many = Array.from({ length: 101 }, (_, i) => `Tool${i}`);
    expect(() => validateToolAuthorization("claude", "coding", { blockedTools: many }))
      .toThrow(/at most 100/);
  });

  it("rejects non-array tool lists", () => {
    expect(() => validateToolAuthorization("claude", "coding", { blockedTools: "Read" }))
      .toThrow(/must be an array/);
  });

  it("returns undefined for absent toolAuthorization", () => {
    expect(validateToolAuthorization("claude", "coding", undefined)).toBeUndefined();
    expect(validateToolAuthorization("claude", "coding", null)).toBeUndefined();
  });
});

describe("validateToolAuthorization (Aider)", () => {
  it("accepts boolean toggles and chatMode", () => {
    const result = validateToolAuthorization("aider", "coding", {
      suggestShellCommands: true,
      detectUrls: false,
      playwright: false,
      git: true,
      autoLint: true,
      autoTest: false,
      chatMode: "architect",
    });
    expect(result).toEqual({
      suggestShellCommands: true,
      detectUrls: false,
      playwright: false,
      git: true,
      autoLint: true,
      autoTest: false,
      chatMode: "architect",
    });
  });

  it("rejects unknown keys", () => {
    expect(() => validateToolAuthorization("aider", "coding", { unknownToggle: true }))
      .toThrow(/not supported by the 'aider'/i);
  });

  it("rejects invalid chatMode", () => {
    expect(() => validateToolAuthorization("aider", "coding", { chatMode: "invalid" }))
      .toThrow(/chatMode must be/);
  });

  it("rejects non-boolean toggles", () => {
    expect(() => validateToolAuthorization("aider", "coding", { git: "yes" }))
      .toThrow(/must be a boolean/);
  });
});

describe("validateToolAuthorization (Goose)", () => {
  it("accepts developerExtension and gooseMode", () => {
    const result = validateToolAuthorization("goose", "coding", {
      developerExtension: false,
      gooseMode: "chat",
    });
    expect(result).toEqual({ developerExtension: false, gooseMode: "chat" });
  });

  it("rejects invalid gooseMode", () => {
    expect(() => validateToolAuthorization("goose", "coding", { gooseMode: "invalid" }))
      .toThrow(/gooseMode must be one of/);
  });

  it("rejects unknown keys", () => {
    expect(() => validateToolAuthorization("goose", "coding", { blockedTools: ["Read"] }))
      .toThrow(/not supported by the 'goose'/i);
  });
});

describe("validateToolAuthorization (unsupported providers)", () => {
  it("rejects toolAuthorization for mock provider", () => {
    expect(() => validateToolAuthorization("mock", "coding", { blockedTools: ["Read"] }))
      .toThrow(/not supported by provider 'mock'/i);
  });

  it("returns undefined when provider is null/undefined", () => {
    expect(validateToolAuthorization(null, "coding", { blockedTools: ["Read"] })).toBeUndefined();
    expect(validateToolAuthorization(undefined, "coding", {})).toBeUndefined();
  });
});

describe("normalizeModelConfigToolAuthorization", () => {
  it("normalizes toolAuthorization inside providerOptions", () => {
    const modelConfig = {
      providerOptions: {
        toolAuthorization: { blockedTools: ["Read", "Edit"] },
      },
    };
    normalizeModelConfigToolAuthorization("claude", "coding", modelConfig);
    expect(modelConfig.providerOptions).toEqual({
      toolAuthorization: { blockedTools: ["Read", "Edit"] },
    });
  });

  it("removes toolAuthorization when it normalizes to undefined", () => {
    const modelConfig = { providerOptions: { toolAuthorization: null } };
    normalizeModelConfigToolAuthorization("claude", "coding", modelConfig);
    expect(modelConfig.providerOptions).not.toHaveProperty("toolAuthorization");
  });

  it("throws on invalid toolAuthorization", () => {
    const modelConfig = { providerOptions: { toolAuthorization: { allowedTools: ["Read"] } } };
    expect(() => normalizeModelConfigToolAuthorization("claude", "coding", modelConfig))
      .toThrow(ToolAuthorizationConfigError);
  });

  it("is a no-op when providerOptions is absent", () => {
    const modelConfig = { model: "claude-sonnet" };
    normalizeModelConfigToolAuthorization("claude", "coding", modelConfig);
    expect(modelConfig).toEqual({ model: "claude-sonnet" });
  });
});

describe("floor constants", () => {
  it("NETWORK_FLOOR_TOOLS includes the web tools and network bash rules", () => {
    expect(NETWORK_FLOOR_TOOLS.has("WebFetch")).toBe(true);
    expect(NETWORK_FLOOR_TOOLS.has("WebSearch")).toBe(true);
    expect(NETWORK_FLOOR_TOOLS.has("Bash(curl:*)")).toBe(true);
    expect(NETWORK_FLOOR_TOOLS.has("Bash(git push:*)")).toBe(true);
  });

  it("REVIEW_FLOOR_TOOLS includes the read-only review tools", () => {
    expect(REVIEW_FLOOR_TOOLS.has("Read")).toBe(true);
    expect(REVIEW_FLOOR_TOOLS.has("Glob")).toBe(true);
    expect(REVIEW_FLOOR_TOOLS.has("Grep")).toBe(true);
    expect(REVIEW_FLOOR_TOOLS.has("Skill")).toBe(true);
  });
});
