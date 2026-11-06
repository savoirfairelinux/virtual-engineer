import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CommitDescriptor,
  ProjectPushTargetRecord,
  StateStore,
  Task,
  WorkspaceHandle,
} from "../../src/interfaces.js";
import { makeProjectId, makeTaskId, makeTicketId } from "../../src/interfaces.js";
import { SqliteStateStore } from "../../src/state/stateStore.js";
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
      useChangeIdContinuity: true,
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

  describe.each([
    { reviewSystemLabel: "gerrit", useChangeIdContinuity: true, changeId: "Ihead", path: "c" },
    { reviewSystemLabel: "github", useChangeIdContinuity: false, changeId: "42", path: "pull" },
    { reviewSystemLabel: "gitlab", useChangeIdContinuity: false, changeId: "42", path: "-/merge_requests" },
  ] as const)("$reviewSystemLabel native persistence", (provider) => {
    let store: SqliteStateStore;

    beforeEach(async () => {
      store = await SqliteStateStore.create(":memory:");
      await store.createTask(makeTask().taskId, makeTicketId("ticket-1"));
    });

    afterEach(() => {
      store.close();
    });

    it.each([
      { commitCount: 1, rewrite: false },
      { commitCount: 2, rewrite: false },
      { commitCount: 1, rewrite: true },
      { commitCount: 2, rewrite: true },
    ])("stores $commitCount commit(s), rewrite=$rewrite", async ({ commitCount, rewrite }) => {
      const pushResult = {
        changeId: provider.changeId,
        url: `https://review.example.test/team42/root/${provider.path}/${provider.changeId}?context=42`,
        status: "OPEN",
      };
      const connector: VcsConnector = {
        clone: vi.fn().mockResolvedValue(undefined),
        getChangeStatus: vi.fn().mockResolvedValue("OPEN"),
        pushDirect: vi.fn().mockResolvedValue(pushResult),
        buildPushSpec: () => ({ ref: "feature-task-1" }),
        useChangeIdContinuity: provider.useChangeIdContinuity,
        reviewSystemLabel: provider.reviewSystemLabel,
      };
      const workspaceRunner = {
        listTrustedRepoPaths: () => ["."],
        execGitInVolume: vi.fn().mockResolvedValue(`${commitCount}\n`),
      };
      const service = new ProjectPushService(makeDependencies(store, workspaceRunner, connector));
      const commits: CommitDescriptor[] = Array.from({ length: commitCount }, (_, index) => ({
        repoKey: "root",
        sha: `sha-${index}`,
        subject: `feat: commit ${index}`,
        body: "",
        changeId: `I${String(index + 1).repeat(40)}`,
        files: [],
      }));

      if (rewrite) {
        await service.pushProjectChanges(makeTask(), makeHandle(), [makeTarget()], "feat: fallback", commits);
        commits.forEach((commit) => {
          commit.sha += "-rewritten";
          commit.subject += " rewritten";
          if (!provider.useChangeIdContinuity) {
            commit.changeId = `I${"a".repeat(40)}`;
          }
        });
      }

      await service.pushProjectChanges(makeTask(), makeHandle(), [makeTarget()], "feat: fallback", commits);

      const rows = (await store.getChangesForTask(makeTask().taskId))
        .sort((left, right) => left.commitIndex - right.commitIndex);
      expect(rows).toHaveLength(provider.useChangeIdContinuity ? commitCount : 1);
      expect(rows.map((row) => row.changeId)).toEqual(
        provider.useChangeIdContinuity ? commits.map((commit) => commit.changeId) : ["42"],
      );
      for (const [index, row] of rows.entries()) {
        expect(row).toMatchObject({
          integrationId: "vcs-1",
          reviewSystem: provider.reviewSystemLabel,
          commitIndex: index,
          status: "OPEN",
        });
        expect(row.reviewUrl).toBe(provider.useChangeIdContinuity
          ? index === 0 ? pushResult.url.replace(provider.changeId, commits[0]!.changeId) : ""
          : pushResult.url);
      }
    });
  });

  it("uses the continuity capability, not the review-system label", async () => {
    const stateStore = {
      saveChangePerRepository: vi.fn().mockResolvedValue(undefined),
      orphanExcessChanges: vi.fn().mockResolvedValue(0),
    };
    const connector: VcsConnector = {
      clone: vi.fn().mockResolvedValue(undefined),
      getChangeStatus: vi.fn().mockResolvedValue("OPEN"),
      pushDirect: vi.fn().mockResolvedValue({
        changeId: "42",
        url: "https://review.example.test/pull/42",
        status: "OPEN",
      }),
      buildPushSpec: () => ({ ref: "feature-task-1" }),
      useChangeIdContinuity: false,
      reviewSystemLabel: "gerrit",
    };
    const service = new ProjectPushService(makeDependencies(stateStore, {
      execGitInVolume: vi.fn().mockResolvedValue("2"),
    }, connector));

    await service.pushProjectChanges(makeTask(), makeHandle(), [makeTarget()], "feat: fallback", [
      { repoKey: "root", sha: "sha-1", subject: "first", body: "", changeId: "Ione", files: [] },
      { repoKey: "root", sha: "sha-2", subject: "second", body: "", changeId: "Itwo", files: [] },
    ]);

    expect(stateStore.saveChangePerRepository).toHaveBeenCalledExactlyOnceWith(
      makeTask().taskId, "root", "42", "https://review.example.test/pull/42",
      "OPEN", "vcs-1", "gerrit", 0, expect.any(String),
    );
    expect(stateStore.orphanExcessChanges).toHaveBeenCalledWith(makeTask().taskId, "root", 0);
  });
});
