import { describe, it, expect, vi } from "vitest";
import { createClaudeDescriptor } from "../../src/plugins/descriptors/claude.js";
import { CLAUDE_SUBSCRIPTION_MODELS } from "../../src/agents/claudeModelsService.js";

describe("createClaudeDescriptor", () => {
  it("declares the agent_execution capability and a redirect OAuth flow", () => {
    const d = createClaudeDescriptor();
    expect(d.provider).toBe("claude");
    expect(d.capabilities.agent_execution).toBeDefined();
    expect(d.oauth?.mode).toBe("redirect");
    expect(d.oauth?.tokenField).toBe("sessionToken");
  });

  it("builds an adapter from host runtime context (self-describing, no index.ts wiring)", () => {
    const d = createClaudeDescriptor();
    const buildAdapter = d.capabilities.agent_execution?.buildAdapter;
    expect(buildAdapter).toBeDefined();
    const adapter = buildAdapter!({ maxCommitsPerCycle: 5, dockerNetwork: "ve-net" });
    expect(adapter.name).toBe("claude");
  });

  it("returns the curated model list for subscription mode", async () => {
    const d = createClaudeDescriptor();
    const models = await d.discoverModels!({ authMode: "subscription" });
    expect(models).toEqual(CLAUDE_SUBSCRIPTION_MODELS);
  });

  it("discovers models from the Anthropic API in api_key mode", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "claude-x", display_name: "Claude X" }] }), { status: 200 })
    );
    const d = createClaudeDescriptor();
    const models = await d.discoverModels!({ authMode: "api_key", apiKey: "sk-ant-key" });
    expect(models).toEqual([{ id: "claude-x", name: "Claude X" }]);
    fetchSpy.mockRestore();
  });

  it("throws when api_key mode has no key", async () => {
    const d = createClaudeDescriptor();
    await expect(d.discoverModels!({ authMode: "api_key" })).rejects.toThrow(/api key/i);
  });
});
