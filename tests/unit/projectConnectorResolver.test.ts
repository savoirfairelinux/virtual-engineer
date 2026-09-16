import { describe, expect, it, vi } from "vitest";
import type {
  ProjectPushTargetRecord,
  StateStore,
  TicketConnector,
} from "../../src/interfaces.js";
import { makeExternalChangeId, makeProjectId, makeTaskId } from "../../src/domain/identifiers.js";
import { VcsConnectorFactory } from "../../src/vcs/vcsFactory.js";
import {
  ProjectConnectorResolver,
  type ProjectConnectorResolverDependencies,
} from "../../src/orchestrator/projectConnectorResolver.js";
import type { ProjectModeDeps } from "../../src/orchestrator/projectMode.js";

function makeProjectMode(overrides: {
  getProjectTicketSource?: ProjectModeDeps["projectStore"]["getProjectTicketSource"];
  getProjectReviewConfig?: ProjectModeDeps["projectStore"]["getProjectReviewConfig"];
  listProjectPushTargets?: ProjectModeDeps["projectStore"]["listProjectPushTargets"];
  createConnectorForCapability?: NonNullable<ProjectModeDeps["pluginManager"]["createConnectorForCapability"]>;
} = {}): ProjectModeDeps {
  return {
    projectStore: {
      getProjectById: vi.fn(),
      listProjectPushTargets: overrides.listProjectPushTargets ?? vi.fn().mockResolvedValue([]),
      getProjectTicketSource: overrides.getProjectTicketSource ?? vi.fn().mockResolvedValue(null),
      getProjectReviewConfig: overrides.getProjectReviewConfig ?? vi.fn().mockResolvedValue(null),
      getAgentById: vi.fn(),
    },
    pluginManager: {
      getConnectorForIntegration: vi.fn(() => null),
      ...(overrides.createConnectorForCapability !== undefined
        ? { createConnectorForCapability: overrides.createConnectorForCapability }
        : {}),
    },
  };
}

function makeDependencies(getProjectMode: () => ProjectModeDeps | null): ProjectConnectorResolverDependencies {
  return {
    getProjectMode,
    stateStore: {} as StateStore,
    vcsConnectorFactory: new VcsConnectorFactory(),
  };
}

describe("ProjectConnectorResolver", () => {
  it("resolves a ticket connector with the project's ticket binding", async () => {
    const ticketConnector = {} as TicketConnector;
    const createConnectorForCapability = vi.fn().mockResolvedValue(ticketConnector);
    const projectMode = makeProjectMode({
      getProjectTicketSource: vi.fn().mockResolvedValue({
        id: 1,
        projectId: makeProjectId("project-1"),
        integrationId: "ticket-integration",
        ticketProjectKey: "PLATFORM",
        createdAt: new Date(),
      }),
      createConnectorForCapability,
    });
    const resolver = new ProjectConnectorResolver(
      makeDependencies(() => projectMode),
    );

    const result = await resolver.resolveTicketConnector({
      taskId: makeTaskId("task-1"),
      projectId: makeProjectId("project-1"),
    });

    expect(result).toBe(ticketConnector);
    expect(createConnectorForCapability).toHaveBeenCalledWith(
      "ticket-integration",
      "issue_tracking",
      { ticketProjectKey: "PLATFORM" },
    );
  });

  it("selects the repository-qualified review connector from push targets", async () => {
    const reviewConnector = {} as TicketConnector;
    const createConnectorForCapability = vi.fn().mockResolvedValue(reviewConnector);
    const pushTarget = {
      repoKey: "core",
      integrationId: "vcs-integration",
    } as ProjectPushTargetRecord;
    const projectMode = makeProjectMode({
      listProjectPushTargets: vi.fn().mockResolvedValue([pushTarget]),
      createConnectorForCapability,
    });
    const resolver = new ProjectConnectorResolver(
      makeDependencies(() => projectMode),
    );

    const result = await resolver.resolveReviewConnector({
      taskId: makeTaskId("task-1"),
      projectId: makeProjectId("project-1"),
      externalChangeId: makeExternalChangeId("core#123"),
    });

    expect(result).toBe(reviewConnector);
    expect(createConnectorForCapability).toHaveBeenCalledWith(
      "vcs-integration",
      "code_review",
      { repoKey: "core" },
    );
  });

  it("rejects a repository-qualified review change outside the project binding", async () => {
    const projectMode = makeProjectMode({
      listProjectPushTargets: vi.fn().mockResolvedValue([
        { repoKey: "core", integrationId: "vcs-integration" } as ProjectPushTargetRecord,
      ]),
    });
    const resolver = new ProjectConnectorResolver(
      makeDependencies(() => projectMode),
    );

    await expect(
      resolver.resolveReviewConnector({
        taskId: makeTaskId("task-1"),
        projectId: makeProjectId("project-1"),
        externalChangeId: makeExternalChangeId("other#123"),
      }),
    ).rejects.toThrow("does not match a repository push target");
  });
});
