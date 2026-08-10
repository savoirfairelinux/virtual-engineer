import { describe, expect, it } from "vitest";
import {
  buildAgentModelConfig,
  normalizeAgentReviewForm,
  serializeProviderOptions,
} from "../../src/admin/ui/views/ConfigView/agentFormProviderOptions.js";
import type { ApiPlugin, PluginField } from "../../src/admin/ui/types.js";

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

describe("native review agent form", () => {
  const copilotPlugin: ApiPlugin = {
    provider: "copilot",
    name: "Copilot",
    capabilities: [],
    domainCapabilities: ["agent_execution"],
    requiredFields: [],
    agentConfigFields: [
      { key: "reasoningEffort", label: "Reasoning effort", type: "select" },
    ],
    reviewStrategies: [{
      id: "copilot_native",
      label: "Copilot native review",
      description: "Delegate to the CLI code-review agent",
      experimental: true,
      modelSelection: "provider",
      requiredSystemPromptId: "system_review",
    }],
  };

  it("locks native review fields from descriptor metadata", () => {
    expect(normalizeAgentReviewForm({
      type: "review",
      reviewStrategy: "copilot_native",
      model: "gpt-5",
      systemPromptId: "custom_system",
      feedbackInstructionsPromptId: "feedback",
      providerOptions: { reasoningEffort: "high", futureFlag: "enabled" },
    }, copilotPlugin)).toEqual({
      type: "review",
      reviewStrategy: "copilot_native",
      model: "",
      systemPromptId: "system_review",
      feedbackInstructionsPromptId: "",
      providerOptions: { futureFlag: "enabled" },
    });
  });

  it("resets native review when the selected provider does not advertise it", () => {
    expect(normalizeAgentReviewForm({
      type: "review",
      reviewStrategy: "copilot_native",
      model: "",
      systemPromptId: "system_review",
      feedbackInstructionsPromptId: "",
      providerOptions: {},
    }, { ...copilotPlugin, provider: "claude", reviewStrategies: [] }).reviewStrategy).toBe("ve_direct");
  });

  it("builds a canonical native model config and preserves unrelated options", () => {
    expect(buildAgentModelConfig({
      reviewStrategy: "copilot_native",
      model: "",
      providerOptions: { futureFlag: { enabled: true } },
      isEdit: true,
    })).toEqual({
      providerOptions: {
        futureFlag: { enabled: true },
        reviewStrategy: "copilot_native",
      },
    });
  });
});