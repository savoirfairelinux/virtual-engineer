/**
 * Tests for the tool-authorization form state serialization helpers
 * (src/admin/ui/views/ConfigView/toolAuthorizationHelpers.ts).
 */
import { describe, it, expect } from "vitest";
import {
  CLAUDE_TOOL_CATALOG,
  COPILOT_TOOL_CATALOG,
  emptyToolAuthorization,
  getToolCatalog,
  loadToolAuthorization,
  serializeToolAuthorization,
  supportsToolAuthorization,
} from "../../src/admin/ui/views/ConfigView/toolAuthorizationHelpers.js";

describe("supportsToolAuthorization", () => {
  it("returns true for claude, copilot, aider, goose", () => {
    expect(supportsToolAuthorization("claude")).toBe(true);
    expect(supportsToolAuthorization("copilot")).toBe(true);
    expect(supportsToolAuthorization("aider")).toBe(true);
    expect(supportsToolAuthorization("goose")).toBe(true);
  });

  it("returns false for mock and undefined", () => {
    expect(supportsToolAuthorization("mock")).toBe(false);
    expect(supportsToolAuthorization(undefined)).toBe(false);
  });
});

describe("getToolCatalog", () => {
  it("returns the Claude catalog for claude", () => {
    expect(getToolCatalog("claude")).toBe(CLAUDE_TOOL_CATALOG);
    expect(CLAUDE_TOOL_CATALOG.map((t) => t.value)).toContain("Read");
    expect(CLAUDE_TOOL_CATALOG.map((t) => t.value)).toContain("Bash");
  });

  it("returns the Copilot catalog for copilot", () => {
    expect(getToolCatalog("copilot")).toBe(COPILOT_TOOL_CATALOG);
    expect(COPILOT_TOOL_CATALOG.map((t) => t.value)).toContain("shell");
    expect(COPILOT_TOOL_CATALOG.map((t) => t.value)).toContain("read_file");
  });

  it("returns an empty catalog for non-list providers", () => {
    expect(getToolCatalog("aider")).toEqual([]);
    expect(getToolCatalog("mock")).toEqual([]);
    expect(getToolCatalog(undefined)).toEqual([]);
  });
});

describe("loadToolAuthorization", () => {
  it("splits Claude known blocked tools into checkboxes and custom patterns into free text", () => {
    const state = loadToolAuthorization(
      { blockedTools: ["Bash", "Bash(curl:*)"] },
      "claude",
    );
    expect(state.blockedTools).toEqual(["Bash"]);
    expect(state.blockedToolsCustom).toBe("Bash(curl:*)");
  });

  it("loads Copilot blocked tools using the Copilot catalog", () => {
    const state = loadToolAuthorization(
      { blockedTools: ["write_file", "shell"] },
      "copilot",
    );
    expect(state.blockedTools).toEqual(["write_file", "shell"]);
    expect(state.blockedToolsCustom).toBe("");
  });

  it("loads Aider toggles with defaults", () => {
    const state = loadToolAuthorization({ suggestShellCommands: true }, "aider");
    expect(state.suggestShellCommands).toBe(true);
    expect(state.detectUrls).toBe(false);
    expect(state.git).toBe(true);
  });

  it("loads Goose developerExtension + gooseMode", () => {
    const state = loadToolAuthorization(
      { developerExtension: false, gooseMode: "chat" },
      "goose",
    );
    expect(state.developerExtension).toBe(false);
    expect(state.gooseMode).toBe("chat");
  });

  it("returns empty state for non-object input", () => {
    expect(loadToolAuthorization(null, "claude")).toEqual(emptyToolAuthorization());
    expect(loadToolAuthorization("x", "claude")).toEqual(emptyToolAuthorization());
  });
});

describe("serializeToolAuthorization", () => {
  it("merges Claude checkboxes + custom patterns and returns undefined when empty", () => {
    expect(serializeToolAuthorization(
      { ...emptyToolAuthorization(), blockedTools: ["Bash"], blockedToolsCustom: "Bash(rm:*)" },
      "claude",
    )).toEqual({ blockedTools: ["Bash", "Bash(rm:*)"] });

    expect(serializeToolAuthorization(emptyToolAuthorization(), "claude")).toBeUndefined();
  });

  it("serializes only custom patterns when no checkboxes selected", () => {
    expect(serializeToolAuthorization(
      { ...emptyToolAuthorization(), blockedToolsCustom: "Bash(rm:*)\nBash(curl:*)" },
      "claude",
    )).toEqual({ blockedTools: ["Bash(rm:*)", "Bash(curl:*)"] });
  });

  it("serializes Aider toggles", () => {
    expect(serializeToolAuthorization(
      { ...emptyToolAuthorization(), suggestShellCommands: true, git: false },
      "aider",
    )).toEqual({
      suggestShellCommands: true,
      detectUrls: false,
      playwright: false,
      git: false,
    });
  });

  it("serializes Goose toggles + gooseMode", () => {
    expect(serializeToolAuthorization(
      { ...emptyToolAuthorization(), developerExtension: false, gooseMode: "chat" },
      "goose",
    )).toEqual({ developerExtension: false, gooseMode: "chat" });

    // gooseMode omitted when empty
    expect(serializeToolAuthorization(
      { ...emptyToolAuthorization(), developerExtension: true },
      "goose",
    )).toEqual({ developerExtension: true });
  });

  it("returns undefined for unsupported providers", () => {
    expect(serializeToolAuthorization(emptyToolAuthorization(), "mock")).toBeUndefined();
    expect(serializeToolAuthorization(emptyToolAuthorization(), undefined)).toBeUndefined();
  });
});
