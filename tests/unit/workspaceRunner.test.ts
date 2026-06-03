import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("child_process", () => {
  const spawn = vi.fn();
  return { spawn };
});

vi.mock("../../src/workspace/dockerVolume.js", () => ({
  createVolume: vi.fn().mockResolvedValue(undefined),
  removeVolume: vi.fn().mockResolvedValue(undefined),
  execInVolume: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
  stopContainersUsingVolume: vi.fn().mockResolvedValue(undefined),
  listVolumesByLabel: vi.fn().mockResolvedValue([]),
}));

import { spawn } from "child_process";
import { createVolume, removeVolume, execInVolume, stopContainersUsingVolume, listVolumesByLabel } from "../../src/workspace/dockerVolume.js";
import { DockerWorkspaceRunner } from "../../src/workspace/workspaceRunner.js";
import { makeTaskId, makeProjectId, makeExternalChangeId } from "../../src/interfaces.js";
import type { AgentAdapter, AgentResult, TaskContext } from "../../src/interfaces.js";

const mockSpawn = vi.mocked(spawn);
const mockCreateVolume = vi.mocked(createVolume);
const mockRemoveVolume = vi.mocked(removeVolume);
const mockExecInVolume = vi.mocked(execInVolume);
const mockStopContainersUsingVolume = vi.mocked(stopContainersUsingVolume);
const mockListVolumesByLabel = vi.mocked(listVolumesByLabel);

type MockChildProcess = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

type DockerRunner = DockerWorkspaceRunner & {
  runAgentInDocker(
    adapter: AgentAdapter,
    context: TaskContext,
    authEnv?: Record<string, string>,
    callbacks?: {
      onStdoutChunk?: (chunk: string) => void;
      onStderrChunk?: (chunk: string) => void;
    }
  ): Promise<{ stdout: string; stderr: string }>;
};

function asDockerRunner(runner: DockerWorkspaceRunner): DockerRunner {
  return runner as unknown as DockerRunner;
}

