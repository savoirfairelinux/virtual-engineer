import { describe, expect, it, vi } from "vitest";
import type {
  CommitDescriptor,
  ProjectPushTargetRecord,
  StateStore,
  Task,
  WorkspaceHandle,
} from "../../src/interfaces.js";
import { makeProjectId, makeTaskId } from "../../src/interfaces.js";
import type { VcsConnector } from "../../src/vcs/vcsConnector.js";
import {
  ProjectPushService,
  type ProjectPushServiceDependencies,
} from "../../src/orchestrator/projectPushService.js";

function makeTarget(): ProjectPushTargetRecord {
  return {
    id: 1,
    projectId: makeProjectId("project-1"),
    integrationId: "vcs-1",
    repoKey: "root",
    cloneUrl: "https://git.example.test/root.git",
    targetBranch: "main",
    role: "primary",
    commitOrder: 1,
    localPath: ".",
    sshKeyPath: null,
    reviewerEmails: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeTask(): Pick<Task, "taskId" | "ticketTitle" | "pushRef"> {
  return {
    taskId: makeTaskId("task-1"),
    ticketTitle: "Add feature",
    pushRef: null,
  };
}

function makeHandle(): WorkspaceHandle {
  return {
    taskId: makeTaskId("task-1"),
    containerId: "sandbox-1",
    hostWorkspacePath: "/tmp/workspace",
  };
}

function makeDependencies(
  stateStore: Pick<StateStore, "saveChangePerRepository" | "orphanExcessChanges">,
  workspaceRunner: ProjectPushServiceDependencies["workspaceRunner"],
  connector: VcsConnector,
): ProjectPushServiceDependencies {
  return {
    stateStore,
    workspaceRunner,
    resolveVcsConnectorForTarget: vi.fn().mockResolvedValue(connector),
    resolvePushRef: vi.fn().mockResolvedValue("refs/for/main"),
  };
}

describe("ProjectPushService", () => {
  it("persists each agent commit with its own Change-Id index", async () => {
    const stateStore = {
      saveChangePerRepository: vi.fn().mockResolvedValue(undefined),
      orphanExcessChanges: vi.fn().mockResolvedValue(0),
    };
    const workspaceRunner = {
      listTrustedRepoPaths: vi.fn(() => ["."]),
      execGitInVolume: vi.fn().mockResolvedValue("2\n"),
    };
    const connector = {
      pushDirect: vi.fn().mockResolvedValue({
        changeId: "Ihead",
        url: "https://review.example.test/Ihead",
        status: "OPEN",
      }),
      buildPushSpec: vi.fn().mockReturnValue({ ref: "refs/for/main", topic: "VE-task-1" }),
      reviewSystemLabel: "gerrit",
    } as unknown as VcsConnector;
    const commits: CommitDescriptor[] = [
      { repoKey: "root", sha: "sha-1", subject: "feat: first", body: "", changeId: "Ione", files: [] },
      { repoKey: "root", sha: "sha-2", subject: "feat: second", body: "", changeId: "Itwo", files: [] },
    ];
    const service = new ProjectPushService(
      makeDependencies(stateStore, workspaceRunner, connector),
    );

    await service.pushProjectChanges(makeTask(), makeHandle(), [makeTarget()], "feat: fallback", commits);

    expect(connector.pushDirect).toHaveBeenCalledWith(
      "/tmp/workspace",
      "refs/for/main",
      "VE-task-1",
      [],
    );
    expect(stateStore.saveChangePerRepository).toHaveBeenCalledWith(
      makeTask().taskId,
      "root",
      "Ione",
      "https://review.example.test/Ione",
      "OPEN",
      "vcs-1",
      "gerrit",
      0,
      expect.any(String),
    );
    expect(stateStore.saveChangePerRepository).toHaveBeenCalledWith(
      makeTask().taskId,
      "root",
      "Itwo",
      "",
      "OPEN",
      "vcs-1",
      "gerrit",
      1,
      expect.any(String),
    );
    expect(stateStore.orphanExcessChanges).toHaveBeenCalledWith(
      makeTask().taskId,
      "root",
      1,
    );
  });
});
