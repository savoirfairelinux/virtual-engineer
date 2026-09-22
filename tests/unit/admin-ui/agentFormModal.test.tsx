/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentFormModal } from "../../../src/admin/ui/views/ConfigView/AgentFormModal.js";
import type { ApiIntegration, ApiPlugin, ApiPrompt } from "../../../src/admin/ui/types.js";

const copilotIntegration: ApiIntegration = {
  id: "copilot-1",
  provider: "copilot",
  name: "GitHub Copilot",
  enabled: true,
  capabilities: ["agent_execution"],
  domainCapabilities: ["agent_execution"],
};

const cachedCopilotIntegration: ApiIntegration = {
  id: "copilot-cached",
  provider: "copilot",
  name: "Cached Copilot",
  enabled: true,
  capabilities: ["agent_execution"],
  domainCapabilities: ["agent_execution"],
  discoveredResources: {
    models: [{ id: "claude-sonnet", name: "Claude Sonnet" }],
  },
};

const copilotPlugin: ApiPlugin = {
  provider: "copilot",
  name: "GitHub Copilot",
  capabilities: ["agent_execution"],
  domainCapabilities: ["agent_execution"],
  requiredFields: [],
  agentConfigFields: [],
};

const prompts: ApiPrompt[] = [
  {
    id: "system",
    label: "System",
    content: "System",
    promptType: "system",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "instructions",
    label: "Instructions",
    content: "Instructions",
    promptType: "instructions",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

describe("AgentFormModal model discovery", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("distinguishes duplicate labels in every prompt selector", () => {
    render(<AgentFormModal
      integrations={[]}
      plugins={[]}
      prompts={prompts.flatMap(prompt => [
        { ...prompt, builtin: true },
        { ...prompt, id: `${prompt.id}-copy-one` },
        { ...prompt, id: `${prompt.id}-copy-two` },
      ])}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />);
    for (const [field, type, label] of [
      ["System Prompt", "system", "System"],
      ["Instructions Prompt", "instructions", "Instructions"],
      ["Feedback Instructions Prompt", "instructions", "Instructions"],
    ]) {
      const select = screen.getByRole("combobox", { name: new RegExp(`^${field}`) }) as HTMLSelectElement;
      expect(Array.from(select.options).slice(1).map(option => [option.value, option.text])).toEqual([
        [type, `${label} (built-in)`],
        [`${type}-copy-one`, `${label} (${type}-copy-one)`],
        [`${type}-copy-two`, `${label} (${type}-copy-two)`],
      ]);
    }
  });

  it("loads Copilot models through the model discovery endpoint", async () => {
    const requestedPaths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      requestedPaths.push(path);
      if (path === "/api/admin/integrations/copilot-1/models/discover") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (path === "/api/admin/integrations/copilot-1/models") {
        return new Response(JSON.stringify({
          models: [{ id: "gpt-4o", name: "GPT-4o", vendor: "OpenAI", version: "gpt-4o" }],
        }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${path}`);
    }));

    render(
      <AgentFormModal
        integrations={[copilotIntegration]}
        plugins={[copilotPlugin]}
        prompts={prompts}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("option", { name: /GPT-4o/ })).toBeTruthy();
    });
    expect(screen.getByLabelText("Model").tagName).toBe("SELECT");
    expect(requestedPaths).toEqual([
      "/api/admin/integrations/copilot-1/models/discover",
      "/api/admin/integrations/copilot-1/models",
    ]);
  });

  it("enables cached models after switching away from a pending discovery", async () => {
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      const path = String(input);
      if (path === "/api/admin/integrations/copilot-1/models/discover") {
        return new Promise<Response>(() => {});
      }
      throw new Error(`Unexpected request: ${path}`);
    }));

    render(
      <AgentFormModal
        integrations={[copilotIntegration, cachedCopilotIntegration]}
        plugins={[copilotPlugin]}
        prompts={prompts}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect((screen.getByLabelText("Model") as HTMLInputElement).disabled).toBe(true);
    });
    fireEvent.change(screen.getByRole("combobox", { name: /Agent Integration/ }), {
      target: { value: "copilot-cached" },
    });

    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Claude Sonnet" })).toBeTruthy();
    });
    expect((screen.getByLabelText("Model") as HTMLSelectElement).disabled).toBe(false);
  });
});