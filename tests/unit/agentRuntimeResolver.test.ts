import { describe, expect, it, vi } from "vitest";
import type {
  AgentAdapter,
  AgentRecord,
  Integration,
  ProjectRecord,
} from "../../src/interfaces.js";
import { makeAgentId, makeProjectId } from "../../src/interfaces.js";
import type { ProjectModeDeps } from "../../src/orchestrator/projectMode.js";
import {
  AgentRuntimeResolver,
  type AgentRuntimeResolverDependencies,
} from "../../src/orchestrator/agentRuntimeResolver.js";

function makeAgent(): AgentRecord {
  return {
    id: makeAgentId("agent-1"),
    name: "Aider agent",
    type: "coding",
    modelConfigJson: JSON.stringify({ model: "agent-model" }),
    integrationId: "aider-integration",
    systemPromptId: "system-generic",
    instructionsPromptId: "instructions-generic",
    feedbackInstructionsPromptId: null,
    maxConcurrent: 1,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeProject(): ProjectRecord {
  return {
    id: makeProjectId("project-1"),
    name: "Project",
    type: "coding",
    agentId: makeAgent().id,
    agentOverrideJson: null,
    postCloneScript: "",
    skillSourcesJson: "[]",
    gerritTopicOverride: null,
    useFullTicketUrlInCommits: false,
    postReviewLinkToTicket: false,
    reactToCiFailures: false,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeProjectMode(adapter: AgentAdapter, integration: Integration): ProjectModeDeps {
  return {
    projectStore: {
      getProjectById: vi.fn(),
      listProjectPushTargets: vi.fn().mockResolvedValue([]),
      getProjectTicketSource: vi.fn().mockResolvedValue(null),
      getProjectReviewConfig: vi.fn().mockResolvedValue(null),
      getAgentById: vi.fn().mockResolvedValue(makeAgent()),
    },
    pluginManager: {
      getConnectorForIntegration: vi.fn(() => adapter),
      getActiveIntegrationById: vi.fn(() => integration),
      decryptIntegrationConfig: vi.fn(() => ({
        aiderBackend: "openai",
        aiderApiKey: "integration-key",
        aiderApiBase: "https://llm.example.test/v1",
      })),
    },
  } as unknown as ProjectModeDeps;
}

describe("AgentRuntimeResolver", () => {
  it("merges the project agent and active integration configuration", async () => {
    const adapter = { name: "aider" } as AgentAdapter;
    const integration = {
      id: "aider-integration",
      provider: "aider",
      name: "Aider",
      configJson: "{}",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Integration;
    const projectMode = makeProjectMode(adapter, integration);
    const dependencies: AgentRuntimeResolverDependencies = {
      getProjectMode: () => projectMode,
    };
    const resolver = new AgentRuntimeResolver(dependencies);

    const runtime = await resolver.resolve(makeProject());

    expect(runtime.adapter).toBe(adapter);
    expect(runtime.config.model).toBe("agent-model");
    expect(runtime.config.extra).toEqual({
      aiderBackend: "openai",
      aiderApiKey: "integration-key",
      aiderApiBase: "https://llm.example.test/v1",
    });
  });
});
