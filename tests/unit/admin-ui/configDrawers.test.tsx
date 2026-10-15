/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  AgentDrawer,
  IntegrationDrawer,
  ProjectDrawer,
  agentReasoningEffort,
  integrationEndpoint,
} from "../../../src/admin/ui/views/ConfigView/ConfigDrawers.js";
import type { ApiAgent, ApiIntegration, ApiProject, ApiProjectDetail } from "../../../src/admin/ui/types.js";

function integration(provider: string, config: Record<string, string>, overrides: Partial<ApiIntegration> = {}): ApiIntegration {
  return {
    id: `int-${provider}`,
    provider,
    name: `${provider} main`,
    enabled: true,
    capabilities: [],
    domainCapabilities: [],
    config,
    ...overrides,
  };
}

function agent(overrides: Partial<ApiAgent> = {}): ApiAgent {
  return {
    id: "agent-1",
    name: "Coder",
    type: "coding",
    integrationId: "int-copilot",
    enabled: true,
    maxConcurrent: 2,
    model: "gpt-5",
    reviewStrategy: "ve_direct",
    systemPromptId: null,
    instructionsPromptId: null,
    feedbackInstructionsPromptId: null,
    modelConfig: { providerOptions: { reasoningEffort: "high" } },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    ...overrides,
  };
}

function rowValue(label: string): string | null {
  const key = screen.queryAllByText(label, { selector: ".detail-key" })[0];
  return key?.nextElementSibling?.textContent ?? null;
}

describe("integrationEndpoint", () => {
  it("uses SSH host and port for Gerrit, defaulting the port to 29418", () => {
    expect(integrationEndpoint(integration("gerrit", { sshHost: "review.example.com", sshPort: "2222" })))
      .toEqual({ host: "review.example.com", port: "2222" });
    expect(integrationEndpoint(integration("gerrit", { sshHost: "gerrit" })))
      .toEqual({ host: "gerrit", port: "29418" });
  });

  it("parses host and port from a base URL, inferring the scheme default", () => {
    expect(integrationEndpoint(integration("redmine", { baseUrl: "http://redmine:3000" })))
      .toEqual({ host: "redmine", port: "3000" });
    expect(integrationEndpoint(integration("gitlab", { gitlabMode: "self-hosted", baseUrl: "https://gitlab.example.com" })))
      .toEqual({ host: "gitlab.example.com", port: "443" });
  });

  it("falls back to the public SaaS host for GitHub.com and GitLab.com", () => {
    expect(integrationEndpoint(integration("github", { mode: "github.com" })))
      .toEqual({ host: "github.com", port: "443" });
    expect(integrationEndpoint(integration("gitlab", { gitlabMode: "gitlab.com" })))
      .toEqual({ host: "gitlab.com", port: "443" });
  });

  it("returns null when the integration has no network endpoint", () => {
    expect(integrationEndpoint(integration("copilot", {}))).toBeNull();
    expect(integrationEndpoint(integration("redmine", { baseUrl: "not a url" }))).toBeNull();
  });
});

describe("agentReasoningEffort", () => {
  it("reads the provider reasoning effort option", () => {
    expect(agentReasoningEffort(agent())).toBe("high");
    expect(agentReasoningEffort(agent({ modelConfig: {} }))).toBeNull();
  });
});

