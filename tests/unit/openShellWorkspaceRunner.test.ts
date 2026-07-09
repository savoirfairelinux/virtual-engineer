import { describe, it, expect, vi } from "vitest";
import { OpenShellWorkspaceRunner } from "../../src/workspace/openShellWorkspaceRunner.js";
import type { HostGitExecutor } from "../../src/workspace/hostGitExecutor.js";
import type { OpenShellClient } from "../../src/openshell/openShellClient.js";
import type {
  AgentAdapter,
  ProjectPushTargetRecord,
  ReviewWorkspaceInput,
  TaskContext,
  TaskId,
  WorkspaceHandle,
} from "../../src/interfaces.js";

function fakeGit(overrides: Partial<HostGitExecutor> = {}): HostGitExecutor {
  return {
    createWorkspace: vi.fn().mockResolvedValue({ dir: "/tmp/ws-1" }),
    cloneRepo: vi.fn().mockResolvedValue(undefined),
    execGit: vi.fn().mockResolvedValue(""),
    fetchAndCheckout: vi.fn().mockResolvedValue(undefined),
    fetchAndCherryPick: vi.fn().mockResolvedValue(undefined),
    listModifiedFiles: vi.fn().mockResolvedValue([]),
    destroyWorkspace: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as HostGitExecutor;
}

function fakeClient(overrides: Partial<OpenShellClient> = {}): OpenShellClient {
  return {
    createSandbox: vi.fn().mockResolvedValue(undefined),
    execInSandbox: vi.fn().mockResolvedValue({ code: 0, stdout: "ok", stderr: "" }),
    setPolicy: vi.fn().mockResolvedValue(undefined),
    removeSandbox: vi.fn().mockResolvedValue(undefined),
    gatewayHealthy: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as OpenShellClient;
}

const handle: WorkspaceHandle = {
  taskId: "t1" as TaskId,
  containerId: "openshell:t1",
  volumeName: "/tmp/ws-1",
  homeVolumeName: "/tmp/ws-1",
  hostWorkspacePath: "/tmp/ws-1",
  containerImage: "base",
};

describe("OpenShellWorkspaceRunner", () => {
  it("createWorkspace returns a host-backed handle", async () => {
    const git = fakeGit();
    const runner = new OpenShellWorkspaceRunner({ git, client: fakeClient(), sandboxImage: "base" });
    const h = await runner.createWorkspace("t1" as TaskId);
    expect(h.hostWorkspacePath).toBe("/tmp/ws-1");
    expect(h.containerImage).toBe("base");
  });

  it("delegates clone to HostGitExecutor and reports success", async () => {
    const git = fakeGit();
    const runner = new OpenShellWorkspaceRunner({ git, client: fakeClient(), sandboxImage: "base" });
    const res = await runner.cloneRepo(handle, "https://h/r.git", "main");
    expect(res.success).toBe(true);
    expect(git.cloneRepo).toHaveBeenCalledWith("/tmp/ws-1", "https://h/r.git", "main");
  });

  it("clone failure returns a CloneResult error, not a throw", async () => {
    const git = fakeGit({ cloneRepo: vi.fn().mockRejectedValue(new Error("fatal: nope")) });
    const runner = new OpenShellWorkspaceRunner({ git, client: fakeClient(), sandboxImage: "base" });
    const res = await runner.cloneRepo(handle, "u", "main");
    expect(res.success).toBe(false);
    expect(res.error).toContain("fatal");
  });

  it("prepareProjectWorkspace clones targets in commitOrder and tolerates secondary failures", async () => {
    const cloneRepo = vi
      .fn()
      .mockResolvedValueOnce(undefined) // root
      .mockRejectedValueOnce(new Error("secondary boom")); // lib
    const git = fakeGit({ cloneRepo });
    const runner = new OpenShellWorkspaceRunner({ git, client: fakeClient(), sandboxImage: "base" });
    const targets: ProjectPushTargetRecord[] = [
      { repoKey: "lib", cloneUrl: "u2", targetBranch: "main", role: "dependency", commitOrder: 2, localPath: "libs/lib", integrationId: "i", sshKeyPath: null } as unknown as ProjectPushTargetRecord,
      { repoKey: "root", cloneUrl: "u1", targetBranch: "main", role: "primary", commitOrder: 1, localPath: ".", integrationId: "i", sshKeyPath: null } as unknown as ProjectPushTargetRecord,
    ];
    const res = await runner.prepareProjectWorkspace(handle, targets);
    expect(res.success).toBe(true);
    expect((cloneRepo.mock.calls[0] ?? [])[1]).toBe("u1"); // root cloned first
  });

  it("applies a resolved policy before running the review agent", async () => {
    const client = fakeClient();
    const runner = new OpenShellWorkspaceRunner({
      git: fakeGit(),
      client,
      sandboxImage: "base",
      agent: "claude",
      resolvePolicy: ({ mode }) => (mode === "review" ? "network:\n  default: deny\n" : undefined),
    });
    const input = { changeId: "Iabc" } as unknown as ReviewWorkspaceInput;
    const out = await runner.runReviewInDocker(handle, input);
    expect(client.createSandbox).toHaveBeenCalledWith({ name: "ve-t1", agent: "claude" });
    expect(client.setPolicy).toHaveBeenCalledWith("ve-t1", expect.stringContaining("default: deny"));
    expect(out.rawOutput).toBe("ok");
  });

  it("runAgent returns success when files changed", async () => {
    const git = fakeGit({ listModifiedFiles: vi.fn().mockResolvedValue(["a.ts"]) });
    const runner = new OpenShellWorkspaceRunner({ git, client: fakeClient(), sandboxImage: "base" });
    const ctx = { taskId: "t1" } as unknown as TaskContext;
    const adapter = { name: "copilot" } as unknown as AgentAdapter;
    const result = await runner.runAgent(handle, ctx, adapter);
    expect(result.status).toBe("success");
    expect(result.modifiedFiles).toEqual(["a.ts"]);
    expect(result.metadata["runtime"]).toBe("openshell");
  });

  it("runAgent reports no_change when nothing changed", async () => {
    const runner = new OpenShellWorkspaceRunner({ git: fakeGit(), client: fakeClient(), sandboxImage: "base" });
    const result = await runner.runAgent(
      handle,
      { taskId: "t1" } as unknown as TaskContext,
      { name: "copilot" } as unknown as AgentAdapter
    );
    expect(result.status).toBe("no_change");
  });

  it("destroyWorkspace removes the sandbox and the host dir", async () => {
    const git = fakeGit();
    const client = fakeClient();
    const runner = new OpenShellWorkspaceRunner({ git, client, sandboxImage: "base" });
    await runner.destroyWorkspace(handle);
    expect(client.removeSandbox).toHaveBeenCalledWith("ve-t1");
    expect(git.destroyWorkspace).toHaveBeenCalledWith("/tmp/ws-1");
  });
});
