import { describe, expect, it } from "vitest";
import { serializeProviderOptions } from "../../src/admin/ui/views/ConfigView/agentFormProviderOptions.js";
import type { PluginField } from "../../src/admin/ui/types.js";

describe("serializeProviderOptions", () => {
  it("preserves unknown existing options and removes cleared known fields", () => {
    const fields: PluginField[] = [
      { key: "effort", label: "Effort", type: "select" },
      { key: "maxTurns", label: "Maximum turns", type: "number", valueType: "number" },
    ];

    expect(serializeProviderOptions(
      fields,
      { effort: "", maxTurns: "12" },
      { effort: "high", futureFlag: { enabled: true } },
    )).toEqual({
      maxTurns: 12,
      futureFlag: { enabled: true },
    });
  });
});