describe("Config drawers", () => {
  it("shows host and port in the integration drawer", () => {
    render(<IntegrationDrawer item={integration("gerrit", { sshHost: "review.example.com", sshPort: "29419" })} onClose={() => undefined} />);
    expect(rowValue("Host")).toBe("review.example.com");
    expect(rowValue("Port")).toBe("29419");
  });

  it("shows the agent integration and reasoning effort", () => {
    render(
      <AgentDrawer
        item={agent()}
        prompts={[]}
        integrations={[integration("copilot", {}, { name: "Copilot Org" })]}
        onClose={() => undefined}
      />,
    );
    expect(rowValue("Integration")).toBe("Copilot Org · copilot");
    expect(rowValue("Reasoning effort")).toBe("high");
  });

  it("shows provider default when no reasoning effort is configured", () => {
    render(<AgentDrawer item={agent({ modelConfig: {} })} prompts={[]} integrations={[]} onClose={() => undefined} />);
    expect(rowValue("Reasoning effort")).toBe("default");
    expect(rowValue("Integration")).toBe("int-copilot");
  });

  it("shows ticket source, push targets, and options for a coding project", () => {
    const project: ApiProject = {
      id: "proj-1",
      name: "Platform",
      type: "coding",
      enabled: true,
      agentId: "agent-1",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    };
    const detail: ApiProjectDetail = {
      ...project,
      skillSources: [{ source: "git@example.com:skills.git", skills: ["a", "b"] }],
      ticketSource: { integration: { id: "int-redmine", name: "Redmine", provider: "redmine" }, ticketProjectKey: "platform" },
      pushTargets: [{
        integrationId: "int-gerrit",
        repoKey: "platform/core",
        cloneUrl: "ssh://gerrit/platform/core",
        targetBranch: "main",
        role: "primary",
        commitOrder: 0,
        localPath: ".",
      }],
      gerritTopicOverride: "ve-topic",
      reactToCiFailures: true,
      postReviewLinkToTicket: false,
      useFullTicketUrlInCommits: true,
    };
    render(<ProjectDrawer item={project} detail={detail} agents={[agent()]} onClose={() => undefined} />);

    expect(rowValue("Ticket source")).toBe("Redmine · redmine");
    expect(rowValue("Ticket project")).toBe("platform");
    expect(screen.getByText("platform/core")).toBeTruthy();
    expect(screen.getByText("main · primary")).toBeTruthy();
    expect(rowValue("Gerrit topic")).toBe("ve-topic");
    expect(rowValue("React to CI failures")).toBe("yes");
    expect(rowValue("Post review link")).toBe("no");
    expect(rowValue("Skill sources")).toBe("1 source · 2 skills");
  });

  it("shows review integration, repositories, and assignment mode for a review project", () => {
    const project: ApiProject = {
      id: "proj-2",
      name: "Reviews",
      type: "review",
      enabled: true,
      agentId: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    };
    const detail: ApiProjectDetail = {
      ...project,
      reviewConfig: {
        integration: { id: "int-github", name: "GitHub", provider: "github" },
        repos: ["org/a", "org/b"],
        assignmentMode: "automatic",
      },
    };
    render(<ProjectDrawer item={project} detail={detail} agents={[]} onClose={() => undefined} />);

    expect(rowValue("Review source")).toBe("GitHub · github");
    expect(rowValue("Repositories")).toBe("org/a, org/b");
    expect(rowValue("Assignment")).toBe("automatic");
    expect(rowValue("Branches")).toBe("All branches");
  });

  it("lists the selected review branches", () => {
    const project: ApiProject = {
      id: "proj-3",
      name: "Branch reviews",
      type: "review",
      enabled: true,
      agentId: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    };
    const detail: ApiProjectDetail = {
      ...project,
      reviewConfig: {
        integration: { id: "int-gerrit", name: "Gerrit", provider: "gerrit" },
        repos: ["platform/api"],
        assignmentMode: "manual",
        branches: ["main", "python"],
      },
    };
    render(<ProjectDrawer item={project} detail={detail} agents={[]} onClose={() => undefined} />);

    expect(rowValue("Branches")).toBe("main, python");
  });

  it("labels install-all skill sources without claiming zero skills", () => {
    const project: ApiProject = {
      id: "proj-skills", name: "Skills", type: "coding", enabled: true, agentId: null,
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z",
    };
    render(<ProjectDrawer
      item={project}
      detail={{ ...project, skillSources: [{ source: "skills.git", skills: [], installAll: true }] }}
      agents={[]}
      onClose={() => undefined}
    />);
    expect(rowValue("Skill sources")).toBe("1 source · all skills");
  });
});
