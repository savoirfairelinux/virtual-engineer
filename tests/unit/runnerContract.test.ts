import { describe, it, expect, vi } from "vitest";
import { OpenShellWorkspaceRunner } from "../../src/workspace/openShellWorkspaceRunner.js";
import { HostGitExecutor } from "../../src/workspace/hostGitExecutor.js";
import type { OpenShellClient } from "../../src/openshell/openShellClient.js";
import type { AgentAdapter, ReviewWorkspaceInput, TaskContext, TaskId, WorkspaceHandle, WorkspaceRunner } from "../../src/interfaces.js";

/** Methods every WorkspaceRunner must implement (required by the interface). */
const REQUIRED_METHODS: (keyof WorkspaceRunner)[] = [
  "createWorkspace",
  "cloneRepo",
  "runAgent",
  "destroyWorkspace",
];

function fakeClient(spy: { createSandbox: ReturnType<typeof vi.fn>; exec: ReturnType<typeof vi.fn> }): OpenShellClient {
  return {
    createSandbox: spy.createSandbox,
    uploadToSandbox: vi.fn().mockResolvedValue(undefined),
    downloadFromSandbox: vi.fn().mockResolvedValue(undefined),
    execInSandbox: spy.exec,
    setPolicy: vi.fn().mockResolvedValue(undefined),
    removeSandbox: vi.fn().mockResolvedValue(undefined),
    gatewayHealthy: vi.fn().mockResolvedValue(true),
  } as unknown as OpenShellClient;
}

describe("WorkspaceRunner contract — openshell (sole runtime)", () => {
  const openShellRunner = new OpenShellWorkspaceRunner({
    git: new HostGitExecutor({ baseDir: "/tmp" }),
    client: fakeClient({ createSandbox: vi.fn(), exec: vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" }) }),
    sandboxImage: "img",
  });

  for (const method of REQUIRED_METHODS) {
    it(`openshell runner implements ${method}`, () => {
      expect(typeof (openShellRunner as unknown as Record<string, unknown>)[method]).toBe("function");
    });
  }
});

describe("Security — push credentials never reach the OpenShell sandbox", () => {
  const handle: WorkspaceHandle = {
    taskId: "t1" as TaskId,
    containerId: "openshell:t1",
    volumeName: "/tmp/ws",
    homeVolumeName: "/tmp/ws",
    hostWorkspacePath: "/tmp/ws",
    containerImage: "img",
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
      sandboxImage: "img",
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

  it("agent run forwards the adapter spec env but not push/review-system secrets", async () => {
    const createSandbox = vi.fn().mockResolvedValue(undefined);
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const runner = new OpenShellWorkspaceRunner({
      git: new HostGitExecutor({ baseDir: "/tmp", git: vi.fn().mockResolvedValue("") }),
      client: fakeClient({ createSandbox, exec }),
      sandboxImage: "img",
    });
    const ctx = { taskId: "t1", workspacePath: "/tmp/ws" } as unknown as TaskContext;
    const PUSH_SECRET = "GERRIT_HTTP_PASSWORD_value";
    // The adapter spec is the ONLY source of sandbox env: it carries the agent's own
    // inference token, never push/review-system credentials (those stay host-side in src/vcs).
    const adapter = {
      name: "copilot",
      buildContainerSpecWithPrompts: vi.fn().mockResolvedValue({
        image: "img",
        env: { GITHUB_TOKEN: "agent-inference-tok" },
        command: ["node", "/agent-worker/dist/index.js"],
      }),
    } as unknown as AgentAdapter;
    await runner.runAgentInDocker(adapter, ctx, {});

    const args: string[] = [];
    createSandbox.mock.calls.forEach((c) => collectStrings(c, args));
    exec.mock.calls.forEach((c) => collectStrings(c, args));
    // Push credential never appears; the agent's own inference token is forwarded.
    expect(args.some((a) => a.includes(PUSH_SECRET))).toBe(false);
    expect(args.some((a) => a.includes("agent-inference-tok"))).toBe(true);
  });
});
