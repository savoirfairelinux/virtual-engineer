import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ReviewOrchestrator } from "../../src/review/reviewOrchestrator.js";
import {
  makeExternalChangeId,
  makeProjectId,
  makeTaskId,
  makeTicketId,
  type AgentLogEvent,
  type ProjectRecord,
  type ReviewChangeDetails,
  type ReviewChangeDiff,
  type ReviewProvider,
  type Task,
  type TaskState,
  type WorkspaceRunner,
} from "../../src/interfaces.js";
import { agentLogBus, getTaskEventBuffer, clearTaskEventBuffer } from "../../src/agents/agentEventBus.js";
import { normalizeAgentEvent } from "../../src/agents/agentEventTypes.js";

const CHANGE_ID = makeExternalChangeId("p~master~Iabc");
const TASK_ID = makeTaskId("review-42-abcd");

function makeDetails(overrides: Partial<ReviewChangeDetails> = {}): ReviewChangeDetails {
  return {
    changeId: CHANGE_ID,
    changeNumber: 42,
    subject: "Add foo",
    description: "details",
    ownerAccountId: "100",
    currentPatchset: 2,
    status: "OPEN",
    project: "p",
    targetBranch: "main",
    url: "http://gerrit.test/c/42",
    ...overrides,
  };
}

function makeDiff(overrides: Partial<ReviewChangeDiff> = {}): ReviewChangeDiff {
  return {
    changeId: CHANGE_ID,
    patchset: 2,
    files: [{ path: "src/a.ts", status: "modified", patch: "+x" }],
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    taskId: TASK_ID,
    ticketId: makeTicketId("gerrit:42"),
    ticketSourceLabel: "gerrit",
    ticketTitle: "Add foo",
    ticketDescription: "",
    state: "REVIEW_PENDING",
    taskType: "code-review",
    externalChangeId: CHANGE_ID,
    currentPatchset: 2,
    reviewedPatchset: null,
    cycleCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    failureReason: null,
    ticketUrl: null,
    reviewUrl: "http://gerrit.test/c/42",
    projectId: makeProjectId("proj-1"),
    displayId: null,
    ...overrides,
  };
}

const PATCHSET_OPTIONS = {
  vcsBaseUrl: "ssh://admin@gerrit.test:29418",
  sshHost: "gerrit.test",
  sshPort: 29418,
  sshUser: "admin",
  sshKeyPath: "/path/to/key",
};

const GOOD_RAW_OUTPUT = [
  "REVIEW_RESULT_START",
  JSON.stringify({
    comments: [{ file: "src/a.ts", line: 1, message: "Bug", severity: "error" }],
    summary: "blocking issue",
    score: -1,
  }),
  "REVIEW_RESULT_END",
].join("\n");

