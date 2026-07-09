import { describe, it, expect, vi } from "vitest";
import { RuntimeRegistry } from "../../src/runtime/runtimeRegistry.js";
import { RuntimeAwareWorkspaceRunner } from "../../src/runtime/runtimeAwareWorkspaceRunner.js";
import type { TaskId, WorkspaceHandle, WorkspaceRunner } from "../../src/interfaces.js";

function runnerStub(tag: string): WorkspaceRunner {
  return {
    createWorkspace: vi.fn().mockResolvedValue({ taskId: "t", hostWorkspacePath: tag } as WorkspaceHandle),
    cloneRepo: vi.fn().mockResolvedValue({ success: true, localPath: tag }),
    runAgent: vi.fn().mockResolvedValue({ status: "success", modifiedFiles: [], summary: tag, agentLogs: "", metadata: {} }),
    destroyWorkspace: vi.fn().mockResolvedValue(undefined),
    execGitInVolume: vi.fn().mockResolvedValue(tag),
  } as unknown as WorkspaceRunner;
}

const handle = { taskId: "t1" as TaskId, hostWorkspacePath: "/w" } as WorkspaceHandle;

describe("RuntimeAwareWorkspaceRunner", () => {
  it("routes to the runtime resolved for the task", async () => {
    const docker = runnerStub("docker");
    const openshell = runnerStub("openshell");
    const registry = new RuntimeRegistry().register("docker", docker).register("openshell", openshell);
    const facade = new RuntimeAwareWorkspaceRunner(registry, () => ({ project: "openshell" }));

    await facade.createWorkspace("t1" as TaskId);
    expect(openshell.createWorkspace).toHaveBeenCalled();
    expect(docker.createWorkspace).not.toHaveBeenCalled();
  });

  it("collapses to the default runtime when selection is empty", async () => {
    const docker = runnerStub("docker");
    const registry = new RuntimeRegistry().register("docker", docker);
    const facade = new RuntimeAwareWorkspaceRunner(registry, () => ({}));
    await facade.destroyWorkspace(handle);
    expect(docker.destroyWorkspace).toHaveBeenCalledWith(handle);
  });

  it("supports an async selection resolver", async () => {
    const docker = runnerStub("docker");
    const openshell = runnerStub("openshell");
    const registry = new RuntimeRegistry().register("docker", docker).register("openshell", openshell);
    const facade = new RuntimeAwareWorkspaceRunner(registry, async () => ({ agent: "openshell" }));
    const out = await facade.execGitInVolume(handle, ["status"]);
    expect(out).toBe("openshell");
  });

  it("throws when the resolved runtime lacks an optional capability", async () => {
    const minimal = {
      createWorkspace: vi.fn(),
      cloneRepo: vi.fn(),
      runAgent: vi.fn(),
      destroyWorkspace: vi.fn(),
    } as unknown as WorkspaceRunner;
    const registry = new RuntimeRegistry().register("docker", minimal);
    const facade = new RuntimeAwareWorkspaceRunner(registry, () => ({}));
    await expect(facade.execGitInVolume(handle, ["status"])).rejects.toThrow(/does not support/);
  });
});
