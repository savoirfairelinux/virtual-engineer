import { describe, it, expect } from "vitest";
import { buildRepositoryMap } from "../../src/orchestrator/orchestrator.js";
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

    const map = buildRepositoryMap(targets);

    expect(map.superproject).toEqual({ repoKey: "jami-client-qt", localPath: "." });
    expect(map.submodules).toEqual([{ repoKey: "daemon", localPath: "daemon" }]);
  });

  it("falls back to lowest commitOrder when no localPath is '.'", () => {
    const targets = [
      makeTarget({ id: 1, repoKey: "repo-a", localPath: "a", commitOrder: 2 }),
      makeTarget({ id: 2, repoKey: "repo-b", localPath: "b", commitOrder: 1 }),
    ];

    const map = buildRepositoryMap(targets);

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

    const map = buildRepositoryMap(targets);

    expect(map.superproject.repoKey).toBe("parent");
    expect(map.submodules.map((s) => s.repoKey)).toEqual(["lib-a", "lib-b"]);
  });

  it("returns empty submodules for single target", () => {
    const targets = [
      makeTarget({ id: 1, repoKey: "only-repo", localPath: ".", commitOrder: 1 }),
    ];

    const map = buildRepositoryMap(targets);

    expect(map.superproject.repoKey).toBe("only-repo");
    expect(map.submodules).toEqual([]);
  });
});
