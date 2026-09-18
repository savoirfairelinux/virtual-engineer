/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CurrentUserProvider, makeCan, makeHasPermission } from "../../../src/admin/ui/authContext.js";
import { ConfigView, type ConfigViewData } from "../../../src/admin/ui/views/ConfigView/index.js";
import {
  canAccessConfigSection,
  canViewConfiguration,
} from "../../../src/admin/ui/views/ConfigView/configPermissions.js";
import type { ConfigSectionId } from "../../../src/admin/ui/views/ConfigView/configRouting.js";
import type { ApiAgent, ApiIntegration, ApiMe, ApiProject, ApiPrompt } from "../../../src/admin/ui/types.js";
import { api } from "../../../src/admin/ui/api.js";

const integration: ApiIntegration = {
  id: "integration-1",
  provider: "github",
  name: "Primary GitHub",
  enabled: true,
  capabilities: [],
  domainCapabilities: ["issue_tracking"],
};

const agent: ApiAgent = {
  id: "agent-1",
  name: "Coding agent",
  type: "coding",
  integrationId: integration.id,
  enabled: true,
  maxConcurrent: 1,
  model: "auto",
  reviewStrategy: "ve_direct",
  systemPromptId: null,
  instructionsPromptId: null,
  feedbackInstructionsPromptId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const project: ApiProject = {
  id: "project-1",
  name: "Scoped project",
  type: "coding",
  enabled: true,
  agentId: agent.id,
  ownerUserId: "limited-user",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const prompt: ApiPrompt = {
  id: "custom-prompt",
  label: "Custom prompt",
  content: "Instructions",
  promptType: "instructions",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const baseProps: ConfigViewData = {
  integrations: [integration],
  plugins: [],
  agents: [agent],
  projects: [project],
  prompts: [prompt],
  oauthApps: [],
  config: {
    nodeEnv: "test",
    logLevel: "silent",
    pollingIntervalMs: 30000,
    maxAgentCycles: 3,
    maxRetryAttempts: 5,
    agentTimeoutMs: 3600000,
    ticketCloseMaxRetries: 5,
    ticketCloseRetryMinTimeoutMs: 5000,
  },
  status: null,
  onRefresh: vi.fn(),
};

function renderWithGrants(hash: string, grants: Record<string, "*" | string[]>) {
  window.history.replaceState({}, "", hash);
  const user: ApiMe = {
    id: "limited-user",
    username: "limited",
    role: "viewer",
    capabilities: { superuser: false, grants },
  };
  return render(
    <CurrentUserProvider value={{
      user,
      isAdmin: false,
      canOperate: false,
      can: makeCan(user),
    }}>
      <ConfigView {...baseProps} />
    </CurrentUserProvider>,
  );
}

describe("Configuration PBAC", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves dynamic owner and registered-user grants against resource ownership", () => {
    const user: ApiMe = {
      id: "owner-1",
      username: "owner",
      role: "operator",
      capabilities: {
        superuser: false,
        grants: { "project.owner": ["project-1"] },
        resourceOwnerGrants: ["agent.write"],
        projectOwnerGrants: ["project.write"],
        registeredUserGrants: ["prompt.read"],
      },
    };
    const can = makeCan(user);

    expect(can("agent.write", "agent-1", "owner-1")).toBe(true);
    expect(can("agent.write", "agent-2", "owner-2")).toBe(false);
    expect(can("prompt.read", "legacy-prompt", null)).toBe(true);
    expect(can("prompt.read", "private-prompt", "owner-2")).toBe(false);
    expect(can("project.write", "project-1", "owner-2")).toBe(true);
    expect(makeHasPermission(user)("agent.write")).toBe(true);
  });

  it("loads and switches the selected group's existing project access", async () => {
    window.history.replaceState({}, "", "#config/projects/project-1");
    vi.spyOn(api, "get").mockResolvedValue({
      grants: [
        {
          groupId: "writers",
          groupName: "Writers",
          permissions: ["project.read", "project.write"],
        },
        {
          groupId: "operators",
          groupName: "Operators",
          permissions: ["project.read", "task.read", "task.operate"],
        },
      ],
      availableGroups: [
        { id: "writers", name: "Writers" },
        { id: "operators", name: "Operators" },
      ],
    });
    const user: ApiMe = {
      id: "limited-user",
      username: "project-owner",
      role: "operator",
      capabilities: {
        superuser: false,
        grants: {},
        resourceOwnerGrants: ["project.read", "project.owner"],
      },
    };

    render(
      <CurrentUserProvider value={{
        user,
        isAdmin: false,
        canOperate: true,
        can: makeCan(user),
      }}>
        <ConfigView {...baseProps} />
      </CurrentUserProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Access" }));

    await waitFor(() => {
      expect((screen.getByRole("checkbox", { name: "Edit project" }) as HTMLInputElement).checked).toBe(true);
    });
    expect((screen.getByRole("checkbox", { name: "Read tasks" }) as HTMLInputElement).checked).toBe(false);

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "operators" } });
    await waitFor(() => {
      expect((screen.getByRole("checkbox", { name: "Operate tasks" }) as HTMLInputElement).checked).toBe(true);
    });
    expect((screen.getByRole("checkbox", { name: "Edit project" }) as HTMLInputElement).checked).toBe(false);
  });

  it.each<[ConfigSectionId, string]>([
    ["overview", "overview.read"],
    ["integrations", "integration.read"],
    ["oauth", "oauth.read"],
    ["agents", "agent.read"],
    ["projects", "project.read"],
    ["prompts", "prompt.read"],
    ["users", "user.manage"],
    ["groups", "policy.manage"],
    ["policies", "policy.manage"],
    ["audit", "audit.read"],
    ["system", "system.read"],
  ])("maps %s visibility to %s", (section, permission) => {
    const user: ApiMe = {
      id: "viewer-with-grant",
      username: "viewer-with-grant",
      role: "viewer",
      capabilities: { superuser: false, grants: { [permission]: "*" } },
    };
    const hasPermission = makeHasPermission(user);

    expect(canAccessConfigSection(hasPermission, section)).toBe(true);
    expect(canViewConfiguration(hasPermission)).toBe(true);
  });

  it("shows Projects for a user with only scoped project read grants", () => {
    renderWithGrants("#config/projects", { "project.read": [project.id] });

    expect(screen.getByRole("heading", { name: "Projects" })).toBeDefined();
    expect(screen.getByRole("button", { name: /Projects/, current: "page" })).toBeDefined();
  });

  it("shows only granted sections and falls back from a denied deep link", () => {
    renderWithGrants("#config/projects", { "prompt.read": "*" });

    expect(screen.getByRole("heading", { name: "Prompts" })).toBeDefined();
    const navigation = screen.getByRole("complementary", { name: "Configuration sections" });
    expect(within(navigation).getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
      "Setup & workflow",
    ]);
    expect(within(navigation).getByRole("button", { name: /Prompts/ })).toBeDefined();
    expect(within(navigation).queryByRole("button", { name: /Projects/ })).toBeNull();
    expect(within(navigation).queryByRole("button", { name: /Overview/ })).toBeNull();
  });

  it("uses separate integration write, operate, and delete permissions", () => {
    const { unmount } = renderWithGrants("#config/integrations", {
      "integration.read": "*",
      "integration.create": "*",
      "integration.write": "*",
    });

    expect(screen.getByRole("button", { name: "Add integration" })).toBeDefined();
    expect(screen.queryByRole("switch", { name: "Integration Primary GitHub enabled" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();

    unmount();
    renderWithGrants("#config/integrations", {
      "integration.read": "*",
      "integration.operate": "*",
      "integration.delete": "*",
    });

    expect(screen.queryByRole("button", { name: "Add integration" })).toBeNull();
    expect(screen.getByRole("switch", { name: "Integration Primary GitHub enabled" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Delete" })).toBeDefined();
  });

  it("rejects direct create routes without the required create permission", () => {
    renderWithGrants("#config/agents/new", { "agent.read": "*" });

    expect(screen.getByRole("heading", { name: "Agents library" })).toBeDefined();
    expect(screen.queryByRole("heading", { name: "New agent" })).toBeNull();
  });

  it("applies scoped project permissions to row mutations", () => {
    renderWithGrants("#config/projects", {
      "project.read": "*",
      "project.write": [project.id],
      "project.operate": [project.id],
    });

    expect(screen.queryByRole("button", { name: "New project" })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit" })).toBeDefined();
    expect(screen.getByRole("switch", { name: "Project Scoped project enabled" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("gates agent, prompt, OAuth, and System mutations by exact permission", () => {
    const { unmount: unmountAgent } = renderWithGrants("#config/agents", {
      "agent.read": "*",
      "agent.create": "*",
      "agent.write": "*",
    });
    expect(screen.getByRole("button", { name: "New agent" })).toBeDefined();
    expect(screen.queryByRole("switch", { name: "Agent Coding agent enabled" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    unmountAgent();

    const { unmount: unmountPrompt } = renderWithGrants("#config/prompts", {
      "prompt.read": "*",
      "prompt.create": "*",
      "prompt.write": "*",
    });
    expect(screen.getByRole("button", { name: "New prompt" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    unmountPrompt();

    const { unmount: unmountOAuth } = renderWithGrants("#config/oauth", {
      "oauth.read": "*",
      "oauth.create": "*",
    });
    expect(screen.getByRole("button", { name: "Register app" })).toBeDefined();
    unmountOAuth();

    renderWithGrants("#config/system", { "system.read": "*" });
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    for (const input of screen.getAllByRole("spinbutton")) {
      expect((input as HTMLInputElement).disabled).toBe(true);
    }
  });
});