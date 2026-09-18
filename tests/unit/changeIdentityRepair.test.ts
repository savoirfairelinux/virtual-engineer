import { describe, expect, it, vi } from "vitest";
import {
  makeExternalChangeId,
  makeProjectId,
  makeTaskId,
  makeTicketId,
  type ChangePerRepository,
  type Integration,
  type IntegrationBindingContext,
  type ProjectPushTargetRecord,
  type Task,
} from "../../src/interfaces.js";
import {
  repairProviderChangeIdentities,
  type ChangeIdentityRepairStore,
} from "../../src/vcs/changeIdentityRepair.js";
import type { VcsConnector } from "../../src/vcs/vcsConnector.js";

function task(): Task {
  return {
    taskId: makeTaskId("task-1"),
    ticketId: makeTicketId("42"),
    ticketSourceLabel: "gitlab:issues",
    ticketTitle: "Repair identity",
    ticketDescription: "",
    state: "IN_REVIEW",
    taskType: "code-gen",
    externalChangeId: makeExternalChangeId("Iwrong"),
    currentPatchset: 0,
    reviewedPatchset: null,
    cycleCount: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    failureReason: null,
    ticketUrl: null,
    reviewUrl: "https://gitlab.example.test/group/project/-/merge_requests/Iwrong",
    projectId: makeProjectId("project-1"),
    displayId: "42",
    pushRef: "feature/task-1",
  };
}

