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
    rebuildTrustedMetadata: vi.fn().mockResolvedValue(undefined),
    destroyWorkspace: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as HostGitExecutor;
}

function fakeClient(overrides: Partial<OpenShellClient> = {}): OpenShellClient {
  return {
    createSandbox: vi.fn().mockResolvedValue(undefined),
    uploadToSandbox: vi.fn().mockResolvedValue(undefined),
    downloadFromSandbox: vi.fn().mockResolvedValue(undefined),
    execInSandbox: vi.fn().mockResolvedValue({ code: 0, stdout: "ok", stderr: "" }),
    setPolicy: vi.fn().mockResolvedValue(undefined),
    allowEgress: vi.fn().mockResolvedValue(undefined),
    removeSandbox: vi.fn().mockResolvedValue(undefined),
    gatewayHealthy: vi.fn().mockResolvedValue(true),
    getSandboxLogs: vi.fn().mockResolvedValue(""),
    ...overrides,
  } as unknown as OpenShellClient;
}

/** Minimal coding adapter that resolves prompts (prompt-aware). */
function fakeCodingAdapter(spec: Partial<{ env: Record<string, string>; image: string; command: string[]; userPromptContent: string }> = {}, executeResult?: unknown): AgentAdapter {
  return {
    name: "copilot",
    buildContainerSpec: vi.fn(),
    buildContainerSpecWithPrompts: vi.fn().mockResolvedValue({
      image: spec.image ?? "agent:img",
      env: spec.env ?? { COPILOT_MODEL: "auto" },
      command: spec.command ?? ["node", "/agent-worker/dist/index.js"],
      egress: { hosts: ["api.githubcopilot.com"], binaries: ["/usr/local/bin/node"] },
      ...(spec.userPromptContent !== undefined ? { userPromptContent: spec.userPromptContent } : {}),
    }),
    execute: vi.fn().mockResolvedValue(
      executeResult ?? { status: "success", modifiedFiles: ["a.ts"], summary: "done", agentLogs: "", metadata: {} }
    ),
  } as unknown as AgentAdapter;
}

/** Minimal review adapter that builds a review container spec. */
function fakeReviewAdapter(spec: Partial<{ env: Record<string, string>; image: string; command: string[] }> = {}): AgentAdapter {
  return {
    name: "copilot",
    buildReviewContainerSpec: vi.fn().mockReturnValue({
      image: spec.image ?? "agent:img",
      env: spec.env ?? { REVIEW_MODE: "1" },
      command: spec.command ?? ["node", "/agent-worker/dist/index.js"],
      egress: { hosts: ["api.githubcopilot.com"], binaries: ["/usr/local/bin/node"] },
    }),
  } as unknown as AgentAdapter;
}

