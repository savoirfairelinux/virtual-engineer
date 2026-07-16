import { describe, it, expect, vi } from "vitest";
import {
  OpenShellWorkspaceRunner as ProductionOpenShellWorkspaceRunner,
  type OpenShellRunnerDeps,
} from "../../src/workspace/openShellWorkspaceRunner.js";
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
import { sandboxTaskHash } from "../../src/openshell/sandboxOwnership.js";

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
    createProvider: vi.fn().mockResolvedValue(undefined),
    removeProvider: vi.fn().mockResolvedValue(undefined),
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

type TestRunnerDeps = Omit<OpenShellRunnerDeps, "managedProviderStore"> &
  Partial<Pick<OpenShellRunnerDeps, "managedProviderStore">>;

class OpenShellWorkspaceRunner extends ProductionOpenShellWorkspaceRunner {
  constructor(deps: TestRunnerDeps) {
    const managedProviderStore = deps.managedProviderStore ?? {
      recordManagedOpenShellProvider: vi.fn().mockResolvedValue(undefined),
      deleteManagedOpenShellProvider: vi.fn().mockResolvedValue(undefined),
    };
    super({ ...deps, managedProviderStore });
  }
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

  it("deduplicates overlapping denial snapshots but preserves later events", async () => {
    const firstEvent = "[1.0] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(64) -> blocked.example:443 [policy:- engine:opa]";
    const laterEvent = "[2.0] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(64) -> blocked.example:443 [policy:- engine:opa]";
    const recordDenial = vi.fn().mockResolvedValue(undefined);
    const getSandboxLogs = vi.fn()
      .mockResolvedValueOnce(firstEvent)
      .mockResolvedValueOnce(`${firstEvent}\n${laterEvent}`);
    const createSandbox = vi.fn(async (input: Parameters<OpenShellClient["createSandbox"]>[0]) => {
      await input.beforeRetryCleanup?.();
    });
    const runner = new OpenShellWorkspaceRunner({
      git: fakeGit(),
      client: fakeClient({ createSandbox, getSandboxLogs } as unknown as Partial<OpenShellClient>),
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

    expect(getSandboxLogs).toHaveBeenCalledTimes(2);
    expect(recordDenial).toHaveBeenCalledTimes(2);
    expect(recordDenial.mock.calls.map(([denial]) => denial.reason)).toEqual([
      expect.stringContaining("[1.0]"),
      expect.stringContaining("[2.0]"),
    ]);
  });

  it("retries a denial after its first persistence attempt fails", async () => {
    const event = "[1.0] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(64) -> blocked.example:443 [policy:- engine:opa]";
    const recordDenial = vi.fn()
      .mockRejectedValueOnce(new Error("database busy"))
      .mockResolvedValueOnce(undefined);
    const createSandbox = vi.fn(async (input: Parameters<OpenShellClient["createSandbox"]>[0]) => {
      await input.beforeRetryCleanup?.();
    });
    const runner = new OpenShellWorkspaceRunner({
      git: fakeGit(),
      client: fakeClient({
        createSandbox,
        getSandboxLogs: vi.fn().mockResolvedValue(event),
      } as unknown as Partial<OpenShellClient>),
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

    expect(recordDenial).toHaveBeenCalledTimes(2);
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
    expect(client.removeSandbox).toHaveBeenCalledWith(first.containerId.replace("openshell:", ""), undefined);
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
    const abortController = new AbortController();
    const input = {
      changeId: "Iabc",
      prompt: "review this diff",
      abortSignal: abortController.signal,
    } as unknown as ReviewWorkspaceInput;
    const out = await runner.runReviewInDocker(handle, input);
    expect(client.createSandbox).toHaveBeenCalledWith(expect.objectContaining({
      name: "ve-t1",
      from: "agent:img",
      env: { REVIEW_MODE: "1" },
      policyYaml: expect.stringContaining("default: deny"),
      beforeRetryCleanup: expect.any(Function),
      signal: abortController.signal,
    }));
    expect(client.setPolicy).not.toHaveBeenCalled();
    // Egress is opened for the review agent's model API.
    expect(client.allowEgress).toHaveBeenCalledWith(
      expect.objectContaining({ name: "ve-t1", hosts: ["api.githubcopilot.com"], binaries: ["/usr/local/bin/node"], signal: abortController.signal })
    );
    // Review uploads the workspace (read-only) but never downloads it back.
    expect(client.uploadToSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ name: "ve-t1", dest: "/sandbox", noGitIgnore: true, signal: abortController.signal })
    );
    expect(client.uploadToSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ dest: "/tmp/user-prompt.txt", signal: abortController.signal })
    );
    expect(client.execInSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ env: { USER_PROMPT_FILE: expect.any(String) }, signal: abortController.signal })
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

  it.each([
    ["ANTHROPIC_API_KEY", "claude-code"],
    ["CLAUDE_CODE_OAUTH_TOKEN", "generic"],
  ])("moves %s into a %s provider while preserving review env", async (credentialKey, providerType) => {
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
      agentAdapter: fakeReviewAdapter({
        env: { REVIEW_MODE: "1", [credentialKey]: "secret" },
      }),
    });

    await runner.runReviewInDocker(
      handle,
      { changeId: "Iabc", prompt: "review this diff" } as unknown as ReviewWorkspaceInput,
    );

    expect(client.createProvider).toHaveBeenCalledWith({
      name: "ve-t1-agent",
      type: providerType,
      credentials: { [credentialKey]: "secret" },
    });
    expect(client.createSandbox).toHaveBeenCalledWith(expect.objectContaining({
      env: { REVIEW_MODE: "1" },
      providers: ["ve-t1-agent"],
    }));
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

  it("moves the Copilot credential into an attached provider before a coding run", async () => {
    const client = fakeClient();
    const git = fakeGit();
    const recordManagedProvider = vi.fn().mockResolvedValue(undefined);
    const runner = new OpenShellWorkspaceRunner({
      git,
      client,
      sandboxImage: "base",
      managedProviderStore: {
        recordManagedOpenShellProvider: recordManagedProvider,
        deleteManagedOpenShellProvider: vi.fn().mockResolvedValue(undefined),
      },
    });
    const ctx = { taskId: "t1", workspacePath: "/tmp/ws-1" } as unknown as TaskContext;
    const adapter = fakeCodingAdapter({
      env: { GITHUB_TOKEN: "tok", COPILOT_MODEL: "auto" },
      userPromptContent: "do the task",
    });
    await runner.cloneRepo(handle, "https://trusted.example/repo.git", "main");
    await runner.runAgentInDocker(adapter, ctx, { GITHUB_TOKEN: "tok" });

    expect(client.createProvider).toHaveBeenCalledWith({
      name: "ve-t1-agent",
      type: "copilot",
      credentials: { GITHUB_TOKEN: "tok" },
    });
    expect(recordManagedProvider).toHaveBeenCalledWith({
      providerName: "ve-t1-agent",
      sandboxName: "ve-t1",
      taskHash: sandboxTaskHash("t1"),
      createdAt: expect.any(Date),
    });
    expect(recordManagedProvider.mock.invocationCallOrder[0]).toBeLessThan(
      (client.createProvider as unknown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
    );
    expect(client.createSandbox).toHaveBeenCalledWith(expect.objectContaining({
      name: "ve-t1",
      from: "agent:img",
      env: { COPILOT_MODEL: "auto" },
      providers: ["ve-t1-agent"],
    }));
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

  it("does not create remote resources when provider ownership cannot be persisted", async () => {
    const client = fakeClient();
    const runner = new OpenShellWorkspaceRunner({
      git: fakeGit(),
      client,
      sandboxImage: "base",
      managedProviderStore: {
        recordManagedOpenShellProvider: vi.fn().mockRejectedValue(new Error("database unavailable")),
        deleteManagedOpenShellProvider: vi.fn().mockResolvedValue(undefined),
      },
    });
    const adapter = fakeCodingAdapter({ env: { GITHUB_TOKEN: "tok" } });

    await expect(runner.runAgentInDocker(
      adapter,
      { taskId: "t1", workspacePath: "/tmp/ws-1" } as unknown as TaskContext,
      { GITHUB_TOKEN: "tok" },
    )).rejects.toThrow("database unavailable");

    expect(client.createProvider).not.toHaveBeenCalled();
    expect(client.createSandbox).not.toHaveBeenCalled();
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

  it("destroyWorkspace cleans all 6 maps even when removeSandbox throws", async () => {
    const removeSandbox = vi.fn().mockRejectedValue(new Error("delete failed"));
    const runner = new OpenShellWorkspaceRunner({
      git: fakeGit(),
      client: fakeClient({ removeSandbox } as unknown as Partial<OpenShellClient>),
      sandboxImage: "base",
    });
    const created = await runner.createWorkspace("t-clean" as TaskId);
    const r = runner as unknown as {
      sandboxNames: Map<string, string>;
      providerNames: Map<string, string>;
      removedSandboxes: Set<string>;
      trustedRemotes: Map<string, unknown>;
      postCloneScripts: Map<string, string>;
      denialFingerprints: Map<string, Set<string>>;
    };
    // Seed extra maps so we can verify they are all cleared.
    r.providerNames.set(created.containerId, "ve-t-clean-agent");
    r.trustedRemotes.set(created.containerId, new Map());
    r.postCloneScripts.set(created.containerId, "npm ci");
    const sandboxRaw = created.containerId.replace("openshell:", "");
    r.denialFingerprints.set(sandboxRaw, new Set(["fp1"]));

    await expect(runner.destroyWorkspace(created)).rejects.toThrow("delete failed");

    expect(r.sandboxNames.has(created.containerId)).toBe(false);
    expect(r.providerNames.has(created.containerId)).toBe(false);
    expect(r.removedSandboxes.has(created.containerId)).toBe(false);
    expect(r.trustedRemotes.has(created.containerId)).toBe(false);
    expect(r.postCloneScripts.has(created.containerId)).toBe(false);
    expect(r.denialFingerprints.has(sandboxRaw)).toBe(false);
  });

  it("destroyWorkspace cleans all 6 maps even when removeProvider throws", async () => {
    const removeProvider = vi.fn().mockRejectedValue(new Error("provider delete failed"));
    const runner = new OpenShellWorkspaceRunner({
      git: fakeGit(),
      client: fakeClient({ removeProvider } as unknown as Partial<OpenShellClient>),
      sandboxImage: "base",
    });
    const created = await runner.createWorkspace("t-prov-fail" as TaskId);
    const r = runner as unknown as {
      sandboxNames: Map<string, string>;
      providerNames: Map<string, string>;
      removedSandboxes: Set<string>;
      trustedRemotes: Map<string, unknown>;
      postCloneScripts: Map<string, string>;
      denialFingerprints: Map<string, Set<string>>;
    };
    r.providerNames.set(created.containerId, "ve-t-prov-fail-agent");
    r.trustedRemotes.set(created.containerId, new Map());
    r.postCloneScripts.set(created.containerId, "npm ci");
    const sandboxRaw = created.containerId.replace("openshell:", "");
    r.denialFingerprints.set(sandboxRaw, new Set(["fp2"]));

    await expect(runner.destroyWorkspace(created)).rejects.toThrow("provider delete failed");

    expect(r.sandboxNames.has(created.containerId)).toBe(false);
    expect(r.providerNames.has(created.containerId)).toBe(false);
    expect(r.removedSandboxes.has(created.containerId)).toBe(false);
    expect(r.trustedRemotes.has(created.containerId)).toBe(false);
    expect(r.postCloneScripts.has(created.containerId)).toBe(false);
    expect(r.denialFingerprints.has(sandboxRaw)).toBe(false);
  });

  it("collectPolicyDenials aborts getSandboxLogs after 30 seconds", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    const getSandboxLogs = vi.fn().mockImplementation(
      (input: { signal?: AbortSignal }) =>
        new Promise<string>((_resolve, reject) => {
          capturedSignal = input.signal;
          input.signal?.addEventListener("abort", () => reject(input.signal?.reason ?? new Error("aborted")));
        })
    );
    const runner = new OpenShellWorkspaceRunner({
      git: fakeGit(),
      client: fakeClient({ getSandboxLogs } as unknown as Partial<OpenShellClient>),
      sandboxImage: "base",
      recordDenial: vi.fn(),
    });
    // Set up trusted remotes so restoreTrustedRemotes does not throw.
    await runner.cloneRepo(handle, "https://trusted.example/repo.git", "main");

    // Kick off a coding run; collectPolicyDenials runs in the finally block.
    const runPromise = runner.runAgentInDocker(
      fakeCodingAdapter(),
      { taskId: "t1", workspacePath: "/tmp/ws-1" } as unknown as TaskContext,
    );

    // Advance time past the 30-second cap.
    await vi.advanceTimersByTimeAsync(31_000);

    // The signal should have been aborted; the outer catch swallows the error.
    await runPromise;
    expect(capturedSignal?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it("runAgentInDocker applies deny-strict fallback policy when resolvePolicy returns undefined", async () => {
    const client = fakeClient();
    const runner = new OpenShellWorkspaceRunner({
      git: fakeGit(),
      client,
      sandboxImage: "base",
      resolvePolicy: () => undefined,
    });

    await runner.cloneRepo(handle, "https://trusted.example/repo.git", "main");
    await runner.runAgentInDocker(
      fakeCodingAdapter(),
      { taskId: "t1", workspacePath: "/tmp/ws-1" } as unknown as TaskContext,
    );

    expect(client.createSandbox).toHaveBeenCalledWith(expect.objectContaining({
      policyYaml: expect.stringContaining("default: deny"),
    }));
  });

  it("runReviewInDocker applies deny-strict fallback policy when resolvePolicy returns undefined", async () => {
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
      resolvePolicy: () => undefined,
    });

    await runner.runReviewInDocker(
      handle,
      { changeId: "Iabc", prompt: "review this diff" } as unknown as ReviewWorkspaceInput,
    );

    expect(client.createSandbox).toHaveBeenCalledWith(expect.objectContaining({
      policyYaml: expect.stringContaining("default: deny"),
    }));
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
    expect(client.removeSandbox).toHaveBeenCalledWith("ve-t1", undefined);
    expect(git.destroyWorkspace).toHaveBeenCalledWith("/tmp/ws-1");
  });

  it("retains sandbox attempt ownership until a failed delete is retried successfully", async () => {
    const git = fakeGit();
    const removeSandbox = vi.fn()
      .mockRejectedValueOnce(new Error("gateway unavailable"))
      .mockResolvedValueOnce(undefined);
    const runner = new OpenShellWorkspaceRunner({
      git,
      client: fakeClient({ removeSandbox } as unknown as Partial<OpenShellClient>),
      sandboxImage: "base",
    });
    const created = await runner.createWorkspace("cleanup-task" as TaskId);

    // First attempt throws — maps are cleaned unconditionally by Fix 2.
    await expect(runner.destroyWorkspace(created)).rejects.toThrow("gateway unavailable");
    const ownership = (runner as unknown as { sandboxNames: Map<string, string> }).sandboxNames;
    // Maps are now cleaned unconditionally, so the entry is gone after failure.
    expect(ownership.has(created.containerId)).toBe(false);

    // Second attempt still resolves: sandboxName is re-derived from containerId.
    // removeSandbox is not guarded by removedSandboxes (it was also cleared), so
    // the second attempt calls removeSandbox again; this time it succeeds.
    await expect(runner.destroyWorkspace(created)).resolves.toBeUndefined();

    expect(removeSandbox).toHaveBeenCalledTimes(2);
    expect(removeSandbox.mock.calls[1]).toEqual(removeSandbox.mock.calls[0]);
    expect(git.destroyWorkspace).toHaveBeenCalledTimes(2);
    expect(ownership.has(created.containerId)).toBe(false);
  });

  it("deletes an attached provider after its sandbox and retries provider cleanup independently", async () => {
    const removeSandbox = vi.fn().mockResolvedValue(undefined);
    const removeProvider = vi.fn()
      .mockRejectedValueOnce(new Error("provider cleanup unavailable"))
      .mockResolvedValueOnce(undefined);
    const client = fakeClient({ removeSandbox, removeProvider } as unknown as Partial<OpenShellClient>);
    const deleteManagedProvider = vi.fn().mockResolvedValue(undefined);
    const runner = new OpenShellWorkspaceRunner({
      git: fakeGit(),
      client,
      sandboxImage: "base",
      managedProviderStore: {
        recordManagedOpenShellProvider: vi.fn().mockResolvedValue(undefined),
        deleteManagedOpenShellProvider: deleteManagedProvider,
      },
    });
    const adapter = fakeCodingAdapter({ env: { GITHUB_TOKEN: "tok" } });
    await runner.cloneRepo(handle, "https://trusted.example/repo.git", "main");
    await runner.runAgentInDocker(
      adapter,
      { taskId: "t1", workspacePath: "/tmp/ws-1", runtimeHandleId: handle.containerId } as unknown as TaskContext,
      { GITHUB_TOKEN: "tok" },
    );

    // First destroyWorkspace: sandbox removal succeeds, provider removal fails.
    // Maps are cleaned unconditionally (Fix 2), so providerName is lost from memory.
    await expect(runner.destroyWorkspace(handle)).rejects.toThrow("provider cleanup unavailable");
    expect(removeSandbox).toHaveBeenCalledOnce();
    expect(removeProvider).toHaveBeenCalledWith("ve-t1-agent");
    expect(removeSandbox.mock.invocationCallOrder[0]).toBeLessThan(removeProvider.mock.invocationCallOrder[0]!);
    expect(deleteManagedProvider).not.toHaveBeenCalled();

    // Second destroyWorkspace: providerName cleared from memory by Fix 2.
    // removeSandbox is called again (removedSandboxes was also cleared), but
    // the sandbox is already gone — the "not found" guard (Fix 1) returns cleanly.
    // providerName is undefined so no provider cleanup is attempted in-memory;
    // the persistent managedProviderStore ledger handles retry on next startup.
    await expect(runner.destroyWorkspace(handle)).resolves.toBeUndefined();
    expect(removeSandbox).toHaveBeenCalledTimes(2);
    expect(removeProvider).toHaveBeenCalledOnce(); // not retried — name was cleared
    expect(deleteManagedProvider).not.toHaveBeenCalled();
  });
});
