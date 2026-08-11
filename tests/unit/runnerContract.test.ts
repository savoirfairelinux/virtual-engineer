import { describe, it, expect, vi } from "vitest";
import {
  OpenShellWorkspaceRunner as ProductionOpenShellWorkspaceRunner,
  type OpenShellRunnerDeps,
} from "../../src/workspace/openShellWorkspaceRunner.js";
import { HostGitExecutor } from "../../src/workspace/hostGitExecutor.js";
import type { OpenShellClient } from "../../src/openshell/openShellClient.js";
import type { AgentAdapter, ReviewWorkspaceInput, TaskContext, TaskId, WorkspaceHandle } from "../../src/interfaces.js";

function fakeClient(spy: {
  createSandbox: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
  createProvider?: ReturnType<typeof vi.fn>;
}): OpenShellClient {
  return {
    createSandbox: spy.createSandbox,
    createProvider: spy.createProvider ?? vi.fn().mockResolvedValue(undefined),
    removeProvider: vi.fn().mockResolvedValue(undefined),
    uploadToSandbox: vi.fn().mockResolvedValue(undefined),
    downloadFromSandbox: vi.fn().mockResolvedValue(undefined),
    execInSandbox: spy.exec,
    removeSandbox: vi.fn().mockResolvedValue(undefined),
    gatewayHealthy: vi.fn().mockResolvedValue(true),
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

describe("Security — push credentials never reach the OpenShell sandbox", () => {
  const handle: WorkspaceHandle = {
    taskId: "t1" as TaskId,
    containerId: "openshell:t1",
    hostWorkspacePath: "/tmp/ws",
  };

  function collectStrings(value: unknown, acc: string[]): void {
    if (typeof value === "string") acc.push(value);
    else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, acc));
    else if (value && typeof value === "object") Object.values(value).forEach((v) => collectStrings(v, acc));
  }

  it("review run does not pass agentToken/push secrets to createSandbox or exec", async () => {
    const createSandbox = vi.fn().mockResolvedValue(undefined);
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ status: "success", rawOutput: "ok" }),
      stderr: "",
    });
    const SECRET = "ghp_supersecretpushtoken0123456789";
    // Review adapter spec never includes the push/review-system token.
    const reviewAdapter = {
      name: "copilot",
      buildReviewContainerSpec: vi.fn().mockReturnValue({
        image: "img",
        env: { REVIEW_MODE: "1" },
        command: ["node", "/agent-worker/dist/index.js"],
      }),
    } as unknown as AgentAdapter;
    const runner = new OpenShellWorkspaceRunner({
      git: new HostGitExecutor({ baseDir: "/tmp", git: vi.fn().mockResolvedValue("") }),
      client: fakeClient({ createSandbox, exec }),
      agentAdapter: reviewAdapter,
    });

    const input = {
      changeId: "Iabc",
      revisionNumber: 1,
      patchset: 1,
      repositoryName: "repo",
      prompt: "review this",
      systemPrompt: "you are a reviewer",
      agentToken: SECRET,
    } as unknown as ReviewWorkspaceInput;

    await runner.runReviewInDocker(handle, input);

    // Assert the secret never appears in any argument passed to the sandbox.
    const args: string[] = [];
    createSandbox.mock.calls.forEach((c) => collectStrings(c, args));
    exec.mock.calls.forEach((c) => collectStrings(c, args));
    expect(args.some((a) => a.includes(SECRET))).toBe(false);
  });

  it("agent run isolates inference credentials from sandbox and push secrets", async () => {
    const createSandbox = vi.fn().mockResolvedValue(undefined);
    const createProvider = vi.fn().mockResolvedValue(undefined);
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const git = new HostGitExecutor({ baseDir: "/tmp", git: vi.fn().mockResolvedValue("") });
    vi.spyOn(git, "rebuildTrustedMetadata").mockResolvedValue(undefined);
    const runner = new OpenShellWorkspaceRunner({
      git,
      client: fakeClient({ createSandbox, exec, createProvider }),
    });
    const ctx = { taskId: "t1", workspacePath: "/tmp/ws" } as unknown as TaskContext;
    const PUSH_SECRET = "GERRIT_HTTP_PASSWORD_value";
    // The adapter spec carries the agent's inference token, never push/review-system
    // credentials (those stay host-side in src/vcs). The runner extracts supported
    // agent credentials into an attached provider before sandbox creation.
    const adapter = {
      name: "copilot",
      buildContainerSpecWithPrompts: vi.fn().mockResolvedValue({
        image: "img",
        env: { GITHUB_TOKEN: "agent-inference-tok" },
        command: ["node", "/agent-worker/dist/index.js"],
      }),
    } as unknown as AgentAdapter;
    // Host-side clone URLs carry push credentials; they must stay on the host.
    await runner.cloneRepo(handle, `https://ve:${PUSH_SECRET}@trusted.example/repo.git`, "main");
    await runner.runAgentInDocker(adapter, ctx, {});

    const args: string[] = [];
    createSandbox.mock.calls.forEach((c) => collectStrings(c, args));
    exec.mock.calls.forEach((c) => collectStrings(c, args));
    // Neither secret reaches sandbox create/exec arguments. The inference credential
    // is supplied only to provider creation's child-specific environment.
    expect(args.some((a) => a.includes(PUSH_SECRET))).toBe(false);
    expect(args.some((a) => a.includes("agent-inference-tok"))).toBe(false);
    expect(createProvider).toHaveBeenCalledWith(expect.objectContaining({
      credentials: { GITHUB_TOKEN: "agent-inference-tok" },
    }));
  });
});
