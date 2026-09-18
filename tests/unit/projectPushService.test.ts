import { describe, expect, it, vi } from "vitest";
import type {
  ChangePerRepository,
  CommitDescriptor,
  IntegrationBindingContext,
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

function makeTarget(overrides: Partial<ProjectPushTargetRecord> = {}): ProjectPushTargetRecord {
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
    ...overrides,
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
  stateStore: Pick<StateStore, "getChangesForTask" | "saveChangePerRepository" | "orphanExcessChanges" | "updateExternalChangeId">,
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
      getChangesForTask: vi.fn().mockResolvedValue([]),
      saveChangePerRepository: vi.fn().mockResolvedValue(undefined),
      orphanExcessChanges: vi.fn().mockResolvedValue(0),
      updateExternalChangeId: vi.fn().mockResolvedValue(undefined),
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
      useChangeIdContinuity: true,
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
      "https://review.example.test/Itwo",
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
    expect(stateStore.updateExternalChangeId).toHaveBeenCalledWith(
      makeTask().taskId,
      "Ione",
      0,
      "https://review.example.test/Ione",
    );
  });

  it("maps worker superproject commits to the sole Gerrit target", async () => {
    const stateStore = {
      getChangesForTask: vi.fn().mockResolvedValue([]),
      saveChangePerRepository: vi.fn().mockResolvedValue(undefined),
      orphanExcessChanges: vi.fn().mockResolvedValue(0),
      updateExternalChangeId: vi.fn().mockResolvedValue(undefined),
    };
    const workspaceRunner = {
      listTrustedRepoPaths: vi.fn(() => ["."]),
      execGitInVolume: vi.fn().mockResolvedValue("2\n"),
    };
    const connector = {
      pushDirect: vi.fn().mockResolvedValue({
        changeId: "Itwo",
        url: "https://review.example.test/Itwo",
        status: "OPEN",
      }),
      buildPushSpec: vi.fn().mockReturnValue({ ref: "refs/for/main", topic: "VE-task-1" }),
      useChangeIdContinuity: true,
      reviewSystemLabel: "gerrit",
    } as unknown as VcsConnector;
    const commits: CommitDescriptor[] = [
      { repoKey: "superproject", sha: "sha-1", subject: "feat: first", body: "", changeId: "Ione", files: [] },
      { repoKey: "superproject", sha: "sha-2", subject: "feat: second", body: "", changeId: "Itwo", files: [] },
    ];
    const service = new ProjectPushService(
      makeDependencies(stateStore, workspaceRunner, connector),
    );

    await service.pushProjectChanges(
      makeTask(),
      makeHandle(),
      [makeTarget({ repoKey: "org/root" })],
      "feat: fallback",
      commits,
    );

    expect(stateStore.saveChangePerRepository).toHaveBeenCalledTimes(2);
    expect(stateStore.saveChangePerRepository).toHaveBeenNthCalledWith(
      1,
      makeTask().taskId,
      "org/root",
      "Ione",
      "https://review.example.test/Ione",
      "OPEN",
      "vcs-1",
      "gerrit",
      0,
      expect.any(String),
    );
    expect(stateStore.saveChangePerRepository).toHaveBeenNthCalledWith(
      2,
      makeTask().taskId,
      "org/root",
      "Itwo",
      "https://review.example.test/Itwo",
      "OPEN",
      "vcs-1",
      "gerrit",
      1,
      expect.any(String),
    );
  });

  it("persists one provider change for a multi-commit branch push", async () => {
    const stateStore = {
      getChangesForTask: vi.fn().mockResolvedValue([]),
      saveChangePerRepository: vi.fn().mockResolvedValue(undefined),
      orphanExcessChanges: vi.fn().mockResolvedValue(0),
      updateExternalChangeId: vi.fn().mockResolvedValue(undefined),
    };
    const workspaceRunner = {
      listTrustedRepoPaths: vi.fn(() => ["."]),
      execGitInVolume: vi.fn().mockResolvedValue("2\n"),
    };
    const connector = {
      pushDirect: vi.fn().mockResolvedValue({
        changeId: "group/project#42",
        url: "https://gitlab.example.test/group/project/-/merge_requests/42",
        status: "OPEN",
      }),
      buildPushSpec: vi.fn().mockReturnValue({ ref: "feature/task-1" }),
      useChangeIdContinuity: false,
      reviewSystemLabel: "gitlab",
    } as unknown as VcsConnector;
    const commits: CommitDescriptor[] = [
      { repoKey: "root", sha: "sha-1", subject: "feat: first", body: "", changeId: "Ione", files: [] },
      { repoKey: "root", sha: "sha-2", subject: "feat: second", body: "", changeId: "Itwo", files: [] },
    ];
    const service = new ProjectPushService(
      makeDependencies(stateStore, workspaceRunner, connector),
    );

    await service.pushProjectChanges(makeTask(), makeHandle(), [makeTarget()], "feat: fallback", commits);

    expect(stateStore.saveChangePerRepository).toHaveBeenCalledTimes(1);
    expect(stateStore.saveChangePerRepository).toHaveBeenCalledWith(
      makeTask().taskId,
      "root",
      "group/project#42",
      "https://gitlab.example.test/group/project/-/merge_requests/42",
      "OPEN",
      "vcs-1",
      "gitlab",
      0,
      expect.any(String),
    );
    expect(stateStore.orphanExcessChanges).toHaveBeenCalledWith(
      makeTask().taskId,
      "root",
      0,
    );
    expect(stateStore.updateExternalChangeId).toHaveBeenCalledWith(
      makeTask().taskId,
      "group/project#42",
      0,
      "https://gitlab.example.test/group/project/-/merge_requests/42",
    );
  });

  it("fails when any configured push target fails", async () => {
    const stateStore = {
      getChangesForTask: vi.fn().mockResolvedValue([]),
      saveChangePerRepository: vi.fn().mockResolvedValue(undefined),
      orphanExcessChanges: vi.fn().mockResolvedValue(0),
      updateExternalChangeId: vi.fn().mockResolvedValue(undefined),
    };
    const workspaceRunner = {
      listTrustedRepoPaths: vi.fn(() => [".", "child"]),
      execGitInVolume: vi.fn().mockResolvedValue("1\n"),
    };
    const connector = {
      pushDirect: vi.fn()
        .mockResolvedValueOnce({ changeId: "Iroot", url: "https://review.example.test/Iroot", status: "OPEN" })
        .mockRejectedValueOnce(new Error("push rejected")),
      buildPushSpec: vi.fn().mockReturnValue({ ref: "refs/for/main", topic: "VE-task-1" }),
      useChangeIdContinuity: true,
      reviewSystemLabel: "gerrit",
    } as unknown as VcsConnector;
    const targets = [
      makeTarget(),
      makeTarget({ id: 2, repoKey: "child", localPath: "child", commitOrder: 2 }),
    ];
    const commits: CommitDescriptor[] = [
      { repoKey: "root", sha: "sha-1", subject: "feat: root", body: "", changeId: "Iroot", files: [] },
      { repoKey: "child", sha: "sha-2", subject: "feat: child", body: "", changeId: "Ichild", files: [] },
    ];
    const service = new ProjectPushService(
      makeDependencies(stateStore, workspaceRunner, connector),
    );

    await expect(
      service.pushProjectChanges(makeTask(), makeHandle(), targets, "feat: fallback", commits),
    ).rejects.toThrow("Push targets failed: child: push rejected");
    expect(stateStore.saveChangePerRepository).toHaveBeenCalledWith(
      makeTask().taskId,
      "child",
      "",
      "",
      "PUSH_FAILED",
      "vcs-1",
      "gerrit",
      0,
      null,
    );
    expect(stateStore.updateExternalChangeId).not.toHaveBeenCalled();
  });

  it("preserves an existing review when another target is pushed", async () => {
    const existingRoot: ChangePerRepository = {
      id: "task-1:group/root",
      taskId: makeTaskId("task-1"),
      repoKey: "group/root",
      changeId: "group/root#3",
      reviewUrl: "https://gitlab.example.test/group/root/-/merge_requests/3",
      status: "OPEN",
      integrationId: "gitlab-root",
      reviewSystem: "gitlab",
      commitIndex: 0,
      subjectHash: "root-hash",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const stateStore = {
      getChangesForTask: vi.fn().mockResolvedValue([existingRoot]),
      saveChangePerRepository: vi.fn().mockResolvedValue(undefined),
      orphanExcessChanges: vi.fn().mockResolvedValue(0),
      updateExternalChangeId: vi.fn().mockResolvedValue(undefined),
    };
    const workspaceRunner = {
      listTrustedRepoPaths: vi.fn(() => [".", "child"]),
      execGitInVolume: vi.fn().mockImplementation(async (
        _handle: WorkspaceHandle,
        _args: string[],
        subPath?: string,
      ) => subPath === "." ? "0\n" : "1\n"),
    };
    const rootConnector = {
      pushDirect: vi.fn(),
      buildPushSpec: vi.fn().mockReturnValue({ ref: "feature/task-1" }),
      useChangeIdContinuity: false,
      reviewSystemLabel: "gitlab",
    } as unknown as VcsConnector;
    const childConnector = {
      pushDirect: vi.fn().mockResolvedValue({
        changeId: "owner/child#8",
        url: "https://github.example.test/owner/child/pull/8",
        status: "OPEN",
      }),
      buildPushSpec: vi.fn().mockReturnValue({ ref: "feature/task-1" }),
      useChangeIdContinuity: false,
      reviewSystemLabel: "github",
    } as unknown as VcsConnector;
    const service = new ProjectPushService({
      stateStore,
      workspaceRunner,
      resolveVcsConnectorForTarget: vi.fn(async (integrationId: string) =>
        integrationId === "gitlab-root" ? rootConnector : childConnector),
      resolvePushRef: vi.fn().mockResolvedValue("feature/task-1"),
    });
    const targets = [
      makeTarget({ integrationId: "gitlab-root", repoKey: "group/root" }),
      makeTarget({ id: 2, integrationId: "github-child", repoKey: "owner/child", localPath: "child", commitOrder: 2 }),
    ];

    const summary = await service.pushProjectChanges(
      makeTask(),
      makeHandle(),
      targets,
      "feat: fallback",
      [{ repoKey: "owner/child", sha: "child-sha", subject: "feat: child", body: "", changeId: "", files: [] }],
    );

    expect(rootConnector.pushDirect).not.toHaveBeenCalled();
    expect(stateStore.saveChangePerRepository).not.toHaveBeenCalledWith(
      makeTask().taskId,
      "group/root",
      "",
      "",
      "NO_CHANGE",
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(summary.outcomes[0]).toMatchObject({
      repoKey: "group/root",
      status: "EXISTING",
      changeId: "group/root#3",
    });
    expect(stateStore.updateExternalChangeId).toHaveBeenCalledWith(
      makeTask().taskId,
      "group/root#3",
      0,
      existingRoot.reviewUrl,
    );
  });

  it("does not repush an unchanged restored Gerrit target", async () => {
    const existingRoot: ChangePerRepository = {
      id: "task-1:gerrit/root",
      taskId: makeTaskId("task-1"),
      repoKey: "gerrit/root",
      changeId: "Iroot",
      reviewUrl: "https://gerrit.example/c/Iroot",
      status: "OPEN",
      integrationId: "gerrit-root",
      reviewSystem: "gerrit",
      commitIndex: 0,
      subjectHash: "root-hash",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const stateStore = {
      getChangesForTask: vi.fn().mockResolvedValue([existingRoot]),
      saveChangePerRepository: vi.fn().mockResolvedValue(undefined),
      orphanExcessChanges: vi.fn().mockResolvedValue(0),
      updateExternalChangeId: vi.fn().mockResolvedValue(undefined),
    };
    const workspaceRunner = {
      listTrustedRepoPaths: vi.fn(() => [".", "child"]),
      execGitInVolume: vi.fn().mockResolvedValue("1\n"),
    };
    const rootConnector = {
      pushDirect: vi.fn(),
      buildPushSpec: vi.fn().mockReturnValue({ ref: "refs/for/main" }),
      useChangeIdContinuity: true,
      reviewSystemLabel: "gerrit",
    } as unknown as VcsConnector;
    const childConnector = {
      pushDirect: vi.fn().mockResolvedValue({
        changeId: "owner/child#8",
        url: "https://github.example.test/owner/child/pull/8",
        status: "OPEN",
      }),
      buildPushSpec: vi.fn().mockReturnValue({ ref: "feature/task-1" }),
      useChangeIdContinuity: false,
      reviewSystemLabel: "github",
    } as unknown as VcsConnector;
    const service = new ProjectPushService({
      stateStore,
      workspaceRunner,
      resolveVcsConnectorForTarget: vi.fn(async (integrationId: string) =>
        integrationId === "gerrit-root" ? rootConnector : childConnector),
      resolvePushRef: vi.fn().mockResolvedValue("refs/for/main"),
    });
    const targets = [
      makeTarget({ integrationId: "gerrit-root", repoKey: "gerrit/root" }),
      makeTarget({ id: 2, integrationId: "github-child", repoKey: "owner/child", localPath: "child", commitOrder: 2 }),
    ];

    const summary = await service.pushProjectChanges(
      makeTask(),
      makeHandle(),
      targets,
      "feat: fallback",
      [{ repoKey: "owner/child", sha: "child-sha", subject: "feat: child", body: "", changeId: "", files: [] }],
    );

    expect(rootConnector.pushDirect).not.toHaveBeenCalled();
    expect(summary.outcomes[0]).toMatchObject({
      repoKey: "gerrit/root",
      status: "EXISTING",
      changeId: "Iroot",
    });
  });

  it("does not overwrite an existing review when a retry push fails", async () => {
    const existingRoot: ChangePerRepository = {
      id: "task-1:root",
      taskId: makeTaskId("task-1"),
      repoKey: "root",
      changeId: "group/root#3",
      reviewUrl: "https://gitlab.example.test/group/root/-/merge_requests/3",
      status: "OPEN",
      integrationId: "vcs-1",
      reviewSystem: "gitlab",
      commitIndex: 0,
      subjectHash: "root-hash",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const stateStore = {
      getChangesForTask: vi.fn().mockResolvedValue([existingRoot]),
      saveChangePerRepository: vi.fn().mockResolvedValue(undefined),
      orphanExcessChanges: vi.fn().mockResolvedValue(0),
      updateExternalChangeId: vi.fn().mockResolvedValue(undefined),
    };
    const connector = {
      pushDirect: vi.fn().mockRejectedValue(new Error("push rejected")),
      buildPushSpec: vi.fn().mockReturnValue({ ref: "feature/task-1" }),
      useChangeIdContinuity: false,
      reviewSystemLabel: "gitlab",
    } as unknown as VcsConnector;
    const service = new ProjectPushService(makeDependencies(
      stateStore,
      {
        listTrustedRepoPaths: vi.fn(() => ["."]),
        execGitInVolume: vi.fn().mockResolvedValue("1\n"),
      },
      connector,
    ));

    await expect(service.pushProjectChanges(
      makeTask(),
      makeHandle(),
      [makeTarget()],
      "feat: retry",
    )).rejects.toThrow("push rejected");

    expect(stateStore.saveChangePerRepository).not.toHaveBeenCalled();
    expect(stateStore.updateExternalChangeId).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "Gerrit root with GitLab child",
      taskPushRef: "refs/for/main",
      root: { integrationId: "gerrit", repoKey: "gerrit/root", ref: "refs/for/main", continuity: true, system: "gerrit" },
      child: { integrationId: "gitlab", repoKey: "group/child", ref: "feature/task-1", continuity: false, system: "gitlab" },
    },
    {
      label: "GitLab root with Gerrit child",
      taskPushRef: "feature/task-1",
      root: { integrationId: "gitlab", repoKey: "group/root", ref: "feature/task-1", continuity: false, system: "gitlab" },
      child: { integrationId: "gerrit", repoKey: "gerrit/child", ref: "refs/for/release", continuity: true, system: "gerrit" },
    },
  ])("uses each connector's push ref on retry: $label", async ({ taskPushRef, root, child }) => {
    const stateStore = {
      getChangesForTask: vi.fn().mockResolvedValue([]),
      saveChangePerRepository: vi.fn().mockResolvedValue(undefined),
      orphanExcessChanges: vi.fn().mockResolvedValue(0),
      updateExternalChangeId: vi.fn().mockResolvedValue(undefined),
    };
    const workspaceRunner = {
      listTrustedRepoPaths: vi.fn(() => [".", "child"]),
      execGitInVolume: vi.fn().mockResolvedValue("1\n"),
    };
    const connectorFor = (config: typeof root): VcsConnector => ({
      pushDirect: vi.fn().mockResolvedValue({
        changeId: config.continuity ? `I${config.repoKey}` : `${config.repoKey}#7`,
        url: `https://review.example/${config.repoKey}/7`,
        status: "OPEN",
      }),
      buildPushSpec: vi.fn().mockReturnValue({ ref: config.ref }),
      useChangeIdContinuity: config.continuity,
      reviewSystemLabel: config.system,
    } as unknown as VcsConnector);
    const rootConnector = connectorFor(root);
    const childConnector = connectorFor(child);
    const resolveVcsConnectorForTarget = vi.fn(async (
      integrationId: string,
      context?: IntegrationBindingContext,
    ) => {
      expect(context).toEqual(expect.objectContaining({ targetBranch: integrationId === root.integrationId ? "main" : "release" }));
      return integrationId === root.integrationId ? rootConnector : childConnector;
    });
    const service = new ProjectPushService({
      stateStore,
      workspaceRunner,
      resolveVcsConnectorForTarget,
      resolvePushRef: vi.fn(async (_task, compute) => taskPushRef || compute()),
    });
    const targets = [
      makeTarget({ integrationId: root.integrationId, repoKey: root.repoKey }),
      makeTarget({ id: 2, integrationId: child.integrationId, repoKey: child.repoKey, localPath: "child", targetBranch: "release", commitOrder: 2 }),
    ];
    const task = { ...makeTask(), pushRef: taskPushRef };
    const commits: CommitDescriptor[] = [
      { repoKey: root.repoKey, sha: "root", subject: "feat: root", body: "", changeId: root.continuity ? `I${root.repoKey}` : "", files: [] },
      { repoKey: child.repoKey, sha: "child", subject: "feat: child", body: "", changeId: child.continuity ? `I${child.repoKey}` : "", files: [] },
    ];

    await service.pushProjectChanges(task, makeHandle(), targets, "feat: fallback", commits);

    expect(rootConnector.pushDirect).toHaveBeenCalledWith(
      "/tmp/workspace",
      root.ref,
      undefined,
      [],
    );
    expect(childConnector.pushDirect).toHaveBeenCalledWith(
      "/tmp/workspace/child",
      child.ref,
      undefined,
      [],
    );
  });

  it("preserves absolute Gerrit indexes when only the second change is amended", async () => {
    const existingChanges: ChangePerRepository[] = [
      {
        id: "task-1:root",
        taskId: makeTaskId("task-1"),
        repoKey: "root",
        changeId: "Ione",
        reviewUrl: "https://review.example.test/Ione",
        status: "OPEN",
        integrationId: "vcs-1",
        reviewSystem: "gerrit",
        commitIndex: 0,
        subjectHash: "first-hash",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
      {
        id: "task-1:root:1",
        taskId: makeTaskId("task-1"),
        repoKey: "root",
        changeId: "Itwo",
        reviewUrl: "",
        status: "OPEN",
        integrationId: "vcs-1",
        reviewSystem: "gerrit",
        commitIndex: 1,
        subjectHash: "second-hash",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ];
    const stateStore = {
      getChangesForTask: vi.fn().mockResolvedValue(existingChanges),
      saveChangePerRepository: vi.fn().mockResolvedValue(undefined),
      orphanExcessChanges: vi.fn().mockResolvedValue(0),
      updateExternalChangeId: vi.fn().mockResolvedValue(undefined),
    };
    const connector = {
      pushDirect: vi.fn().mockResolvedValue({
        changeId: "Itwo",
        url: "https://review.example.test/Itwo",
        status: "OPEN",
      }),
      buildPushSpec: vi.fn().mockReturnValue({ ref: "refs/for/main" }),
      useChangeIdContinuity: true,
      reviewSystemLabel: "gerrit",
    } as unknown as VcsConnector;
    const service = new ProjectPushService(makeDependencies(
      stateStore,
      {
        listTrustedRepoPaths: vi.fn(() => ["."]),
        execGitInVolume: vi.fn().mockResolvedValue("1\n"),
      },
      connector,
    ));

    await service.pushProjectChanges(
      { ...makeTask(), pushRef: "refs/for/main" },
      makeHandle(),
      [makeTarget()],
      "feat: retry",
      [{ repoKey: "root", sha: "amended", subject: "feat: second", body: "Change-Id: Itwo", changeId: "Itwo", files: ["b.ts"] }],
    );

    expect(stateStore.saveChangePerRepository).toHaveBeenCalledTimes(1);
    expect(stateStore.saveChangePerRepository).toHaveBeenCalledWith(
      makeTask().taskId,
      "root",
      "Itwo",
      "https://review.example.test/Itwo",
      "OPEN",
      "vcs-1",
      "gerrit",
      1,
      expect.any(String),
    );
    expect(stateStore.orphanExcessChanges).not.toHaveBeenCalled();
    expect(stateStore.updateExternalChangeId).toHaveBeenCalledWith(
      makeTask().taskId,
      "Ione",
      0,
      "https://review.example.test/Ione",
    );
  });
});
