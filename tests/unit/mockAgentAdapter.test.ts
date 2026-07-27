import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MockAgentAdapter } from "../../src/agents/mockAgentAdapter.js";
import { mkdir, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { makeTaskId, makeExternalChangeId } from "../../src/interfaces.js";
import type { TaskContext } from "../../src/interfaces.js";

function makeContext(workspacePath: string): TaskContext {
  return {
    taskId: makeTaskId(randomUUID()),
    ticketTitle: "Add logging to user service",
    ticketDescription: "Add structured logging to the user service module",
    acceptanceCriteria: ["Logs should be in JSON format"],
    baseBranch: "main",
    workspacePath,
    volumeName: "ve-ws-test-mock",
    homeVolumeName: "ve-home-test-mock",
    constraints: [],
    priorFeedback: [],
    cycleNumber: 1,
    commitMessage: "Add structured logging to user service",
    ticketUrl: "http://localhost:3000/issues/123",
    agentSession: {
      agentContainerImage: "virtual-engineer-workspace:latest",
      repoCloneUrl: "ssh://localhost:29418/demo-project",
      pushRef: "refs/for/main",
      gitAuthorName: "Virtual Engineer",
      gitAuthorEmail: "virtual-engineer@localhost",
    },
  };
}

describe("MockAgentAdapter", () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = join(tmpdir(), `ve-mock-test-${randomUUID()}`);
    await mkdir(workspacePath, { recursive: true });
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  it("returns success and writes default MOCK_CHANGE.txt", async () => {
    const adapter = new MockAgentAdapter();
    const context = makeContext(workspacePath);
    const result = await adapter.execute(context);

    expect(result.status).toBe("success");
    expect(result.modifiedFiles).toContain("MOCK_CHANGE.txt");
    expect(result.summary).toBeTruthy();
    await expect(readFile(join(workspacePath, "MOCK_CHANGE.txt"), "utf8")).resolves.toContain("Task:");
  });

  it("returns no_change when configured", async () => {
    const adapter = new MockAgentAdapter({ status: "no_change" });
    const result = await adapter.execute(makeContext(workspacePath));
    expect(result.status).toBe("no_change");
    expect(result.modifiedFiles).toHaveLength(0);
  });

  it("returns failed when configured", async () => {
    const adapter = new MockAgentAdapter({ status: "failed" });
    const result = await adapter.execute(makeContext(workspacePath));
    expect(result.status).toBe("failed");
  });

  it("writes custom files to workspace", async () => {
    const adapter = new MockAgentAdapter({
      filesToWrite: {
        "src/hello.ts": "export const hello = () => 'world';",
      },
    });

    const result = await adapter.execute(makeContext(workspacePath));
    expect(result.modifiedFiles).toContain("src/hello.ts");
    await expect(readFile(join(workspacePath, "src/hello.ts"), "utf8")).resolves.toContain("hello");
  });

  it("includes cycle number in agent logs", async () => {
    const adapter = new MockAgentAdapter();
    const context = makeContext(workspacePath);
    context.cycleNumber = 3;
    const result = await adapter.execute(context);
    expect(result.agentLogs).toContain("3");
  });

  it("adapter name is 'mock'", () => {
    expect(new MockAgentAdapter().name).toBe("mock");
  });

  it("builds a minimal container spec for future isolated runner integration", () => {
    const adapter = new MockAgentAdapter();
    const spec = adapter.buildContainerSpec(makeContext(workspacePath));

    expect(spec.image).toBe("virtual-engineer-workspace:latest");
    expect(spec.command).toEqual(["node", "/agent-worker/dist/index.js"]);
    expect(spec.env).toEqual({});
    expect(spec.additionalDockerArgs).toEqual([]);
  });

  it("honors simulateDelayMs before resolving", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new MockAgentAdapter({ simulateDelayMs: 50 });
      const pending = adapter.execute(makeContext(workspacePath));

      let settled = false;
      pending.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(49);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(settled).toBe(true);
      expect(result.status).toBe("success");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reuses an existing Change-Id in the synthetic result", async () => {
    const existingChangeId = makeExternalChangeId("Iexistingchange1234");
    const context = makeContext(workspacePath);
    context.agentSession.existingChangeId = existingChangeId;
    const adapter = new MockAgentAdapter({
      filesToWrite: { "src/mock.ts": "export const value = 1;" },
    });
    const result = await adapter.execute(context);

    expect(result.status).toBe("success");
    expect(result.externalChangeId).toBe(existingChangeId);
    expect(result.modifiedFiles).toEqual(["src/mock.ts"]);
  });

  it("writes directly into the mounted workspace root", async () => {
    const adapter = new MockAgentAdapter({
      filesToWrite: { "src/direct-write.ts": "export const direct = true;" },
    });

    const result = await adapter.execute(makeContext(workspacePath));

    expect(result.modifiedFiles).toContain("src/direct-write.ts");
    await expect(readFile(join(workspacePath, "src/direct-write.ts"), "utf8")).resolves.toContain("direct");
    await expect(readFile(join(workspacePath, "repo", "src/direct-write.ts"), "utf8")).rejects.toThrow();
  });
});