function reviewWorkerStdout(rawOutput: string): string {
  return JSON.stringify({
    status: "success",
    modifiedFiles: [],
    summary: rawOutput.slice(0, 500),
    agentLogs: rawOutput,
    rawOutput,
    metadata: { reviewMode: true },
  }) + "\n";
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
  it("persists policy denials from the completed sandbox log snapshot", async () => {
    const recordDenial = vi.fn().mockResolvedValue(undefined);
    const client = fakeClient({
      getSandboxLogs: vi.fn().mockResolvedValue(
        "[1.0] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(64) -> blocked.example:443 [policy:- engine:opa]"
      ),
    } as unknown as Partial<OpenShellClient>);
    const runner = new OpenShellWorkspaceRunner({
      git: fakeGit(),
      client,
      sandboxImage: "base",
      recordDenial,
    });
    await runner.prepareProjectWorkspace(handle, [{
      repoKey: "root", cloneUrl: "https://example.test/repo.git", targetBranch: "main", role: "primary",
      commitOrder: 1, localPath: ".", integrationId: "i", sshKeyPath: null,
    }] as unknown as ProjectPushTargetRecord[]);

    await runner.runAgentInDocker(
      fakeCodingAdapter(),
      { taskId: "t1", projectId: "p1", workspacePath: "/tmp/ws-1" } as unknown as TaskContext,
    );

    expect(recordDenial).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "t1",
      projectId: "p1",
      host: "blocked.example",
      decision: "deny",
    }));
  });

  it("collects policy denials when coding workspace upload fails", async () => {
    const recordDenial = vi.fn().mockResolvedValue(undefined);
    const client = fakeClient({
      uploadToSandbox: vi.fn().mockRejectedValue(new Error("upload failed")),
      getSandboxLogs: vi.fn().mockResolvedValue(
        "[1.0] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(64) -> blocked.example:443 [policy:- engine:opa]"
      ),
    } as unknown as Partial<OpenShellClient>);
    const runner = new OpenShellWorkspaceRunner({ git: fakeGit(), client, sandboxImage: "base", recordDenial });

    await expect(runner.runAgentInDocker(
      fakeCodingAdapter(),
      { taskId: "t1", projectId: "p1", workspacePath: "/tmp/ws-1" } as unknown as TaskContext,
    )).rejects.toThrow("upload failed");

    expect(recordDenial).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "t1",
      projectId: "p1",
      decision: "deny",
    }));
  });

  it("attempts denial collection when sandbox creation fails ambiguously", async () => {
    const recordDenial = vi.fn().mockResolvedValue(undefined);
    const getSandboxLogs = vi.fn().mockResolvedValue(
      "[1.0] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(64) -> blocked.example:443 [policy:- engine:opa]"
    );
    const client = fakeClient({
      createSandbox: vi.fn().mockRejectedValue(new Error("gateway timeout")),
      getSandboxLogs,
    } as unknown as Partial<OpenShellClient>);
    const runner = new OpenShellWorkspaceRunner({ git: fakeGit(), client, sandboxImage: "base", recordDenial });

    await expect(runner.runAgentInDocker(
      fakeCodingAdapter(),
      { taskId: "t1", projectId: "p1", workspacePath: "/tmp/ws-1" } as unknown as TaskContext,
    )).rejects.toThrow("gateway timeout");

    expect(getSandboxLogs).toHaveBeenCalledOnce();
    expect(recordDenial).toHaveBeenCalledWith(expect.objectContaining({ taskId: "t1", projectId: "p1" }));
  });

  it("createWorkspace returns a host-backed handle", async () => {
    const git = fakeGit();
    const runner = new OpenShellWorkspaceRunner({ git, client: fakeClient(), sandboxImage: "base" });
    const h = await runner.createWorkspace("t1" as TaskId);
    expect(h.hostWorkspacePath).toBe("/tmp/ws-1");
    expect(h.containerImage).toBe("base");
  });

  it("uses a unique sandbox identity for each workspace attempt", async () => {
    const git = fakeGit({
      createWorkspace: vi.fn()
        .mockResolvedValueOnce({ dir: "/tmp/ws-1" })
        .mockResolvedValueOnce({ dir: "/tmp/ws-2" }),
    });
    const client = fakeClient();
    const runner = new OpenShellWorkspaceRunner({ git, client, sandboxImage: "base" });

    const first = await runner.createWorkspace("t1" as TaskId);
    const second = await runner.createWorkspace("t1" as TaskId);
    expect(first.containerId).not.toBe(second.containerId);

    await runner.destroyWorkspace(first);
    expect(client.removeSandbox).toHaveBeenCalledWith(first.containerId.replace("openshell:", ""));
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

  it("runs the configured post-clone script inside the sandbox", async () => {
    const execInSandbox = vi.fn()
      .mockResolvedValueOnce({ code: 0, stdout: "installed", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "ok", stderr: "" });
    const runner = new OpenShellWorkspaceRunner({
      git: fakeGit(),
      client: fakeClient({ execInSandbox } as unknown as Partial<OpenShellClient>),
      sandboxImage: "base",
    });
    const targets = [{
      repoKey: "root", cloneUrl: "u1", targetBranch: "main", role: "primary",
      commitOrder: 1, localPath: ".", integrationId: "i", sshKeyPath: null,
    }] as unknown as ProjectPushTargetRecord[];

    const result = await runner.prepareProjectWorkspace(handle, targets, "npm ci");
    expect(result.success).toBe(true);
    await runner.runAgentInDocker(
      fakeCodingAdapter(),
      { taskId: "t1", workspacePath: "/tmp/ws-1" } as unknown as TaskContext,
    );
    expect(execInSandbox.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      command: ["sh", "-lc", "npm ci"],
      workdir: "/sandbox/ws-1",
    }));
    expect(execInSandbox.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      command: ["node", "/agent-worker/dist/index.js"],
    }));
  });

  it("applies a resolved policy before running the review agent", async () => {
    const client = fakeClient({
      execInSandbox: vi.fn().mockResolvedValue({
        code: 0,
        stdout: reviewWorkerStdout("ok"),
        stderr: "",
      }),
    } as unknown as Partial<OpenShellClient>);
    const runner = new OpenShellWorkspaceRunner({
      git: fakeGit(),
      client,
      sandboxImage: "base",
      agentAdapter: fakeReviewAdapter(),
      resolvePolicy: ({ mode }) => (mode === "review" ? "network:\n  default: deny\n" : undefined),
    });
    const input = { changeId: "Iabc", prompt: "review this diff" } as unknown as ReviewWorkspaceInput;
    const out = await runner.runReviewInDocker(handle, input);
    expect(client.createSandbox).toHaveBeenCalledWith(expect.objectContaining({
      name: "ve-t1",
      from: "agent:img",
      env: { REVIEW_MODE: "1" },
      policyYaml: expect.stringContaining("default: deny"),
      beforeRetryCleanup: expect.any(Function),
    }));
    expect(client.setPolicy).not.toHaveBeenCalled();
    // Egress is opened for the review agent's model API.
    expect(client.allowEgress).toHaveBeenCalledWith(
      expect.objectContaining({ name: "ve-t1", hosts: ["api.githubcopilot.com"], binaries: ["/usr/local/bin/node"] })
    );
    // Review uploads the workspace (read-only) but never downloads it back.
    expect(client.uploadToSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ name: "ve-t1", dest: "/sandbox", noGitIgnore: true })
    );
    expect(client.execInSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ env: { USER_PROMPT_FILE: expect.any(String) } })
    );
    expect(client.downloadFromSandbox).not.toHaveBeenCalled();
    expect(out.rawOutput).toBe("ok");
  });

  it("forwards review stderr chunks and the OpenShell exec timeout", async () => {
    const onStderrChunk = vi.fn();
    const execInSandbox = vi.fn().mockImplementation(async (input: {
      onStderrChunk?: ((chunk: string) => void) | undefined;
    }) => {
      input.onStderrChunk?.("review-event\n");
      return { code: 0, stdout: reviewWorkerStdout("ok"), stderr: "review-event\n" };
    });
    const runner = new OpenShellWorkspaceRunner({
      git: fakeGit(),
      client: fakeClient({ execInSandbox } as unknown as Partial<OpenShellClient>),
      sandboxImage: "base",
      agentAdapter: fakeReviewAdapter(),
      execTimeoutSec: 3600,
    });

    await runner.runReviewInDocker(
      handle,
      { changeId: "Iabc", prompt: "review this diff" } as unknown as ReviewWorkspaceInput,
      { onStderrChunk },
    );

    expect(onStderrChunk).toHaveBeenCalledWith("review-event\n");
    expect(execInSandbox).toHaveBeenCalledWith(expect.objectContaining({ timeout: 3600 }));
  });

  it("rejects review output when OpenShell exec exits non-zero", async () => {
    const client = fakeClient({
      execInSandbox: vi.fn().mockResolvedValue({
        code: 124,
        stdout: reviewWorkerStdout("partial result"),
        stderr: "timed out",
      }),
    } as unknown as Partial<OpenShellClient>);
    const runner = new OpenShellWorkspaceRunner({
      git: fakeGit(),
      client,
      sandboxImage: "base",
      agentAdapter: fakeReviewAdapter(),
    });

    await expect(runner.runReviewInDocker(
      handle,
      { changeId: "Iabc", prompt: "review this diff" } as unknown as ReviewWorkspaceInput,
    )).rejects.toThrow(/exited with code 124.*timed out/i);
  });

  it("coding run uploads the workspace, execs the agent, and downloads results back", async () => {
    const client = fakeClient();
    const git = fakeGit();
    const runner = new OpenShellWorkspaceRunner({ git, client, sandboxImage: "base" });
    const ctx = { taskId: "t1", workspacePath: "/tmp/ws-1" } as unknown as TaskContext;
    const adapter = fakeCodingAdapter({ env: { GITHUB_TOKEN: "tok" }, userPromptContent: "do the task" });
    await runner.cloneRepo(handle, "https://trusted.example/repo.git", "main");
    await runner.runAgentInDocker(adapter, ctx, { GITHUB_TOKEN: "tok" });

    expect(client.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ name: "ve-t1", from: "agent:img", env: { GITHUB_TOKEN: "tok" } })
    );
    // Egress is opened for the coding agent's model API.
    expect(client.allowEgress).toHaveBeenCalledWith(
      expect.objectContaining({ name: "ve-t1", hosts: ["api.githubcopilot.com"], binaries: ["/usr/local/bin/node"] })
    );
    // Workspace uploaded with .git under /sandbox (openshell nests by basename),
    // then the agent execs in the nested repo dir, then that dir is downloaded back.
    const uploadCalls = (client.uploadToSandbox as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(uploadCalls.some(([a]) => a.dest === "/sandbox" && a.noGitIgnore === true)).toBe(true);
    expect(client.execInSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "ve-t1",
        workdir: "/sandbox/ws-1",
        env: { USER_PROMPT_FILE: expect.any(String) },
      })
    );
    expect(client.downloadFromSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ name: "ve-t1", sandboxPath: "/sandbox/ws-1", localDest: "/tmp/ws-1" })
    );
    expect(git.rebuildTrustedMetadata).toHaveBeenCalledWith(
      "/tmp/ws-1",
      new Map([[".", "https://trusted.example/repo.git"]]),
    );
  });

  it("forwards coding output chunks and the OpenShell exec timeout", async () => {
    const onStdoutChunk = vi.fn();
    const onStderrChunk = vi.fn();
    const execInSandbox = vi.fn().mockImplementation(async (input: {
      onStdoutChunk?: ((chunk: string) => void) | undefined;
      onStderrChunk?: ((chunk: string) => void) | undefined;
    }) => {
      input.onStdoutChunk?.("result");
      input.onStderrChunk?.("agent-event\n");
      return { code: 0, stdout: "result", stderr: "agent-event\n" };
    });
    const runner = new OpenShellWorkspaceRunner({
      git: fakeGit(),
      client: fakeClient({ execInSandbox } as unknown as Partial<OpenShellClient>),
      sandboxImage: "base",
      execTimeoutSec: 3600,
    });

    await runner.cloneRepo(handle, "https://trusted.example/repo.git", "main");

    await runner.runAgentInDocker(
      fakeCodingAdapter(),
      { taskId: "t1", workspacePath: "/tmp/ws-1" } as unknown as TaskContext,
      {},
      { onStdoutChunk, onStderrChunk },
    );

    expect(onStdoutChunk).toHaveBeenCalledWith("result");
    expect(onStderrChunk).toHaveBeenCalledWith("agent-event\n");
    expect(execInSandbox).toHaveBeenCalledWith(expect.objectContaining({ timeout: 3600 }));
  });

  it("rejects coding output and skips download when OpenShell exec exits non-zero", async () => {
    const client = fakeClient({
      execInSandbox: vi.fn().mockResolvedValue({ code: 137, stdout: "partial", stderr: "killed" }),
    } as unknown as Partial<OpenShellClient>);
    const runner = new OpenShellWorkspaceRunner({ git: fakeGit(), client, sandboxImage: "base" });

    await expect(runner.runAgentInDocker(
      fakeCodingAdapter(),
      { taskId: "t1", workspacePath: "/tmp/ws-1" } as unknown as TaskContext,
    )).rejects.toThrow(/exited with code 137.*killed/i);
    expect(client.downloadFromSandbox).not.toHaveBeenCalled();
  });

  it("runAgent delegates to adapter.execute and returns its result", async () => {
    const runner = new OpenShellWorkspaceRunner({ git: fakeGit(), client: fakeClient(), sandboxImage: "base" });
    const ctx = { taskId: "t1", workspacePath: "/tmp/ws-1" } as unknown as TaskContext;
    const adapter = fakeCodingAdapter({}, { status: "success", modifiedFiles: ["a.ts"], summary: "s", agentLogs: "", metadata: {} });
    const result = await runner.runAgent(handle, ctx, adapter);
    expect(adapter.execute).toHaveBeenCalledWith({ ...ctx, runtimeHandleId: handle.containerId });
    expect(result.status).toBe("success");
    expect(result.modifiedFiles).toEqual(["a.ts"]);
  });

  it("runAgent throws when no adapter is available", async () => {
    const runner = new OpenShellWorkspaceRunner({ git: fakeGit(), client: fakeClient(), sandboxImage: "base" });
    await expect(
      runner.runAgent(handle, { taskId: "t1", workspacePath: "/tmp/ws-1" } as unknown as TaskContext)
    ).rejects.toThrow(/requires an agent adapter/);
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