function createMockChildProcess(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

function mockSpawnWith(configure: (child: MockChildProcess) => void): void {
  mockSpawn.mockImplementation(((..._args: unknown[]) => {
    const child = createMockChildProcess();
    configure(child);
    return child as unknown as ReturnType<typeof spawn>;
  }) as typeof spawn);
}

function getSpawnCall(): { command: string; args: readonly string[] } {
  const call = mockSpawn.mock.calls[0];
  if (!call) {
    throw new Error("Expected spawn to be called");
  }

  return {
    command: call[0],
    args: call[1] ?? [],
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAgentAdapter(result?: Partial<AgentResult>): AgentAdapter {
  const defaultResult: AgentResult = {
    status: "success",
    modifiedFiles: [],
    commitSha: "abc123",
    externalChangeId: makeExternalChangeId("repo~master~Iabc123"),
    summary: "Done",
    agentLogs: "",
    metadata: {},
  };
  return {
    name: "mock",
    buildContainerSpec: vi.fn().mockReturnValue({
      image: "virtual-engineer-workspace:latest",
      env: {},
      command: ["node", "/agent-worker/index.js"],
    }),
    execute: vi.fn().mockResolvedValue({ ...defaultResult, ...result }),
  } as unknown as AgentAdapter;
}

function makeContext(overrides?: Partial<TaskContext>): TaskContext {
  return {
    taskId: makeTaskId("task-1"),
    ticketTitle: "Test subject",
    ticketDescription: "Description",
    acceptanceCriteria: [],
    baseBranch: "main",
    workspacePath: "/workspace",
    volumeName: "ve-ws-task-1-abcd1234",
    homeVolumeName: "ve-home-task-1-abcd1234",
    constraints: [],
    priorFeedback: [],
    cycleNumber: 1,
    commitMessage: "Test commit",
    agentSession: {
      gitAuthorName: "Test Agent",
      gitAuthorEmail: "agent@test.com",
      agentContainerImage: "virtual-engineer-workspace:latest",
      githubToken: undefined,
      existingChangeId: undefined,
    },
    ...overrides,
  } as TaskContext;
}

function makeRunner(adapter?: AgentAdapter) {
  return new DockerWorkspaceRunner(
    { agentContainerImage: "virtual-engineer-workspace:latest", agentTimeoutMs: 60_000 },
    adapter ?? makeAgentAdapter()
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("DockerWorkspaceRunner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ─── createWorkspace ───────────────────────────────────────────────────────

  describe("createWorkspace", () => {
    it("returns a WorkspaceHandle with volume names", async () => {
      const runner = makeRunner();
      const handle = await runner.createWorkspace(makeTaskId("task-1"));

      expect(handle.taskId).toBe("task-1");
      expect(handle.volumeName).toMatch(/^ve-ws-task-1-/);
      expect(handle.homeVolumeName).toMatch(/^ve-home-task-1-/);
      expect(handle.hostWorkspacePath).toBe("/workspace");
    });

    it("creates both workspace and home volumes", async () => {
      const runner = makeRunner();
      await runner.createWorkspace(makeTaskId("task-42"));

      expect(mockCreateVolume).toHaveBeenCalledTimes(2);
      const calls = mockCreateVolume.mock.calls.map((c) => c[0]);
      expect(calls[0]).toMatch(/^ve-ws-task-42-/);
      expect(calls[1]).toMatch(/^ve-home-task-42-/);
    });

    it("uses a deterministic persistent home volume when a project is given", async () => {
      const runner = makeRunner();
      const project = { id: makeProjectId("proj-1"), homeCacheSeed: "seed-abc" };

      const first = await runner.createWorkspace(makeTaskId("task-a"), project);
      const second = await runner.createWorkspace(makeTaskId("task-b"), project);

      expect(first.persistentHomeVolume).toBe(true);
      expect(first.homeVolumeName).toMatch(/^ve-home-project-v2-[0-9a-f]{16}$/);
      expect(second.homeVolumeName).toBe(first.homeVolumeName);
    });

    it("derives a different home volume name when the cache seed changes", async () => {
      const runner = makeRunner();
      const a = await runner.createWorkspace(makeTaskId("task-a"), {
        id: makeProjectId("proj-1"),
        homeCacheSeed: "seed-1",
      });
      const b = await runner.createWorkspace(makeTaskId("task-b"), {
        id: makeProjectId("proj-1"),
        homeCacheSeed: "seed-2",
      });

      expect(b.homeVolumeName).not.toBe(a.homeVolumeName);
    });

    it("labels the persistent home volume for orphan reconciliation", async () => {
      const runner = makeRunner();
      await runner.createWorkspace(makeTaskId("task-a"), {
        id: makeProjectId("proj-1"),
        homeCacheSeed: "seed-abc",
      });

      const homeCall = mockCreateVolume.mock.calls[1];
      expect(homeCall?.[1]).toMatchObject({
        labels: {
          "ve.owner": "virtual-engineer",
          "ve.kind": "project-home",
          "ve.project-id": "proj-1",
          "ve.cache-seed": "seed-abc",
        },
      });
    });

    it("leaves no persistentHomeVolume flag when no project is given", async () => {
      const runner = makeRunner();
      const handle = await runner.createWorkspace(makeTaskId("task-1"));
      expect(handle.persistentHomeVolume).toBeUndefined();
    });
  });

  // ─── runAgent ─────────────────────────────────────────────────────────────

  describe("runAgent", () => {
    it("uses an updated agent adapter for subsequent runs", async () => {
      const initialAdapter = makeAgentAdapter({ commitSha: "sha-initial" });
      const updatedAdapter = makeAgentAdapter({ commitSha: "sha-updated" });
      const runner = makeRunner(initialAdapter);

      const handle = await runner.createWorkspace(makeTaskId("task-1"));
      await runner.runAgent(handle, makeContext());

      runner.updateRuntime({ agentAdapter: updatedAdapter });
      const result = await runner.runAgent(handle, makeContext({ cycleNumber: 2 }));

      expect(initialAdapter.execute).toHaveBeenCalledTimes(1);
      expect(updatedAdapter.execute).toHaveBeenCalledTimes(1);
      expect(result.commitSha).toBe("sha-updated");
    });

    it("delegates execution to the agentAdapter", async () => {
      const adapter = makeAgentAdapter({ commitSha: "sha-xyz" });
      const runner = makeRunner(adapter);

      const handle = await runner.createWorkspace(makeTaskId("task-1"));
      const result = await runner.runAgent(handle, makeContext());

      expect(adapter.execute).toHaveBeenCalledOnce();
      expect(result.status).toBe("success");
      expect(result.commitSha).toBe("sha-xyz");
    });

    it("forwards the TaskContext to the adapter", async () => {
      const adapter = makeAgentAdapter();
      const runner = makeRunner(adapter);
      const handle = await runner.createWorkspace(makeTaskId("task-1"));
      const ctx = makeContext({ cycleNumber: 2 });

      await runner.runAgent(handle, ctx);

      const [passedCtx] = (adapter.execute as ReturnType<typeof vi.fn>).mock.calls[0] as [TaskContext];
      expect(passedCtx.cycleNumber).toBe(2);
    });

    it("propagates adapter rejection", async () => {
      const adapter = makeAgentAdapter();
      (adapter.execute as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Docker failed"));
      const runner = makeRunner(adapter);

      const handle = await runner.createWorkspace(makeTaskId("task-1"));
      await expect(runner.runAgent(handle, makeContext())).rejects.toThrow("Docker failed");
    });
  });

  // ─── runAgentInDocker ──────────────────────────────────────────────────────

  describe("runAgentInDocker", () => {
    it("calls adapter.buildContainerSpec with context and authEnv", async () => {
      const adapter = makeAgentAdapter();
      const runner = makeRunner(adapter);
      const ctx = makeContext();
      const authEnv = { GITHUB_TOKEN: "token-xyz" };

      mockSpawnWith((child) => {
        process.nextTick(() => child.emit("close", 0));
      });

      await asDockerRunner(runner).runAgentInDocker(adapter, ctx, authEnv);

      expect(adapter.buildContainerSpec).toHaveBeenCalledWith(ctx, authEnv);
    });

    it("executes docker run with named volume mounts", async () => {
      const adapter = makeAgentAdapter();
      const runner = makeRunner(adapter);
      const ctx = makeContext();

      mockSpawnWith((child) => {
        process.nextTick(() => child.emit("close", 0));
      });

      await asDockerRunner(runner).runAgentInDocker(adapter, ctx, {});

      expect(mockSpawn).toHaveBeenCalled();
      const { command, args } = getSpawnCall();
      expect(command).toBe("docker");
      const argsArray = [...args];
      expect(argsArray[0]).toBe("run");
      expect(argsArray[1]).toBe("--rm");
      // Should include named volume mount for workspace
      expect(argsArray.join(" ")).toContain("ve-ws-task-1-abcd1234:/workspace");
      // Should include named volume mount for home
      expect(argsArray.join(" ")).toContain("ve-home-task-1-abcd1234:/ve-home");
    });

    it("includes environment variables from spec in docker args", async () => {
      const adapter = makeAgentAdapter();
      (adapter.buildContainerSpec as ReturnType<typeof vi.fn>).mockReturnValue({
        image: "my-image:latest",
        env: { COPILOT_MODEL: "gpt-4", GIT_AUTHOR_NAME: "Agent" },
        command: ["node", "/worker/index.js"],
        networkMode: "virtual-engineer_ve-agent-net",
        additionalDockerArgs: [],
      });
      const runner = makeRunner(adapter);
      const ctx = makeContext();

      mockSpawnWith((child) => {
        process.nextTick(() => child.emit("close", 0));
      });

      await asDockerRunner(runner).runAgentInDocker(adapter, ctx, {});

      const { args } = getSpawnCall();
      const argsArray = [...args].join(" ");
      expect(argsArray).toMatch(/-e\s+COPILOT_MODEL=gpt-4/);
      expect(argsArray).toMatch(/-e\s+GIT_AUTHOR_NAME=Agent/);
    });

    it("includes network mode from spec", async () => {
      const adapter = makeAgentAdapter();
      (adapter.buildContainerSpec as ReturnType<typeof vi.fn>).mockReturnValue({
        image: "my-image:latest",
        env: {},
        command: ["node", "/worker/index.js"],
        networkMode: "virtual-engineer_ve-agent-net",
        additionalDockerArgs: [],
      });
      const runner = makeRunner(adapter);
      const ctx = makeContext();

      mockSpawnWith((child) => {
        process.nextTick(() => child.emit("close", 0));
      });

      await asDockerRunner(runner).runAgentInDocker(adapter, ctx, {});

      const { args } = getSpawnCall();
      const argsArray = [...args];
      expect(argsArray).toContain("--network");
      const networkIndex = argsArray.indexOf("--network");
      expect(argsArray[networkIndex + 1]).toBe("virtual-engineer_ve-agent-net");
    });

    it("includes additional docker args from spec", async () => {
      const adapter = makeAgentAdapter();
      (adapter.buildContainerSpec as ReturnType<typeof vi.fn>).mockReturnValue({
        image: "my-image:latest",
        env: {},
        command: ["node", "/worker/index.js"],
        networkMode: "virtual-engineer_ve-agent-net",
        additionalDockerArgs: ["--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true"],
      });
      const runner = makeRunner(adapter);
      const ctx = makeContext();

      mockSpawnWith((child) => {
        process.nextTick(() => child.emit("close", 0));
      });

      await asDockerRunner(runner).runAgentInDocker(adapter, ctx, {});

      const { args } = getSpawnCall();
      const argsArray = [...args];
      expect(argsArray).toContain("--read-only");
      expect(argsArray).toContain("--cap-drop");
      expect(argsArray).toContain("ALL");
      expect(argsArray).toContain("--security-opt");
      expect(argsArray).toContain("no-new-privileges:true");
    });

    it("includes image and command from spec", async () => {
      const adapter = makeAgentAdapter();
      (adapter.buildContainerSpec as ReturnType<typeof vi.fn>).mockReturnValue({
        image: "my-custom-image:v1",
        env: {},
        command: ["python", "/app/main.py"],
        networkMode: "virtual-engineer_ve-agent-net",
        additionalDockerArgs: [],
      });
      const runner = makeRunner(adapter);
      const ctx = makeContext();

      mockSpawnWith((child) => {
        process.nextTick(() => child.emit("close", 0));
      });

      await asDockerRunner(runner).runAgentInDocker(adapter, ctx, {});

      const { args: dockerArgs } = getSpawnCall();
      expect(dockerArgs).toContain("my-custom-image:v1");
      expect(dockerArgs).toContain("python");
      expect(dockerArgs).toContain("/app/main.py");
    });

    it("returns {stdout, stderr} from docker execution", async () => {
      const adapter = makeAgentAdapter();
      const runner = makeRunner(adapter);
      const ctx = makeContext();

      mockSpawnWith((child) => {
        process.nextTick(() => {
          child.stdout.emit("data", Buffer.from('{"status":"success"}'));
          child.emit("close", 0);
        });
      });

      const result = await asDockerRunner(runner).runAgentInDocker(
        adapter,
        ctx,
        {}
      );

      expect(result).toEqual({
        stdout: '{"status":"success"}',
        stderr: "",
      });
    });

    it("includes stderr in result even if docker fails", async () => {
      const adapter = makeAgentAdapter();
      const runner = makeRunner(adapter);
      const ctx = makeContext();

      mockSpawnWith((child) => {
        process.nextTick(() => {
          child.stdout.emit("data", Buffer.from('{"status":"failed"}'));
          child.stderr.emit("data", Buffer.from("Failed to load image"));
          child.emit("error", new Error("Docker error"));
        });
      });

      const result = await asDockerRunner(runner).runAgentInDocker(
        adapter,
        ctx,
        {}
      );

      expect(result).toEqual({
        stdout: '{"status":"failed"}',
        stderr: "Failed to load image",
      });
    });

    it("forwards stderr chunks to callbacks before the container exits", async () => {
      const adapter = makeAgentAdapter();
      const runner = makeRunner(adapter);
      const ctx = makeContext();
      const chunks: string[] = [];

      mockSpawnWith((child) => {
        process.nextTick(() => {
          child.stderr.emit("data", Buffer.from("first line\n"));
          child.stderr.emit("data", Buffer.from("second line\n"));
          child.emit("close", 0);
        });
      });

      await asDockerRunner(runner).runAgentInDocker(adapter, ctx, {}, {
        onStderrChunk: (chunk) => chunks.push(chunk),
      });

      expect(chunks).toEqual(["first line\n", "second line\n"]);
    });
  });

  // ─── destroyWorkspace ──────────────────────────────────────────────────────

  describe("destroyWorkspace", () => {
    it("removes both workspace and home volumes", async () => {
      const runner = makeRunner();
      const handle = await runner.createWorkspace(makeTaskId("task-1"));
      await runner.destroyWorkspace(handle);

      expect(mockRemoveVolume).toHaveBeenCalledTimes(2);
      expect(mockRemoveVolume).toHaveBeenCalledWith(handle.volumeName);
      expect(mockRemoveVolume).toHaveBeenCalledWith(handle.homeVolumeName);
    });

    it("stops containers using workspace volume before removing it", async () => {
      const callOrder: string[] = [];
      mockStopContainersUsingVolume.mockImplementation(async () => { callOrder.push("stop"); });
      mockRemoveVolume.mockImplementation(async () => { callOrder.push("remove"); });

      const runner = makeRunner();
      const handle = await runner.createWorkspace(makeTaskId("task-1"));
      await runner.destroyWorkspace(handle);

      expect(mockStopContainersUsingVolume).toHaveBeenCalledWith(handle.volumeName);
      expect(callOrder[0]).toBe("stop");
      expect(callOrder[1]).toBe("remove");
    });

    it("does not throw when removeVolume fails (logs warning instead)", async () => {
      mockRemoveVolume.mockRejectedValueOnce(new Error("volume in use"));
      const runner = makeRunner();
      const handle = await runner.createWorkspace(makeTaskId("task-1"));

      await expect(runner.destroyWorkspace(handle)).resolves.not.toThrow();
    });

    it("preserves the persistent home volume", async () => {
      const runner = makeRunner();
      const handle = await runner.createWorkspace(makeTaskId("task-1"), {
        id: makeProjectId("proj-1"),
        homeCacheSeed: "seed-abc",
      });
      await runner.destroyWorkspace(handle);

      expect(mockRemoveVolume).toHaveBeenCalledTimes(1);
      expect(mockRemoveVolume).toHaveBeenCalledWith(handle.volumeName);
      expect(mockRemoveVolume).not.toHaveBeenCalledWith(handle.homeVolumeName);
    });
  });

  // ─── removeProjectHomeCache ────────────────────────────────────────────────

  describe("removeProjectHomeCache", () => {
    it("removes the deterministic per-project home volume", async () => {
      const runner = makeRunner();
      const expected = (
        await runner.createWorkspace(makeTaskId("task-a"), {
          id: makeProjectId("proj-1"),
          homeCacheSeed: "seed-abc",
        })
      ).homeVolumeName;
      mockRemoveVolume.mockReset();
      mockRemoveVolume.mockResolvedValue(undefined);

      await runner.removeProjectHomeCache({ id: makeProjectId("proj-1"), homeCacheSeed: "seed-abc" });

      expect(mockRemoveVolume).toHaveBeenCalledWith(expected);
    });

    it("rejects when removeVolume fails", async () => {
      mockRemoveVolume.mockRejectedValueOnce(new Error("volume in use"));
      const runner = makeRunner();

      await expect(
        runner.removeProjectHomeCache({ id: makeProjectId("proj-1"), homeCacheSeed: "seed-abc" })
      ).rejects.toThrow("volume in use");
    });
  });

  // ─── reconcileProjectHomeCaches ────────────────────────────────────────────

  describe("reconcileProjectHomeCaches", () => {
    it("removes labelled volumes with no matching project and keeps the rest", async () => {
      const runner = makeRunner();
      const keep = (
        await runner.createWorkspace(makeTaskId("task-a"), {
          id: makeProjectId("proj-keep"),
          homeCacheSeed: "seed-keep",
        })
      ).homeVolumeName;
      mockListVolumesByLabel.mockResolvedValueOnce([keep, "ve-home-project-v2-deadbeefdeadbeef"]);
      mockRemoveVolume.mockClear();

      await runner.reconcileProjectHomeCaches([{ id: makeProjectId("proj-keep"), homeCacheSeed: "seed-keep" }]);

      expect(mockRemoveVolume).toHaveBeenCalledTimes(1);
      expect(mockRemoveVolume).toHaveBeenCalledWith("ve-home-project-v2-deadbeefdeadbeef");
      expect(mockRemoveVolume).not.toHaveBeenCalledWith(keep);
    });

    it("does not throw when an orphan volume is still in use", async () => {
      const runner = makeRunner();
      mockListVolumesByLabel.mockResolvedValueOnce(["ve-home-project-v2-deadbeefdeadbeef"]);
      mockRemoveVolume.mockRejectedValueOnce(new Error("volume in use"));

      await expect(runner.reconcileProjectHomeCaches([])).resolves.not.toThrow();
    });
  });

  // ─── cloneRepo ─────────────────────────────────────────────────────────────

  describe("cloneRepo", () => {
    it("uses execInVolume to clone into the workspace volume", async () => {
      const runner = makeRunner();
      const handle = await runner.createWorkspace(makeTaskId("task-1"));

      const result = await runner.cloneRepo(handle, "https://gerrit.example.com/repo", "main");

      expect(mockExecInVolume).toHaveBeenCalledWith(
        expect.objectContaining({
          volumeName: handle.volumeName,
          command: ["git", "clone", "--branch", "main", "--depth", "1", "https://gerrit.example.com/repo", "/workspace"],
        })
      );
      expect(result.success).toBe(true);
      expect(result.localPath).toBe("/workspace");
    });

    it("returns a CloneResult with error details if clone fails", async () => {
      mockExecInVolume.mockResolvedValueOnce({ stdout: "", stderr: "Network error", exitCode: 1 });
      const runner = makeRunner();
      const handle = await runner.createWorkspace(makeTaskId("task-1"));

      const result = await runner.cloneRepo(handle, "https://gerrit.example.com/repo", "main");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Network error");
      expect(result.localPath).toBe("/workspace");
    });
  });
});
