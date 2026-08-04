/**
 * Tests for the shared tool-authorization env-var mapper
 * (src/agents/toolAuthorization.ts).
 */
import { describe, it, expect } from "vitest";
import {
  extractToolAuthorization,
  toolAuthorizationJsonEnv,
  toolListEnv,
} from "../../src/agents/toolAuthorization.js";

describe("extractToolAuthorization", () => {
  it("extracts the toolAuthorization sub-object from providerOptions", () => {
    expect(extractToolAuthorization({ toolAuthorization: { blockedTools: ["Read"] } }))
      .toEqual({ blockedTools: ["Read"] });
  });

  it("returns undefined when missing or not a plain object", () => {
    expect(extractToolAuthorization(undefined)).toBeUndefined();
    expect(extractToolAuthorization({})).toBeUndefined();
    expect(extractToolAuthorization({ toolAuthorization: "x" })).toBeUndefined();
    expect(extractToolAuthorization({ toolAuthorization: null })).toBeUndefined();
    expect(extractToolAuthorization({ toolAuthorization: [] })).toBeUndefined();
  });
});

describe("toolListEnv", () => {
  it("maps blockedTools to CLAUDE_BLOCKED_TOOLS (newline-separated)", () => {
    expect(toolListEnv("claude", { blockedTools: ["Read", "Edit"] }))
      .toEqual({ CLAUDE_BLOCKED_TOOLS: "Read\nEdit" });
  });

  it("maps to COPILOT_BLOCKED_TOOLS for the copilot provider", () => {
    expect(toolListEnv("copilot", { blockedTools: ["shell"] }))
      .toEqual({ COPILOT_BLOCKED_TOOLS: "shell" });
  });

  it("omits empty arrays and missing keys", () => {
    expect(toolListEnv("claude", { blockedTools: [] })).toEqual({});
    expect(toolListEnv("claude", {})).toEqual({});
    expect(toolListEnv("claude", undefined)).toEqual({});
  });

  it("accepts a newline-separated string and trims/drops empties", () => {
    expect(toolListEnv("claude", { blockedTools: "Read\n\n  Edit  " }))
      .toEqual({ CLAUDE_BLOCKED_TOOLS: "Read\nEdit" });
  });
});

describe("toolAuthorizationJsonEnv", () => {
  it("serializes the toggles to TOOL_AUTHORIZATION_JSON", () => {
    expect(toolAuthorizationJsonEnv({ developerExtension: false }))
      .toEqual({ TOOL_AUTHORIZATION_JSON: JSON.stringify({ developerExtension: false }) });
  });

  it("returns {} for undefined/empty", () => {
    expect(toolAuthorizationJsonEnv(undefined)).toEqual({});
    expect(toolAuthorizationJsonEnv({})).toEqual({});
  });
});