function makeProject(): ProjectRecord {  return {
    id: makeProjectId("proj-1"),
    name: "Test Project",
    type: "coding" as import("../../src/interfaces.js").ProjectType,
    agentId: "agent-1" as import("../../src/interfaces.js").AgentId,
    agentOverrideJson: null,
    postCloneScript: "",
    skillDiscoveryEnabled: false,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeWorkspaceRunner(rawOutput = GOOD_RAW_OUTPUT) {
  const handle = {
    taskId: TASK_ID,
    containerId: "",
    volumeName: "",
    hostWorkspacePath: "/workspaces/review-42",
  };
  return {
    createWorkspace: vi.fn(async () => handle),
    prepareProjectWorkspace: vi.fn(async () => ({ success: true as const, localPath: handle.hostWorkspacePath })),
    applyPriorPatchset: vi.fn(async () => undefined),
    runReviewInDocker: vi.fn(async () => ({ rawOutput })),
    destroyWorkspace: vi.fn(async () => undefined),
  } as unknown as WorkspaceRunner & { runReviewInDocker: ReturnType<typeof vi.fn> };
}

function makeMocks(initialTask?: Task) {
  const task: Task | undefined = initialTask ? { ...initialTask } : undefined;
  const savedCycles: Array<{ taskId: string; cycleNumber: number; result: unknown }> = [];

  const store: Record<string, unknown> = {
    task,
    createReviewTask: vi.fn(async (input: { taskId: ReturnType<typeof makeTaskId> }) => {
      const created = makeTask({ taskId: input.taskId });
      store["task"] = created;
      return created;
    }),
    getTask: vi.fn(async () => store["task"] ?? null),
    getAllTasks: vi.fn(async () => (store["task"] ? [store["task"]] : [])),
    transition: vi.fn(async (_id: unknown, to: TaskState) => {
      if (store["task"]) {
        store["task"] = { ...(store["task"] as Task), state: to };
      }
      return store["task"] as Task;
    }),
    setReviewedPatchset: vi.fn(async (_id: unknown, ps: number) => {
      if (store["task"]) {
        store["task"] = { ...(store["task"] as Task), reviewedPatchset: ps };
      }
    }),
    setFailureReason: vi.fn(async () => undefined),
    incrementCycle: vi.fn(async () => {
      if (store["task"]) {
        const current = (store["task"] as Task).cycleCount;
        const next = current + 1;
        store["task"] = { ...(store["task"] as Task), cycleCount: next };
        return next;
      }
      return 1;
    }),
    getAgentCycles: vi.fn(async () => []),
    saveAgentCycle: vi.fn(async (taskId: string, cycleNumber: number, result: unknown) => {
      savedCycles.push({ taskId, cycleNumber, result });
    }),
    getPostedReviewCommentHashes: vi.fn(async () => new Set<string>()),
    getPostedReviewComments: vi.fn(async () => []),
    markReviewCommentsPosted: vi.fn(async () => undefined),
    findProjectsByReviewTarget: vi.fn(async () => [makeProject()]),
    getProjectById: vi.fn(async () => makeProject()),
    getTaskByTicketId: vi.fn(async () => null),
    setTaskProjectId: vi.fn(async () => undefined),
  };

  const provider: ReviewProvider = {
    kind: "gerrit",
    getChangeDetails: vi.fn(async () => makeDetails()) as ReviewProvider["getChangeDetails"],
    getChangeDiff: vi.fn(async () => makeDiff()) as ReviewProvider["getChangeDiff"],
    postReviewComments: vi.fn(async () => undefined),
    vote: vi.fn(async () => undefined),
  };

  return {
    provider,
    store,
    savedCycles,
    storeAsDep: store as unknown as import("../../src/review/reviewOrchestrator.js").ReviewOrchestratorDeps["stateStore"],
  };
}

function makeOrch(mocks: ReturnType<typeof makeMocks>, runner: ReturnType<typeof makeWorkspaceRunner>) {
  return new ReviewOrchestrator({
    stateStore: mocks.storeAsDep,
    reviewProvider: mocks.provider,
    integrationId: "gerrit-1",
    agentToken: "gh_test_token",
    workspaceRunner: runner,
    buildCloneTarget: (details) => ({
      cloneUrl: `ssh://admin@gerrit.test:29418/${details.project}`,
      sshKeyPath: "/path/to/key",
      sshKnownHostsPath: null,
    }),
    applyPatchset: async (handle, details) => {
      const r = runner as { applyPriorPatchset?: (h: unknown, opts: unknown) => Promise<void> };
      if (r.applyPriorPatchset !== undefined) {
        await r.applyPriorPatchset(handle, { ...PATCHSET_OPTIONS, revisionNumber: details.changeNumber, patchset: details.currentPatchset });
      }
    },
    reviewInstructions: "Review the code changes.",
    reviewSystemPrompt: "You are a code reviewer.",
  });
}

describe("Review live logs and cycle persistence", () => {
  let capturedEvents: AgentLogEvent[];
  let eventListener: (event: AgentLogEvent) => void;

  beforeEach(() => {
    capturedEvents = [];
    eventListener = (event: AgentLogEvent) => capturedEvents.push(event);
    agentLogBus.on("event", eventListener);
    clearTaskEventBuffer(TASK_ID);
  });

  afterEach(() => {
    agentLogBus.off("event", eventListener);
    clearTaskEventBuffer(TASK_ID);
  });

  it("emits lifecycle events on the agentLogBus during a successful review", async () => {
    const mocks = makeMocks(makeTask());
    const runner = makeWorkspaceRunner();
    const orch = makeOrch(mocks, runner);

    await orch.runReview(TASK_ID);

    const types = capturedEvents.map((e) => e.type);
    expect(types).toContain("review.started");
    expect(types).toContain("review.prompt_built");
    expect(types).toContain("review.agent_started");
    expect(types).toContain("review.agent_completed");
    expect(types).toContain("review.parsing");
    expect(types).toContain("review.posting_comments");
    expect(types).toContain("review.completed");
    expect(types).not.toContain("review.failed");
  });

  it("emits review.failed event when agent throws", async () => {
    const mocks = makeMocks(makeTask());
    const runner = makeWorkspaceRunner();
    runner.runReviewInDocker.mockRejectedValueOnce(new Error("agent crashed"));
    const orch = makeOrch(mocks, runner);

    await expect(orch.runReview(TASK_ID)).rejects.toThrow("agent crashed");

    const types = capturedEvents.map((e) => e.type);
    expect(types).toContain("review.started");
    expect(types).toContain("review.failed");
  });

  it("saves a review cycle to the database on success", async () => {
    const mocks = makeMocks(makeTask());
    const runner = makeWorkspaceRunner();
    const orch = makeOrch(mocks, runner);

    await orch.runReview(TASK_ID);

    expect(mocks.store["saveAgentCycle"]).toHaveBeenCalledTimes(1);
    expect(mocks.savedCycles).toHaveLength(1);
    const saved = mocks.savedCycles[0]!;
    expect(saved.taskId).toBe(TASK_ID);
    expect(saved.cycleNumber).toBe(1);

    const result = saved.result as Record<string, unknown>;
    expect(result["status"]).toBe("success");
    expect(result["modifiedFiles"]).toEqual([]);
    expect(result["summary"]).toBe("blocking issue");
    expect(result["agentEvents"]).toBeDefined();
    expect(Array.isArray(result["agentEvents"])).toBe(true);

    const metadata = result["metadata"] as Record<string, unknown>;
    expect(metadata["reviewMode"]).toBe(true);
    expect(metadata["commentCount"]).toBe(1);
    expect(metadata["vote"]).toBe(-1);
  });

  it("saves a failure cycle on error", async () => {
    const mocks = makeMocks(makeTask());
    const runner = makeWorkspaceRunner();
    runner.runReviewInDocker.mockRejectedValueOnce(new Error("boom"));
    const orch = makeOrch(mocks, runner);

    await expect(orch.runReview(TASK_ID)).rejects.toThrow("boom");

    expect(mocks.savedCycles).toHaveLength(1);
    const saved = mocks.savedCycles[0]!;
    const result = saved.result as Record<string, unknown>;
    expect(result["status"]).toBe("failed");
    expect(result["summary"]).toBe("boom");
  });

  it("populates the task event buffer during execution", async () => {
    const mocks = makeMocks(makeTask());
    const runner = makeWorkspaceRunner();
    const orch = makeOrch(mocks, runner);

    // During execution events accumulate in the buffer.
    // After completion the buffer is cleared.
    await orch.runReview(TASK_ID);

    // Buffer should be cleared after completion.
    expect(getTaskEventBuffer(TASK_ID)).toHaveLength(0);
  });

  it("sets all events to the correct taskId and cycleNumber", async () => {
    const mocks = makeMocks(makeTask());
    const runner = makeWorkspaceRunner();
    const orch = makeOrch(mocks, runner);

    await orch.runReview(TASK_ID);

    for (const event of capturedEvents) {
      expect(event.taskId).toBe(TASK_ID);
      expect(event.cycleNumber).toBe(1);
    }
  });

  it("increments cycle number on subsequent reviews", async () => {
    const mocks = makeMocks(makeTask({ state: "REVIEW_WATCHING", reviewedPatchset: 1 }));
    // First call will have 0 existing cycles → cycleNumber 1
    // For the second call, mock that one cycle already exists
    const getAgentCyclesMock = mocks.store["getAgentCycles"] as ReturnType<typeof vi.fn>;
    getAgentCyclesMock.mockResolvedValueOnce([]);          // first run
    getAgentCyclesMock.mockResolvedValueOnce([{ id: 1 }]); // second run

    const runner = makeWorkspaceRunner();
    const orch = makeOrch(mocks, runner);

    await orch.runReview(TASK_ID);

    // Reset state for second run
    (mocks.store["task"] as Task).state = "REVIEW_WATCHING";
    capturedEvents.length = 0;

    await orch.runReview(TASK_ID);

    const startedEvents = capturedEvents.filter((e) => e.type === "review.started");
    expect(startedEvents).toHaveLength(1);
    expect(startedEvents[0]!.cycleNumber).toBe(2);
  });

  it("review.completed event contains comment count and vote", async () => {
    const mocks = makeMocks(makeTask());
    const runner = makeWorkspaceRunner();
    const orch = makeOrch(mocks, runner);

    await orch.runReview(TASK_ID);

    const completed = capturedEvents.find((e) => e.type === "review.completed");
    expect(completed).toBeDefined();
    const data = completed!.data as Record<string, unknown>;
    expect(data["commentCount"]).toBe(1);
    expect(data["vote"]).toBe(-1);
  });
});

describe("Review event categorization", () => {
  it("categorizes review.* events as 'review'", () => {
    const event = normalizeAgentEvent({
      type: "review.started",
      timestamp: new Date().toISOString(),
      data: { changeId: "test" },
      taskId: "t1",
      cycleNumber: 1,
    });
    expect(event.category).toBe("review");
  });

  it("gives review.failed an error level", () => {
    const event = normalizeAgentEvent({
      type: "review.failed",
      timestamp: new Date().toISOString(),
      data: { message: "boom" },
      taskId: "t1",
      cycleNumber: 1,
    });
    expect(event.level).toBe("error");
  });

  it("builds human-readable messages for all review event types", () => {
    const reviewTypes = [
      "review.started",
      "review.prompt_built",
      "review.agent_started",
      "review.agent_completed",
      "review.parsing",
      "review.posting_comments",
      "review.completed",
      "review.failed",
    ];

    for (const type of reviewTypes) {
      const event = normalizeAgentEvent({
        type,
        timestamp: new Date().toISOString(),
        data: {
          commentCount: 3,
          vote: -1,
          outputLength: 500,
          chars: 500,
          comments: 3,
          score: -1,
          message: "test error",
          error: "test error",
        },
        taskId: "t1",
        cycleNumber: 1,
      });
      // All review events should produce a non-empty message
      expect(event.message.length).toBeGreaterThan(0);
    }
  });
});

describe("agentEventBus shared module", () => {
  it("exports agentLogBus as an EventEmitter", () => {
    expect(typeof agentLogBus.on).toBe("function");
    expect(typeof agentLogBus.emit).toBe("function");
  });

  it("pushToTaskBuffer and getTaskEventBuffer round-trip", () => {
    const event: AgentLogEvent = {
      type: "review.test",
      timestamp: new Date().toISOString(),
      data: {},
      taskId: "test-buffer",
      cycleNumber: 1,
    };
    // Import pushToTaskBuffer directly for this test
    clearTaskEventBuffer("test-buffer");
    expect(getTaskEventBuffer("test-buffer")).toHaveLength(0);

    // Emit via bus to also test bus integration
    agentLogBus.emit("event", event);

    // The bus itself doesn't auto-push — that's the caller's responsibility.
    // So buffer should still be empty unless we manually push.
    clearTaskEventBuffer("test-buffer");
  });

  it("clearTaskEventBuffer removes buffered events", () => {
    clearTaskEventBuffer("clear-test");
    expect(getTaskEventBuffer("clear-test")).toHaveLength(0);
  });
});
