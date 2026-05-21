import { describe, it, expect } from "vitest";
import {
  normalizeAgentResult,
  getModifiedFileCount,
} from "../../src/agents/agentEventTypes.js";
import type { AgentResult } from "../../src/interfaces.js";

describe("agentEventTypes - Result Normalization", () => {
  describe("normalizeAgentResult", () => {
    it("should return flat array unchanged", () => {
      const result: AgentResult = {
        status: "success",
        modifiedFiles: ["src/main.ts", "src/utils.ts"],
        summary: "test",
        agentLogs: "test",
        metadata: { adapter: "copilot-sdk", model: "claude-sonnet" },
      };

      const normalized = normalizeAgentResult(result);

      expect(normalized.modifiedFiles).toEqual(["src/main.ts", "src/utils.ts"]);
    });

    it("should flatten repo-grouped format with single primary repo", () => {
      const result: AgentResult = {
        status: "success",
        modifiedFiles: {
          superproject: ["src/main.ts", "src/utils.ts"],
        },
        summary: "test",
        agentLogs: "test",
        metadata: { adapter: "copilot-sdk", model: "claude-sonnet" },
      };

      const normalized = normalizeAgentResult(result);

      expect(normalized.modifiedFiles).toEqual(["src/main.ts", "src/utils.ts"]);
    });

    it("should flatten repo-grouped format with multiple repos", () => {
      const result: AgentResult = {
        status: "success",
        modifiedFiles: {
          superproject: ["src/main.ts"],
          "core-lib": ["lib/util.ts", "lib/helpers.ts"],
          "ui-lib": ["components/button.tsx"],
        },
        summary: "test",
        agentLogs: "test",
        metadata: { adapter: "copilot-sdk", model: "claude-sonnet" },
      };

      const normalized = normalizeAgentResult(result);

      // Should flatten to ["src/main.ts", "core-lib/lib/util.ts", ...]
      expect(normalized.modifiedFiles).toContain("src/main.ts");
      expect(normalized.modifiedFiles).toContain("core-lib/lib/util.ts");
      expect(normalized.modifiedFiles).toContain("core-lib/lib/helpers.ts");
      expect(normalized.modifiedFiles).toContain("ui-lib/components/button.tsx");
      expect((normalized.modifiedFiles as string[]).length).toBe(4);
    });

    it("should return no_change status with empty array", () => {
      const result: AgentResult = {
        status: "no_change",
        modifiedFiles: [],
        summary: "test",
        agentLogs: "test",
        metadata: { adapter: "copilot-sdk", model: "claude-sonnet" },
      };

      const normalized = normalizeAgentResult(result);

      expect(normalized.status).toBe("no_change");
      expect(normalized.modifiedFiles).toEqual([]);
    });
  });

  describe("getModifiedFileCount", () => {
    it("should count flat array format", () => {
      const count = getModifiedFileCount(["src/main.ts", "src/utils.ts"]);
      expect(count).toBe(2);
    });

    it("should count repo-grouped format", () => {
      const count = getModifiedFileCount({
        superproject: ["src/main.ts"],
        "core-lib": ["lib/util.ts", "lib/helpers.ts"],
      });
      expect(count).toBe(3);
    });

    it("should return 0 for empty array", () => {
      const count = getModifiedFileCount([]);
      expect(count).toBe(0);
    });

    it("should return 0 for empty object", () => {
      const count = getModifiedFileCount({});
      expect(count).toBe(0);
    });

    it("should return 0 for null", () => {
      const count = getModifiedFileCount(null);
      expect(count).toBe(0);
    });

    it("should handle object with non-array values", () => {
      const count = getModifiedFileCount({
        superproject: ["src/main.ts"],
        core: "not-an-array", // invalid
      });
      expect(count).toBe(1);
    });
  });
});
