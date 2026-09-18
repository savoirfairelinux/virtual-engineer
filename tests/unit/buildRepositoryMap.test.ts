import { describe, it, expect } from "vitest";
import { buildRepositoryMap } from "../../src/orchestrator/agentContextBuilder.js";
import { makeProjectId } from "../../src/interfaces.js";
import type { ProjectPushTargetRecord } from "../../src/interfaces.js";

function makeTarget(
  over: Pick<ProjectPushTargetRecord, "repoKey" | "localPath" | "commitOrder"> &
    Partial<ProjectPushTargetRecord>
): ProjectPushTargetRecord {
  return {
    id: over.id ?? 1,
    projectId: makeProjectId("p-1"),
    integrationId: over.integrationId ?? "int-1",
    repoKey: over.repoKey,
    cloneUrl: over.cloneUrl ?? `git@host:${over.repoKey}.git`,
    targetBranch: over.targetBranch ?? "main",
    role: over.role ?? "primary",
    commitOrder: over.commitOrder,
    localPath: over.localPath,
    sshKeyPath: over.sshKeyPath ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as ProjectPushTargetRecord;
}

describe("buildRepositoryMap", () => {
  it("picks localPath='.' as superproject and others as submodules", () => {
    const targets = [
      makeTarget({ id: 1, repoKey: "jami-client-qt", localPath: ".", commitOrder: 2 }),
      makeTarget({ id: 2, repoKey: "daemon", localPath: "daemon", commitOrder: 1 }),
    ];

    const map = buildRepositoryMap(targets, {
      "jami-client-qt": false,
      daemon: true,
    });

    expect(map.superproject).toEqual({
      repoKey: "jami-client-qt",
      localPath: ".",
      useChangeIdContinuity: false,
    });
    expect(map.submodules).toEqual([{
      repoKey: "daemon",
      localPath: "daemon",
      useChangeIdContinuity: true,
    }]);
  });

  it("preserves mixed-provider continuity when Gerrit is the root", () => {
    const targets = [
      makeTarget({ id: 1, repoKey: "gerrit/root", localPath: ".", commitOrder: 1 }),
      makeTarget({ id: 2, repoKey: "github/child", localPath: "child", commitOrder: 2 }),
    ];

    const map = buildRepositoryMap(targets, {
      "gerrit/root": true,
      "github/child": false,
    });

    expect(map.superproject.useChangeIdContinuity).toBe(true);
    expect(map.submodules[0]?.useChangeIdContinuity).toBe(false);
  });

  it("falls back to lowest commitOrder when no localPath is '.'", () => {
    const targets = [
      makeTarget({ id: 1, repoKey: "repo-a", localPath: "a", commitOrder: 2 }),
      makeTarget({ id: 2, repoKey: "repo-b", localPath: "b", commitOrder: 1 }),
    ];

    const map = buildRepositoryMap(targets, { "repo-a": true, "repo-b": true });

    expect(map.superproject.repoKey).toBe("repo-b");
    expect(map.submodules).toHaveLength(1);
    expect(map.submodules[0]!.repoKey).toBe("repo-a");
  });

  it("sorts submodules by commitOrder", () => {
    const targets = [
      makeTarget({ id: 1, repoKey: "parent", localPath: ".", commitOrder: 3 }),
      makeTarget({ id: 2, repoKey: "lib-b", localPath: "libs/b", commitOrder: 2 }),
      makeTarget({ id: 3, repoKey: "lib-a", localPath: "libs/a", commitOrder: 1 }),
    ];

    const map = buildRepositoryMap(targets, {
      parent: true,
      "lib-b": true,
      "lib-a": true,
    });

    expect(map.superproject.repoKey).toBe("parent");
    expect(map.submodules.map((s) => s.repoKey)).toEqual(["lib-a", "lib-b"]);
  });

  it("returns empty submodules for single target", () => {
    const targets = [
      makeTarget({ id: 1, repoKey: "only-repo", localPath: ".", commitOrder: 1 }),
    ];

    const map = buildRepositoryMap(targets, { "only-repo": true });

    expect(map.superproject.repoKey).toBe("only-repo");
    expect(map.submodules).toEqual([]);
  });
});
