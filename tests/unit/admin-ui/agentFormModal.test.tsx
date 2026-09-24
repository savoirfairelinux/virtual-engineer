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

  it("refreshes cached Copilot models on demand", async () => {
    const requestedPaths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      requestedPaths.push(path);
      if (path === "/api/admin/integrations/copilot-cached/models/discover") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (path === "/api/admin/integrations/copilot-cached/models") {
        return new Response(JSON.stringify({ models: [{ id: "gpt-4.1", name: "GPT-4.1" }] }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${path}`);
    }));

    render(
      <AgentFormModal
        integrations={[cachedCopilotIntegration]}
        plugins={[copilotPlugin]}
        prompts={prompts}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(screen.getByRole("option", { name: "Claude Sonnet" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));

    await waitFor(() => {
      expect(screen.getByRole("option", { name: "GPT-4.1" })).toBeTruthy();
    });
    expect(requestedPaths).toEqual([
      "/api/admin/integrations/copilot-cached/models/discover",
      "/api/admin/integrations/copilot-cached/models",
    ]);
  });

  it("uses each Copilot model's reasoning efforts and defaults unsupported models", () => {
    render(<AgentFormModal
      integrations={[{
        ...cachedCopilotIntegration,
        discoveredResources: {
          models: [
            { id: "reasoning", name: "Reasoning", supportedReasoningEfforts: ["low", "high"] },
            { id: "no-reasoning", name: "No reasoning" },
          ],
        },
      }]}
      plugins={[{
        ...copilotPlugin,
        agentConfigFields: [{
          key: "reasoningEffort", label: "Reasoning Effort", type: "select", required: false,
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
          ],
        }],
      }]}
      prompts={prompts}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />);

    fireEvent.click(screen.getByRole("button", { name: /Provider settings/ }));
    const effort = screen.getByLabelText("Reasoning Effort") as HTMLSelectElement;
    expect(Array.from(effort.options).map(option => option.value)).toEqual([""]);

    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "reasoning" } });
    expect(Array.from(effort.options).map(option => option.value)).toEqual(["", "low", "high"]);
    fireEvent.change(effort, { target: { value: "high" } });
    expect(effort.value).toBe("high");

    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "no-reasoning" } });
    expect(Array.from(effort.options).map(option => option.value)).toEqual([""]);
    expect(effort.value).toBe("");
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "reasoning" } });
    expect(effort.value).toBe("");
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

  it("does not retain the previous integration's models when discovery fails", async () => {
    const nextIntegration: ApiIntegration = {
      ...copilotIntegration,
      id: "copilot-no-cache",
      name: "Copilot without cached models",
    };
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: "Model discovery unavailable" }),
      { status: 502, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AgentFormModal
        integrations={[cachedCopilotIntegration, nextIntegration]}
        plugins={[copilotPlugin]}
        prompts={prompts}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(screen.getByRole("option", { name: "Claude Sonnet" })).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: /Agent Integration/ }), {
      target: { value: "copilot-no-cache" },
    });

    await waitFor(() => expect(screen.getByText("Model discovery unavailable")).toBeTruthy());
    expect(screen.queryByRole("option", { name: "Claude Sonnet" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/integrations/copilot-no-cache/models/discover",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("keeps current integration models after a failed manual refresh", async () => {
    let failDiscovery = false;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path === "/api/admin/integrations/copilot-cached/models/discover") {
        return failDiscovery
          ? new Response(JSON.stringify({ error: "Model refresh unavailable" }), {
            status: 502,
            headers: { "content-type": "application/json" },
          })
          : new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (path === "/api/admin/integrations/copilot-cached/models") {
        return new Response(JSON.stringify({ models: [{ id: "claude-sonnet", name: "Claude Sonnet" }] }), {
          status: 200,
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    }));

    render(
      <AgentFormModal
        integrations={[cachedCopilotIntegration]}
        plugins={[copilotPlugin]}
        prompts={prompts}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(screen.getByRole("option", { name: "Claude Sonnet" })).toBeTruthy();
    failDiscovery = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));

    await waitFor(() => expect(screen.getByText("Model refresh unavailable")).toBeTruthy());
    expect(screen.getByRole("option", { name: "Claude Sonnet" })).toBeTruthy();
  });

  it.each([
    { efforts: ["low", "high"], expected: "high" },
    { efforts: ["low"], expected: undefined },
    { efforts: [], expected: undefined },
  ])("saves only supported reasoning from existing agent settings: $efforts", async ({ efforts, expected }) => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onSaved = vi.fn();
    render(<AgentFormModal
      agent={{
        id: "agent-1", name: "Reviewer", type: "review", integrationId: "copilot-cached",
        enabled: true, maxConcurrent: 1, model: "model", reviewStrategy: "ve_direct",
        systemPromptId: "system", instructionsPromptId: "instructions", feedbackInstructionsPromptId: null,
        modelConfig: { model: "model", providerOptions: { reasoningEffort: "high", otherOption: "keep" } },
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      }}
      integrations={[{
        ...cachedCopilotIntegration,
        discoveredResources: { models: [{ id: "model", name: "Model", supportedReasoningEfforts: efforts }] },
      }]}
      plugins={[{
        ...copilotPlugin,
        agentConfigFields: [{
          key: "reasoningEffort", label: "Reasoning Effort", type: "select", required: false,
          options: [{ value: "low", label: "Low" }, { value: "high", label: "High" }],
        }],
      }]}
      prompts={prompts}
      onClose={vi.fn()}
      onSaved={onSaved}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/agents/agent-1", expect.objectContaining({
      method: "PUT",
      body: expect.any(String),
    }));
    const request = (fetchMock.mock.calls as unknown[][])[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as { modelConfig: { providerOptions: Record<string, unknown> } };
    expect(body.modelConfig.providerOptions["reasoningEffort"]).toBe(expected);
    expect(body.modelConfig.providerOptions["otherOption"]).toBe("keep");
  });
});