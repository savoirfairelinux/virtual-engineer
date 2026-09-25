/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PoliciesSection } from "../../../src/admin/ui/views/ConfigView/PoliciesSection.js";
import { EMPTY_LIST_FILTER } from "../../../src/admin/ui/views/ConfigView/listFilters.js";
import type { ConfigSectionProps } from "../../../src/admin/ui/views/ConfigView/index.js";
import type { ApiAgent, ApiIntegration, ApiProject, ApiPrompt } from "../../../src/admin/ui/types.js";

const integrations: ApiIntegration[] = [
  { id: "redmine-1", provider: "redmine", name: "Redmine", enabled: true, capabilities: [], domainCapabilities: [] },
  { id: "copilot-1", provider: "copilot", name: "Copilot", enabled: true, capabilities: [], domainCapabilities: [] },
];
const agents: ApiAgent[] = [{
  id: "agent-1", name: "Coder", type: "coding", integrationId: "copilot-1", enabled: true, maxConcurrent: 1,
  model: null, reviewStrategy: "ve_direct", systemPromptId: "system_generic_code", instructionsPromptId: "prompt-1",
  feedbackInstructionsPromptId: null, createdAt: "", updatedAt: "",
}];
const prompts: ApiPrompt[] = [
  { id: "system_generic_code", label: "System", content: "", promptType: "system", builtin: true, updatedAt: "" },
  { id: "prompt-1", label: "Team prompt", content: "", promptType: "instructions", updatedAt: "" },
];
const projects: ApiProject[] = [
  { id: "proj-1", name: "Firmware", type: "coding", enabled: true, agentId: "agent-1", createdAt: "", updatedAt: "" },
];

function props(mode: "edit" | "list"): ConfigSectionProps {
  return {
    integrations, plugins: [], agents, projects, prompts, oauthApps: [],
    config: null, status: null, onRefresh: vi.fn(),
    route: mode === "edit" ? { section: "policies", mode: "edit", id: "pol-1" } : { section: "policies", mode: "list" },
    navigate: vi.fn(), markClean: vi.fn(), setDirty: vi.fn(),
    listFilter: EMPTY_LIST_FILTER, onListFilterChange: vi.fn(),
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function stubApi(onPut: (body: unknown) => void): void {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/admin/policies/pol-1" && (!init?.method || init.method === "GET")) {
      return json({ policy: { id: "pol-1", name: "Share", description: "", builtin: false, createdAt: "", updatedAt: "", rules: [], bindings: [{ id: "b1", policyId: "pol-1", principalType: "group", principalId: "grp-1" }] } });
    }
    if (path === "/api/admin/policies/pol-1/rules" && init?.method === "PUT") {
      onPut(JSON.parse(String(init.body)));
      return json({ rules: [] });
    }
    if (path === "/api/admin/users") return json({ users: [] });
    if (path === "/api/admin/groups") return json({ groups: [{ id: "grp-1", name: "Readers", description: "", createdAt: "", updatedAt: "" }] });
    if (path === "/api/admin/policies") {
      return json({ policies: [{ id: "pol-1", name: "Share", description: "", builtin: false, createdAt: "", updatedAt: "", ruleCount: 1, bindingCount: 1, bindings: [{ principalType: "group", principalId: "grp-1", principalName: "Readers" }] }] });
    }
    if (path === "/api/admin/projects/proj-1") {
      return json({ project: { ...projects[0], ticketSource: { integration: { id: "redmine-1" } }, pushTargets: [] } });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
  }));
}

describe("PoliciesSection rules editor", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("grants read access on a specific integration", async () => {
    let saved: unknown;
    stubApi((body) => { saved = body; });
    render(<PoliciesSection {...props("edit")} />);

    const group = await screen.findByRole("region", { name: "Integrations" });
    expect(screen.getByRole("region", { name: "Tasks (by project)" })).toBeTruthy();
    fireEvent.change(within(group).getByRole("combobox"), { target: { value: "redmine-1" } });
    expect(within(group).getByText("Redmine (redmine-1)")).toBeTruthy();
    fireEvent.click(within(group).getByRole("checkbox", { name: "Read" }));
    fireEvent.click(screen.getByRole("button", { name: "Save rules" }));

    await waitFor(() => expect(saved).toEqual({ rules: [{ permission: "integration.read", resourceId: "redmine-1" }] }));
  });

  it("shows group names with ids in assignments", async () => {
    stubApi(() => undefined);
    render(<PoliciesSection {...props("edit")} />);
    expect(await screen.findByText("Readers (grp-1)", { selector: "div" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Readers (grp-1)" })).toBeTruthy();
  });

  it("adds a project's linked resources with read access", async () => {
    stubApi(() => undefined);
    render(<PoliciesSection {...props("edit")} />);

    const projectGroup = await screen.findByRole("region", { name: "Projects" });
    fireEvent.change(within(projectGroup).getByRole("combobox"), { target: { value: "proj-1" } });

    await screen.findByText(/Added linked resources with Read access/);
    const agentsGroup = screen.getByRole("region", { name: "Agents" });
    expect(within(agentsGroup).getByText("Coder (agent-1)")).toBeTruthy();
    expect((within(agentsGroup).getByRole("checkbox", { name: "Read" }) as HTMLInputElement).checked).toBe(true);
    const integrationsGroup = screen.getByRole("region", { name: "Integrations" });
    expect(within(integrationsGroup).getByText("Copilot (copilot-1)")).toBeTruthy();
    expect(within(integrationsGroup).getByText("Redmine (redmine-1)")).toBeTruthy();
    const promptsGroup = screen.getByRole("region", { name: "Prompts" });
    expect(within(promptsGroup).getByText("Team prompt (prompt-1)")).toBeTruthy();
    expect(within(promptsGroup).getByRole("option", { name: "System (system_generic_code)" })).toBeTruthy();
  });

  it("lists assigned principal names in the policy list", async () => {
    stubApi(() => undefined);
    render(<PoliciesSection {...props("list")} />);
    expect(await screen.findByText("group: Readers (grp-1)")).toBeTruthy();
  });
});