function target(overrides: Partial<ProjectPushTargetRecord> = {}): ProjectPushTargetRecord {
  return {
    id: 1,
    projectId: makeProjectId("project-1"),
    integrationId: "gitlab-1",
    repoKey: "group/project",
    cloneUrl: "https://gitlab.example.test/group/project.git",
    targetBranch: "main",
    role: "primary",
    commitOrder: 1,
    localPath: ".",
    sshKeyPath: null,
    reviewerEmails: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function change(overrides: Partial<ChangePerRepository> = {}): ChangePerRepository {
  return {
    id: "task-1:group/project",
    taskId: makeTaskId("task-1"),
    repoKey: "group/project",
    changeId: "Iwrong",
    reviewUrl: "https://gitlab.example.test/group/project/-/merge_requests/Iwrong",
    status: "OPEN",
    integrationId: "gitlab-1",
    reviewSystem: "gitlab",
    commitIndex: 0,
    subjectHash: "subject",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function integration(id = "gitlab-1"): Integration {
  return {
    id,
    provider: "gitlab",
    name: "GitLab",
    configJson: "{}",
    enabled: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    discoveredResourcesJson: null,
    discoveredAt: null,
  };
}

function store(overrides: Partial<ChangeIdentityRepairStore> = {}): ChangeIdentityRepairStore {
  return {
    getActiveTasks: vi.fn().mockResolvedValue([task()]),
    listProjectPushTargets: vi.fn().mockResolvedValue([target()]),
    getChangesForTask: vi.fn().mockResolvedValue([
      change(),
      change({ id: "task-1:group/project:1", commitIndex: 1, changeId: "Iwrong2" }),
    ]),
    getIntegration: vi.fn().mockResolvedValue(integration()),
    applyChangeIdentityRepair: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function branchConnector(): VcsConnector {
  return {
    useChangeIdContinuity: false,
    reviewSystemLabel: "gitlab",
    findExistingReview: vi.fn().mockResolvedValue({
      changeId: "group/project#9",
      url: "https://gitlab.example.test/group/project/-/merge_requests/9",
      status: "OPEN",
    }),
  } as unknown as VcsConnector;
}

describe("repairProviderChangeIdentities", () => {
  it("plans repairs without mutating state by default", async () => {
    const stateStore = store();

    const report = await repairProviderChangeIdentities({
      store: stateStore,
      createConnector: vi.fn(() => branchConnector()),
      apply: false,
    });

    expect(report).toMatchObject({ tasksScanned: 1, tasksRepairable: 1, tasksApplied: 0, blockedTasks: 0 });
    expect(report.tasks[0]).toMatchObject({ taskId: "task-1", status: "repairable" });
    expect(stateStore.applyChangeIdentityRepair).not.toHaveBeenCalled();
  });

  it("applies one canonical branch review and mirrors it to the task", async () => {
    const stateStore = store();

    const report = await repairProviderChangeIdentities({
      store: stateStore,
      createConnector: vi.fn(() => branchConnector()),
      apply: true,
    });

    expect(report).toMatchObject({ tasksRepairable: 1, tasksApplied: 1, blockedTasks: 0 });
    expect(stateStore.applyChangeIdentityRepair).toHaveBeenCalledWith({
      taskId: makeTaskId("task-1"),
      targets: [{
        repoKey: "group/project",
        changeId: "group/project#9",
        reviewUrl: "https://gitlab.example.test/group/project/-/merge_requests/9",
        status: "OPEN",
        integrationId: "gitlab-1",
        reviewSystem: "gitlab",
        subjectHash: "subject",
      }],
      routingRepairs: [],
      primaryChangeId: makeExternalChangeId("group/project#9"),
      primaryReviewUrl: "https://gitlab.example.test/group/project/-/merge_requests/9",
    });
  });

  it("blocks all writes when any configured target cannot be resolved", async () => {
    const stateStore = store({
      listProjectPushTargets: vi.fn().mockResolvedValue([
        target(),
        target({ id: 2, integrationId: "gitlab-2", repoKey: "group/child", localPath: "child", commitOrder: 2 }),
      ]),
      getIntegration: vi.fn().mockImplementation(async (id: string) => integration(id)),
    });
    const createConnector = vi.fn((_integration: Integration, context: IntegrationBindingContext) => {
      const connector = branchConnector();
      if (context?.repoKey === "group/child") {
        connector.findExistingReview = vi.fn().mockResolvedValue(null);
      }
      return connector;
    });

    const report = await repairProviderChangeIdentities({ store: stateStore, createConnector, apply: true });

    expect(report).toMatchObject({ tasksApplied: 0, blockedTasks: 1 });
    expect(report.tasks[0]).toMatchObject({ taskId: "task-1", status: "blocked" });
    expect(stateStore.applyChangeIdentityRepair).not.toHaveBeenCalled();
  });

  it("reports clean on a second run after terminal extra rows are collapsed", async () => {
    let currentTask = task();
    let currentChanges = [
      change(),
      change({ id: "task-1:group/project:1", commitIndex: 1, changeId: "Imerged", status: "MERGED" }),
      change({ id: "task-1:group/project:2", commitIndex: 2, changeId: "Iabandoned", status: "ABANDONED" }),
    ];
    const stateStore = store({
      getActiveTasks: vi.fn(async () => [currentTask]),
      getChangesForTask: vi.fn(async () => currentChanges),
      applyChangeIdentityRepair: vi.fn(async (input) => {
        currentTask = {
          ...currentTask,
          externalChangeId: input.primaryChangeId,
          reviewUrl: input.primaryReviewUrl,
        };
        currentChanges = [
          change({
            changeId: input.targets[0]!.changeId,
            reviewUrl: input.targets[0]!.reviewUrl,
            status: input.targets[0]!.status,
          }),
          ...currentChanges.slice(1).map((row) => ({ ...row, status: "ORPHANED" })),
        ];
      }),
    });
    const createConnector = vi.fn(() => branchConnector());

    const applied = await repairProviderChangeIdentities({ store: stateStore, createConnector, apply: true });
    const secondRun = await repairProviderChangeIdentities({ store: stateStore, createConnector, apply: false });

    expect(applied).toMatchObject({ tasksApplied: 1, blockedTasks: 0 });
    expect(secondRun).toMatchObject({ tasksRepairable: 0, tasksApplied: 0, blockedTasks: 0 });
    expect(secondRun.tasks[0]).toMatchObject({ status: "clean" });
  });

  it("derives a branch-provider child's source ref instead of reusing the primary Gerrit ref", async () => {
    const currentTask = task();
    currentTask.pushRef = "refs/for/main";
    currentTask.externalChangeId = makeExternalChangeId("Iroot");
    const childFindExistingReview = vi.fn().mockResolvedValue({
      changeId: "group/child#4",
      url: "https://gitlab.example.test/group/child/-/merge_requests/4",
      status: "OPEN",
    });
    const stateStore = store({
      getActiveTasks: vi.fn().mockResolvedValue([currentTask]),
      listProjectPushTargets: vi.fn().mockResolvedValue([
        target({ integrationId: "gerrit-1", repoKey: "gerrit/root", cloneUrl: "ssh://gerrit/root" }),
        target({ id: 2, integrationId: "gitlab-1", repoKey: "group/child", localPath: "child", targetBranch: "release", commitOrder: 2 }),
      ]),
      getChangesForTask: vi.fn().mockResolvedValue([
        change({ repoKey: "gerrit/root", changeId: "Iroot", integrationId: "gerrit-1", reviewSystem: "gerrit" }),
        change({ id: "task-1:group/child", repoKey: "group/child", changeId: "Iwrong", integrationId: "gitlab-1" }),
      ]),
      getIntegration: vi.fn().mockImplementation(async (id: string) =>
        id === "gerrit-1"
          ? { ...integration(id), provider: "gerrit" }
          : integration(id)),
    });
    const createConnector = vi.fn((providerIntegration: Integration) =>
      providerIntegration.provider === "gerrit"
        ? ({ useChangeIdContinuity: true, reviewSystemLabel: "gerrit" } as unknown as VcsConnector)
        : ({
            useChangeIdContinuity: false,
            reviewSystemLabel: "gitlab",
            buildPushSpec: vi.fn().mockReturnValue({ ref: "feature/task-1" }),
            findExistingReview: childFindExistingReview,
          } as unknown as VcsConnector));

    const report = await repairProviderChangeIdentities({ store: stateStore, createConnector, apply: false });

    expect(report.blockedTasks).toBe(0);
    expect(childFindExistingReview).toHaveBeenCalledWith("feature/task-1", "release");
  });

  it("repairs a legacy NO_CHANGE row when the provider still has an open branch review", async () => {
    const stateStore = store({
      getChangesForTask: vi.fn().mockResolvedValue([
        change({ changeId: "", reviewUrl: "", status: "NO_CHANGE", subjectHash: null }),
      ]),
    });
    const connector = branchConnector();

    const report = await repairProviderChangeIdentities({
      store: stateStore,
      createConnector: vi.fn(() => connector),
      apply: false,
    });

    expect(connector.findExistingReview).toHaveBeenCalledWith("feature/task-1", "main");
    expect(report).toMatchObject({ tasksRepairable: 1, blockedTasks: 0 });
    expect(report.tasks[0]?.targets[0]).toMatchObject({
      status: "repair",
      resolvedChangeId: "group/project#9",
    });
  });

  it("repairs Gerrit routing metadata without collapsing the commit chain", async () => {
    const currentTask = task();
    currentTask.externalChangeId = makeExternalChangeId("Ione");
    currentTask.reviewUrl = "https://gerrit.example/c/Ione";
    const stateStore = store({
      getActiveTasks: vi.fn().mockResolvedValue([currentTask]),
      listProjectPushTargets: vi.fn().mockResolvedValue([
        target({ integrationId: "gerrit-1", repoKey: "gerrit/project", cloneUrl: "ssh://gerrit/project" }),
      ]),
      getChangesForTask: vi.fn().mockResolvedValue([
        change({
          repoKey: "gerrit/project",
          changeId: "Ione",
          reviewUrl: "https://gerrit.example/c/Ione",
          integrationId: "",
          reviewSystem: "",
          commitIndex: 0,
          subjectHash: "one",
        }),
        change({
          id: "task-1:gerrit/project:1",
          repoKey: "gerrit/project",
          changeId: "Itwo",
          reviewUrl: "https://gerrit.example/c/Itwo",
          integrationId: "",
          reviewSystem: "",
          commitIndex: 1,
          subjectHash: "two",
        }),
      ]),
      getIntegration: vi.fn().mockResolvedValue({ ...integration("gerrit-1"), provider: "gerrit" }),
    });
    const connector = {
      useChangeIdContinuity: true,
      reviewSystemLabel: "gerrit",
    } as unknown as VcsConnector;

    const report = await repairProviderChangeIdentities({
      store: stateStore,
      createConnector: vi.fn(() => connector),
      apply: true,
    });

    expect(report).toMatchObject({ tasksRepairable: 1, tasksApplied: 1, blockedTasks: 0 });
    expect(stateStore.applyChangeIdentityRepair).toHaveBeenCalledWith(expect.objectContaining({
      targets: [],
      routingRepairs: [{ repoKey: "gerrit/project", integrationId: "gerrit-1", reviewSystem: "gerrit" }],
    }));
  });
});