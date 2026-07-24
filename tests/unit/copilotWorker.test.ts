import { describe, expect, it } from "vitest";
import {
  buildCopilotSessionConfig,
  buildCopilotSystemMessage,
} from "../../agent-worker/src/providers/copilot.js";

describe("Copilot worker native profile", () => {
  it("appends agent instructions to the Copilot CLI foundation explicitly", () => {
    expect(buildCopilotSystemMessage("permanent agent policy")).toEqual({
      mode: "append",
      content: "permanent agent policy",
    });
  });

  it("configures only the explicit VE submission MCP server for review", () => {
    const outputSchema = {
      type: "object",
      properties: { vote: { type: "integer", enum: [-1, 0, 1] } },
      required: ["vote"],
      additionalProperties: false,
    };

    const config = buildCopilotSessionConfig({
      model: "gpt-5.1-codex",
      agentInstructions: "review policy",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "review",
      reviewOutputSchema: outputSchema,
    }, []);

    expect(config.enableConfigDiscovery).toBe(false);
    expect(config.mcpServers).toEqual({
      "ve-submission": expect.objectContaining({
        type: "stdio",
        tools: ["ve_submit_review"],
      }),
    });
  });

  it("requires the coding completion tool without loading repository MCP config", () => {
    const config = buildCopilotSessionConfig({
      model: "gpt-5.1-codex",
      agentInstructions: "coding policy",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    }, []);

    expect(config.enableConfigDiscovery).toBe(false);
    expect(config.systemMessage).toEqual(expect.objectContaining({
      content: expect.stringContaining("ve_submit_changes"),
    }));
    expect(config.mcpServers).toEqual({
      "ve-submission": expect.objectContaining({
        tools: ["ve_submit_changes"],
      }),
    });
  });
});