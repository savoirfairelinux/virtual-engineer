import { describe, it, expect, vi, beforeEach } from "vitest";

const { logger } = vi.hoisted(() => ({
  logger: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock("../../src/logger.js", () => ({
  getLogger: vi.fn(() => logger),
}));

vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("../../src/workspace/dockerVolume.js", () => ({
  createVolume: vi.fn().mockResolvedValue(undefined),
  removeVolume: vi.fn().mockResolvedValue(undefined),
  execInVolume: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
}));

import { execInVolume } from "../../src/workspace/dockerVolume.js";
import { DockerWorkspaceRunner } from "../../src/workspace/workspaceRunner.js";
import { makeTaskId } from "../../src/interfaces.js";
import type { AgentAdapter, ProjectPushTargetRecord, ProjectId } from "../../src/interfaces.js";

const execInVolumeMock = vi.mocked(execInVolume);

function makeAdapter(): AgentAdapter {
  return {
    name: "mock",
    buildContainerSpec: vi.fn(() => ({ image: "x", env: {}, command: [] })),
    execute: vi.fn(),
  };
}

function makeTarget(over: Partial<ProjectPushTargetRecord> & { id: number; commitOrder: number; localPath: string }): ProjectPushTargetRecord {
  return {
    id: over.id,
    projectId: "p1" as ProjectId,
    integrationId: over.integrationId ?? "int-1",
    repoKey: over.repoKey ?? `repo-${over.id}`,
    cloneUrl: over.cloneUrl ?? `git@example.com:${over.repoKey ?? `repo-${over.id}`}.git`,
    targetBranch: over.targetBranch ?? "main",
    role: over.role ?? "primary",
    commitOrder: over.commitOrder,
    localPath: over.localPath,
    sshKeyPath: over.sshKeyPath ?? null,
    reviewerEmails: over.reviewerEmails ?? [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("DockerWorkspaceRunner.prepareProjectWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execInVolumeMock.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
  });

  it("clones all push targets sorted by commitOrder via execInVolume", async () => {
    const runner = new DockerWorkspaceRunner(
      { agentContainerImage: "ve:latest", agentTimeoutMs: 1000 },
      makeAdapter(),
    );
    const handle = await runner.createWorkspace(makeTaskId("t1"));

    const targets: ProjectPushTargetRecord[] = [
      makeTarget({ id: 1, commitOrder: 1, localPath: ".", repoKey: "super", cloneUrl: "git@host:super.git" }),
      makeTarget({ id: 2, commitOrder: 2, localPath: "libs/core", repoKey: "core", cloneUrl: "git@host:core.git" }),
      makeTarget({ id: 3, commitOrder: 3, localPath: "libs/ui", repoKey: "ui", cloneUrl: "git@host:ui.git" }),
    ];

    const result = await runner.prepareProjectWorkspace(handle, targets);

    expect(result.success).toBe(true);
    // Root clone + (mkdir + clone) × 2 secondary targets = 5 calls
    expect(execInVolumeMock).toHaveBeenCalledTimes(5);
    // Root clone command includes "git clone"
    const rootCall = execInVolumeMock.mock.calls[0]![0];
    expect(rootCall.command).toContain("git");
    expect(rootCall.command).toContain("git@host:super.git");
  });

  it("treats lowest commitOrder as root when no '.' localPath exists", async () => {
    const runner = new DockerWorkspaceRunner(
      { agentContainerImage: "ve:latest", agentTimeoutMs: 1000 },
      makeAdapter(),
    );
    const handle = await runner.createWorkspace(makeTaskId("t2"));
    const targets: ProjectPushTargetRecord[] = [
      makeTarget({ id: 1, commitOrder: 1, localPath: "a", cloneUrl: "git@host:a.git" }),
      makeTarget({ id: 2, commitOrder: 2, localPath: "b", cloneUrl: "git@host:b.git" }),
    ];

    const result = await runner.prepareProjectWorkspace(handle, targets);

    expect(result.success).toBe(true);
    // Root (lowest commitOrder = a) cloned first
    const rootCall = execInVolumeMock.mock.calls[0]![0];
    expect(rootCall.command).toContain("git@host:a.git");
  });

  it("hard-fails when the root push target clone fails", async () => {
    execInVolumeMock.mockResolvedValueOnce({ stdout: "", stderr: "network unreachable", exitCode: 1 });

    const runner = new DockerWorkspaceRunner(
      { agentContainerImage: "ve:latest", agentTimeoutMs: 1000 },
      makeAdapter(),
    );
    const handle = await runner.createWorkspace(makeTaskId("t3"));
    const targets: ProjectPushTargetRecord[] = [
      makeTarget({ id: 1, commitOrder: 1, localPath: ".", cloneUrl: "git@host:root.git" }),
    ];

    const result = await runner.prepareProjectWorkspace(handle, targets);
    expect(result.success).toBe(false);
    expect(result.error).toContain("root clone failed");
  });

  it("redacts credentials echoed by a failed root clone", async () => {
    const repoUrl =
      "https://x-access-token:ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345@github.com/org/root.git";
    execInVolumeMock.mockResolvedValueOnce({
      stdout: "",
      stderr: `fatal: unable to access '${repoUrl}'`,
      exitCode: 1,
    });
    const runner = new DockerWorkspaceRunner(
      { agentContainerImage: "ve:latest", agentTimeoutMs: 1000 },
      makeAdapter(),
    );
    const handle = await runner.createWorkspace(makeTaskId("t3-redaction"));

    const result = await runner.prepareProjectWorkspace(handle, [
      makeTarget({ id: 1, commitOrder: 1, localPath: ".", cloneUrl: repoUrl }),
    ]);

    expect(result.error).not.toContain("ghp_");
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("ghp_");
  });

  it("continues when a non-root target fails (best-effort)", async () => {
    // Root succeeds, second fails, third succeeds
    execInVolumeMock
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "", stderr: "auth denied", exitCode: 1 })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });

    const runner = new DockerWorkspaceRunner(
      { agentContainerImage: "ve:latest", agentTimeoutMs: 1000 },
      makeAdapter(),
    );
    const handle = await runner.createWorkspace(makeTaskId("t4"));
    const targets: ProjectPushTargetRecord[] = [
      makeTarget({ id: 1, commitOrder: 1, localPath: ".", repoKey: "root" }),
      makeTarget({ id: 2, commitOrder: 2, localPath: "a", repoKey: "a" }),
      makeTarget({ id: 3, commitOrder: 3, localPath: "b", repoKey: "b" }),
    ];

    const result = await runner.prepareProjectWorkspace(handle, targets);
    expect(result.success).toBe(true);
    expect(result.error).toContain("a:");
    expect(execInVolumeMock).toHaveBeenCalledTimes(3);
  });

  it("runs postCloneScript after all clones succeed", async () => {
    const runner = new DockerWorkspaceRunner(
      { agentContainerImage: "ve:latest", agentTimeoutMs: 1000 },
      makeAdapter(),
    );
    const handle = await runner.createWorkspace(makeTaskId("t5"));
    const targets: ProjectPushTargetRecord[] = [
      makeTarget({ id: 1, commitOrder: 1, localPath: ".", cloneUrl: "git@host:root.git" }),
    ];

    const result = await runner.prepareProjectWorkspace(handle, targets, "echo hello");
    expect(result.success).toBe(true);
    // clone + postCloneScript = 2 calls
    expect(execInVolumeMock).toHaveBeenCalledTimes(2);
    const scriptCall = execInVolumeMock.mock.calls[1]![0];
    expect(scriptCall.command).toEqual(["bash", "-c", "echo hello"]);
  });

  it("fails the operation when postCloneScript fails", async () => {
    execInVolumeMock
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }) // clone ok
      .mockResolvedValueOnce({ stdout: "", stderr: "script returned 1", exitCode: 1 }); // script fails

    const runner = new DockerWorkspaceRunner(
      { agentContainerImage: "ve:latest", agentTimeoutMs: 1000 },
      makeAdapter(),
    );
    const handle = await runner.createWorkspace(makeTaskId("t6"));
    const targets: ProjectPushTargetRecord[] = [
      makeTarget({ id: 1, commitOrder: 1, localPath: ".", cloneUrl: "git@host:root.git" }),
    ];

    const result = await runner.prepareProjectWorkspace(handle, targets, "exit 1");
    expect(result.success).toBe(false);
    expect(result.error).toContain("postCloneScript failed");
  });
});
