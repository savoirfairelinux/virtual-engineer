import { describe, expect, it, vi } from "vitest";
import type { AgentAdapter, ReviewWorkspaceInput, TaskId, WorkspaceHandle } from "../../src/interfaces.js";

const mocks = vi.hoisted(() => ({
  execInVolume: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../../src/workspace/dockerVolume.js", () => ({
  createVolume: vi.fn(),
  execInVolume: mocks.execInVolume,
  removeVolume: vi.fn(),
  stopContainersUsingVolume: vi.fn(),
}));

import { DockerWorkspaceRunner } from "../../src/workspace/workspaceRunner.js";

describe("DockerWorkspaceRunner", () => {
  it("passes the uploaded review prompt path to the review container", async () => {
    mocks.execInVolume.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    const stdout = { on: vi.fn() };
    const stderr = { on: vi.fn() };
    const child = {
      stdout,
      stderr,
      on: vi.fn(),
    };
    stdout.on.mockImplementation((event: string, callback: (chunk: string) => void) => {
      if (event === "data") callback(JSON.stringify({ status: "success", rawOutput: "ok" }));
      return stdout;
    });
    child.on.mockImplementation((event: string, callback: () => void) => {
      if (event === "close") queueMicrotask(callback);
      return child;
    });
    mocks.spawn.mockReturnValue(child);

    const runner = new DockerWorkspaceRunner({ agentContainerImage: "helper:latest", agentTimeoutMs: 30_000 });
    const handle: WorkspaceHandle = {
      taskId: "task-1" as TaskId,
      containerId: "",
      hostWorkspacePath: "/workspace",
      volumeName: "ve-ws-task-1",
      homeVolumeName: "ve-home-task-1",
    };
    const adapter = {
      name: "copilot",
      buildReviewContainerSpec: vi.fn(() => ({
        image: "agent:latest",
        env: { REVIEW_MODE: "1" },
        command: ["node", "/agent-worker/dist/index.js"],
      })),
    } as unknown as AgentAdapter;
    const input = {
      reviewStrategy: "ve_direct",
      changeId: "Iabc",
      revisionNumber: 1,
      patchset: 1,
      repositoryName: "repo",
      prompt: "Review this diff",
      systemPrompt: "Review safely",
      agentToken: "token",
      agentAdapter: adapter,
    } as unknown as ReviewWorkspaceInput;

    await expect(runner.runReviewInDocker(handle, input)).resolves.toEqual({ rawOutput: "ok" });

    const dockerArgs = mocks.spawn.mock.calls[0]?.[1] as string[];
    expect(dockerArgs).toContain("USER_PROMPT_FILE=/ve-home/user-prompt.txt");
  });
});
