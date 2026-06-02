import { describe, it, expect, vi, beforeEach } from "vitest";
import { ReviewOrchestrator } from "../../src/review/reviewOrchestrator.js";
import {
  makeExternalChangeId,
  makeProjectId,
  makeTaskId,
  makeTicketId,
  type ProjectRecord,
  type ReviewChangeDetails,
  type ReviewChangeDiff,
  type ReviewProvider,
  type Task,
  type TaskState,
  type WorkspaceRunner,
  type GerritPatchsetOptions,
} from "../../src/interfaces.js";

const CHANGE_ID = makeExternalChangeId("p~master~Iabc");

const PATCHSET_OPTIONS: Omit<GerritPatchsetOptions, "changeNumber" | "patchset"> = {
  gerritBaseUrl: "ssh://admin@gerrit.test:29418",
  sshHost: "gerrit.test",
  sshPort: 29418,
  sshUser: "admin",
  sshKeyPath: "/path/to/key",
};

const GERRIT_SSH_BASE = "ssh://admin@gerrit.test:29418";

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
    taskId: makeTaskId("review-42-abcd"),
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

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: makeProjectId("proj-1"),
    name: "Test Project",
    type: "coding" as import("../../src/interfaces.js").ProjectType,
    agentId: "agent-1" as import("../../src/interfaces.js").AgentId,
    agentOverrideJson: null,
    postCloneScript: "",
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const GOOD_RAW_OUTPUT = [
  "REVIEW_RESULT_START",
  JSON.stringify({
    comments: [{ file: "src/a.ts", line: 1, message: "Bug", severity: "error" }],
    summary: "blocking",
    score: -1,
  }),
  "REVIEW_RESULT_END",
].join("\n");

function makeWorkspaceRunner(rawOutput = GOOD_RAW_OUTPUT) {
  const handle = {
    taskId: makeTaskId("review-42-abcd"),
    containerId: "",
    volumeName: "",
    hostWorkspacePath: "/workspaces/review-42",
  };
  const runner = {
    createWorkspace: vi.fn(async () => handle),
    prepareProjectWorkspace: vi.fn(async () => ({
      success: true as const,
      localPath: handle.hostWorkspacePath,
    })),
    applyGerritPatchset: vi.fn(async () => undefined),
    runReviewInDocker: vi.fn(async () => ({ rawOutput })),
    destroyWorkspace: vi.fn(async () => undefined),
    cloneRepo: vi.fn(),
    runAgent: vi.fn(),
  } as unknown as WorkspaceRunner & {
    createWorkspace: ReturnType<typeof vi.fn>;
    prepareProjectWorkspace: ReturnType<typeof vi.fn>;
    applyGerritPatchset: ReturnType<typeof vi.fn>;
    runReviewInDocker: ReturnType<typeof vi.fn>;
    destroyWorkspace: ReturnType<typeof vi.fn>;
  };
  return { runner, handle };
}

function makeMocks(initialTask?: Task) {
  const task: Task | undefined = initialTask ? { ...initialTask } : undefined;
  const store: any = {
    task,
    createReviewTask: vi.fn(async (input: { taskId: ReturnType<typeof makeTaskId> }) => {
      const created = makeTask({ taskId: input.taskId });
      store.task = created;
      return created;
    }),
    getTask: vi.fn(async () => store.task ?? null),
    getTaskByTicketId: vi.fn(async () => store.task ?? null),
    transition: vi.fn(async (_id: unknown, to: TaskState) => {
      if (store.task) {
        store.task = { ...store.task, state: to };
      }
      return store.task as Task;
    }),
    setReviewedPatchset: vi.fn(async (_id: unknown, ps: number) => {
      if (store.task) {
        store.task = { ...store.task, reviewedPatchset: ps };
      }
    }),
    setFailureReason: vi.fn(async () => undefined),
    getAgentCycles: vi.fn(async () => []),
    saveAgentCycle: vi.fn(async () => undefined),
    findProjectsByReviewTarget: vi.fn(async () => [makeProject()]),
    getProjectById: vi.fn(async () => makeProject()),
    setTaskProjectId: vi.fn(async () => undefined),
    updateExternalChangeId: vi.fn(async (_id: unknown, _changeId: unknown, patchset: number) => {
      if (store.task) {
        store.task = { ...store.task, currentPatchset: patchset };
      }
    }),
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
    storeAsDep: store as import("../../src/review/reviewOrchestrator.js").ReviewOrchestratorDeps["stateStore"],
  };
}

function makeDeps(
  mocks: ReturnType<typeof makeMocks>,
  runner: ReturnType<typeof makeWorkspaceRunner>["runner"],
  overrides: Partial<import("../../src/review/reviewOrchestrator.js").ReviewOrchestratorDeps> = {}
): import("../../src/review/reviewOrchestrator.js").ReviewOrchestratorDeps {
  return {
    stateStore: mocks.storeAsDep,
    reviewProvider: mocks.provider,
    integrationId: "gerrit-1",
    agentToken: "gh_test_token",
    workspaceRunner: runner,
    buildCloneTarget: (details) => ({
      cloneUrl: `${GERRIT_SSH_BASE}/${details.project}`,
      sshKeyPath: "/path/to/key",
      sshKnownHostsPath: null,
    }),
    applyPatchset: async (handle, details) => {
      await runner.applyGerritPatchset(handle, {
        ...PATCHSET_OPTIONS,
        changeNumber: details.changeNumber,
        patchset: details.currentPatchset,
      });
    },
    reviewInstructions: "Review the code changes.",
    reviewSystemPrompt: "You are a code reviewer.",
    ...overrides,
  };
}

describe("ReviewOrchestrator.startReviewTask", () => {
  let mocks: ReturnType<typeof makeMocks>;
  let runner: ReturnType<typeof makeWorkspaceRunner>["runner"];

  beforeEach(() => {
    mocks = makeMocks();
    ({ runner } = makeWorkspaceRunner());
  });

  it("creates a code-review task for an OPEN change", async () => {
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    const tasks = await orch.startReviewTask({ changeId: CHANGE_ID });
    expect(tasks).toHaveLength(1);
    expect(mocks.store.createReviewTask).toHaveBeenCalledTimes(1);
    const arg = mocks.store.createReviewTask.mock.calls[0]?.[0] as { sourceLabel?: string; subject: string };
    expect(arg.sourceLabel).toBe("gerrit");
    expect(arg.subject).toBe("Add foo");
  });

  it("returns empty array and creates nothing when the change is not OPEN", async () => {
    (mocks.provider.getChangeDetails as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeDetails({ status: "MERGED" })
    );
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    const tasks = await orch.startReviewTask({ changeId: CHANGE_ID });
    expect(tasks).toHaveLength(0);
    expect(mocks.store.createReviewTask).not.toHaveBeenCalled();
  });

  it("does NOT re-queue REVIEW_WATCHING task when patchset has not changed (prevents spurious re-reviews)", async () => {
    const existing = makeTask({ state: "REVIEW_WATCHING", currentPatchset: 2 });
    mocks = makeMocks(existing);
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    const tasks = await orch.startReviewTask({ changeId: CHANGE_ID });
    // Same patchset + REVIEW_WATCHING means we already reviewed it — no second pass.
    expect(tasks).toHaveLength(0);
    expect(mocks.store.createReviewTask).not.toHaveBeenCalled();
  });

  it("does NOT re-queue REVIEW_RUNNING task when patchset has not changed (review in flight)", async () => {
    const existing = makeTask({ state: "REVIEW_RUNNING", currentPatchset: 2 });
    mocks = makeMocks(existing);
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    const tasks = await orch.startReviewTask({ changeId: CHANGE_ID });
    expect(tasks).toHaveLength(0);
    expect(mocks.store.createReviewTask).not.toHaveBeenCalled();
  });

  it("does NOT re-queue REVIEW_COMMENTING task when patchset has not changed (review in flight)", async () => {
    const existing = makeTask({ state: "REVIEW_COMMENTING", currentPatchset: 2 });
    mocks = makeMocks(existing);
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    const tasks = await orch.startReviewTask({ changeId: CHANGE_ID });
    expect(tasks).toHaveLength(0);
    expect(mocks.store.createReviewTask).not.toHaveBeenCalled();
  });

  it("re-queues REVIEW_PENDING task when patchset has not changed (review not yet started)", async () => {
    const existing = makeTask({ state: "REVIEW_PENDING", currentPatchset: 2 });
    mocks = makeMocks(existing);
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    const tasks = await orch.startReviewTask({ changeId: CHANGE_ID });
    // REVIEW_PENDING with same patchset means runReview hasn't run yet — push it.
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.taskId).toBe(existing.taskId);
    expect(mocks.store.createReviewTask).not.toHaveBeenCalled();
  });

  it.each(["REVIEW_RUNNING", "REVIEW_COMMENTING"] as const)(
    "does NOT return task when a run is already in flight (%s)",
    async (state) => {
      const existing = makeTask({ state, currentPatchset: 2 });
      mocks = makeMocks(existing);
      const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
      const tasks = await orch.startReviewTask({ changeId: CHANGE_ID });
      expect(tasks).toHaveLength(0);
      expect(mocks.store.createReviewTask).not.toHaveBeenCalled();
    }
  );

  it("re-queues REVIEW_WATCHING task and updates patchset when a new patchset arrives", async () => {
    const existing = makeTask({ state: "REVIEW_WATCHING", currentPatchset: 1 });
    mocks = makeMocks(existing);
    (mocks.provider.getChangeDetails as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeDetails({ currentPatchset: 2 })
    );
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    const tasks = await orch.startReviewTask({ changeId: CHANGE_ID });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.taskId).toBe(existing.taskId);
    expect(tasks[0]?.currentPatchset).toBe(2);
    expect(mocks.store.createReviewTask).not.toHaveBeenCalled();
    expect(mocks.store.updateExternalChangeId).toHaveBeenCalledWith(
      existing.taskId,
      existing.externalChangeId,
      2,
      "http://gerrit.test/c/42"
    );
  });

  it("updates patchset but does NOT re-queue REVIEW_RUNNING task when a new patchset arrives", async () => {
    const existing = makeTask({ state: "REVIEW_RUNNING", currentPatchset: 1 });
    mocks = makeMocks(existing);
    (mocks.provider.getChangeDetails as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeDetails({ currentPatchset: 2 })
    );
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    const tasks = await orch.startReviewTask({ changeId: CHANGE_ID });
    expect(tasks).toHaveLength(0);
    expect(mocks.store.createReviewTask).not.toHaveBeenCalled();
    expect(mocks.store.updateExternalChangeId).toHaveBeenCalledWith(
      existing.taskId,
      existing.externalChangeId,
      2,
      "http://gerrit.test/c/42"
    );
  });

  it("updates patchset but does NOT re-queue REVIEW_PENDING task when a new patchset arrives", async () => {
    const existing = makeTask({ state: "REVIEW_PENDING", currentPatchset: 1 });
    mocks = makeMocks(existing);
    (mocks.provider.getChangeDetails as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeDetails({ currentPatchset: 2 })
    );
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    const tasks = await orch.startReviewTask({ changeId: CHANGE_ID });
    expect(tasks).toHaveLength(0);
    expect(mocks.store.createReviewTask).not.toHaveBeenCalled();
    expect(mocks.store.updateExternalChangeId).toHaveBeenCalledWith(
      existing.taskId,
      existing.externalChangeId,
      2,
      "http://gerrit.test/c/42"
    );
  });

  it("returns empty array when no project covers this repo", async () => {
    mocks.store.findProjectsByReviewTarget.mockResolvedValue([]);
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    const tasks = await orch.startReviewTask({ changeId: CHANGE_ID });
    expect(tasks).toHaveLength(0);
    expect(mocks.store.createReviewTask).not.toHaveBeenCalled();
  });

  it("creates one task per matching project", async () => {
    const p1 = makeProject({ id: makeProjectId("proj-1") });
    const p2 = makeProject({ id: makeProjectId("proj-2") });
    mocks.store.findProjectsByReviewTarget.mockResolvedValue([p1, p2]);
    mocks.store.getTaskByTicketId.mockResolvedValue(null);
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    const tasks = await orch.startReviewTask({ changeId: CHANGE_ID });
    expect(tasks).toHaveLength(2);
    expect(mocks.store.createReviewTask).toHaveBeenCalledTimes(2);
    expect(mocks.store.setTaskProjectId).toHaveBeenCalledTimes(2);
  });
});

describe("ReviewOrchestrator.runReview â happy path", () => {
  it("runs the full Docker path: PENDING â RUNNING â COMMENTING â WATCHING", async () => {
    const initial = makeTask({ state: "REVIEW_PENDING" });
    const mocks = makeMocks(initial);
    const { runner } = makeWorkspaceRunner();
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));

    await orch.runReview(initial.taskId);

    const transitions = mocks.store.transition.mock.calls.map((c: [unknown, unknown]) => c[1]);
    expect(transitions).toEqual(["REVIEW_RUNNING", "REVIEW_COMMENTING", "REVIEW_WATCHING"]);

    expect(mocks.provider.postReviewComments).toHaveBeenCalledWith(
      CHANGE_ID,
      2,
      [{ file: "src/a.ts", line: 1, message: "Bug", severity: "error" }],
      "blocking"
    );
    expect(mocks.provider.vote).toHaveBeenCalledWith(CHANGE_ID, 2, -1, "blocking");
    expect(mocks.store.setReviewedPatchset).toHaveBeenCalledWith(initial.taskId, 2);
  });

  it("strips hallucinated comments before calling the provider (only in-diff paths sent)", async () => {
    const initial = makeTask({ state: "REVIEW_PENDING" });
    const mocks = makeMocks(initial);
    const hallucinated = [
      "REVIEW_RESULT_START",
      JSON.stringify({
        comments: [
          { file: "src/a.ts", line: 1, message: "Real", severity: "error" },
          { file: "src/ghost.ts", line: 9, message: "Hallucinated", severity: "error" },
        ],
        summary: "blocking",
        score: -1,
      }),
      "REVIEW_RESULT_END",
    ].join("\n");
    const { runner } = makeWorkspaceRunner(hallucinated);
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));

    await orch.runReview(initial.taskId);

    const postedComments = (mocks.provider.postReviewComments as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[2] as unknown[];
    expect(postedComments).toHaveLength(1);
    expect((postedComments[0] as { file: string }).file).toBe("src/a.ts");
    expect(mocks.provider.postReviewComments).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(),
      expect.arrayContaining([expect.objectContaining({ file: "src/ghost.ts" })]),
      expect.anything()
    );
  });

  it("skips postReviewComments when all comments are outside the diff and summary is empty", async () => {
    const initial = makeTask({ state: "REVIEW_PENDING" });
    const mocks = makeMocks(initial);
    const allFiltered = [
      "REVIEW_RESULT_START",
      JSON.stringify({
        comments: [{ file: "src/ghost.ts", line: 9, message: "Hallucinated", severity: "error" }],
        summary: "",
        score: -1,
      }),
      "REVIEW_RESULT_END",
    ].join("\n");
    const { runner } = makeWorkspaceRunner(allFiltered);
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));

    await orch.runReview(initial.taskId);

    expect(mocks.provider.postReviewComments).not.toHaveBeenCalled();
    expect(mocks.provider.vote).toHaveBeenCalledWith(CHANGE_ID, 2, expect.any(Number), "");
  });

  it("passes all comments through when diff has no files (no filtering applied)", async () => {
    const initial = makeTask({ state: "REVIEW_PENDING" });
    const mocks = makeMocks(initial);
    (mocks.provider.getChangeDiff as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeDiff({ files: [] })
    );
    const { runner } = makeWorkspaceRunner();
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));

    await orch.runReview(initial.taskId);

    expect(mocks.provider.postReviewComments).toHaveBeenCalledWith(
      CHANGE_ID,
      2,
      [{ file: "src/a.ts", line: 1, message: "Bug", severity: "error" }],
      "blocking"
    );
  });

  it("transitions to REVIEW_DONE when the change is no longer OPEN after commenting", async () => {
    const initial = makeTask({ state: "REVIEW_PENDING" });
    const mocks = makeMocks(initial);
    const { runner } = makeWorkspaceRunner();
    (mocks.provider.getChangeDetails as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeDetails({ status: "OPEN" }))
      .mockResolvedValueOnce(makeDetails({ status: "MERGED" }));

    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    await orch.runReview(initial.taskId);
    const transitions = mocks.store.transition.mock.calls.map((c: [unknown, unknown]) => c[1]);
    expect(transitions[transitions.length - 1]).toBe("REVIEW_DONE");
  });

  it("clones repository from Gerrit SSH config and applies the patchset", async () => {
    const initial = makeTask({ state: "REVIEW_PENDING", projectId: makeProjectId("proj-1") });
    const mocks = makeMocks(initial);
    const { runner } = makeWorkspaceRunner();
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));

    await orch.runReview(initial.taskId);

    expect(mocks.store.getProjectById).toHaveBeenCalledWith(makeProjectId("proj-1"));
    expect(runner.prepareProjectWorkspace).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({
          repoKey: "p",
          cloneUrl: `${GERRIT_SSH_BASE}/p`,
          targetBranch: "main",
          sshKeyPath: "/path/to/key",
        }),
      ]),
      undefined,
      undefined
    );
    expect(runner.applyGerritPatchset).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ changeNumber: 42, patchset: 2, ...PATCHSET_OPTIONS })
    );
    expect(runner.runReviewInDocker).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        changeId: CHANGE_ID,
        changeNumber: 42,
        patchset: 2,
        agentToken: "gh_test_token",
        prompt: expect.any(String),
        systemPrompt: "You are a code reviewer.",
      }),
      expect.objectContaining({ onStderrChunk: expect.any(Function) })
    );
    expect(runner.destroyWorkspace).toHaveBeenCalledOnce();
  });

  it("passes postCloneScript to prepareProjectWorkspace when non-empty", async () => {
    const initial = makeTask({ state: "REVIEW_PENDING", projectId: makeProjectId("proj-1") });
    const mocks = makeMocks(initial);
    mocks.store.getProjectById.mockResolvedValue(
      makeProject({ postCloneScript: "npm ci" })
    );
    const { runner } = makeWorkspaceRunner();
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));

    await orch.runReview(initial.taskId);

    expect(runner.prepareProjectWorkspace).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Array),
      "npm ci",
      undefined
    );
  });
});

describe("ReviewOrchestrator.runReview â failure paths", () => {
  it("marks task REVIEW_FAILED and rethrows on runReviewInDocker failure", async () => {
    const initial = makeTask({ state: "REVIEW_PENDING" });
    const mocks = makeMocks(initial);
    const { runner } = makeWorkspaceRunner();
    runner.runReviewInDocker.mockRejectedValueOnce(new Error("container crashed"));

    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    await expect(orch.runReview(initial.taskId)).rejects.toThrow("container crashed");
    expect(mocks.store.setFailureReason).toHaveBeenCalledWith(initial.taskId, "container crashed");
    const transitions = mocks.store.transition.mock.calls.map((c: [unknown, unknown]) => c[1]);
    expect(transitions).toContain("REVIEW_FAILED");
  });

  it("destroys workspace even when runReviewInDocker throws", async () => {
    const initial = makeTask({ state: "REVIEW_PENDING" });
    const mocks = makeMocks(initial);
    const { runner } = makeWorkspaceRunner();
    runner.runReviewInDocker.mockRejectedValueOnce(new Error("container crashed"));

    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    await expect(orch.runReview(initial.taskId)).rejects.toThrow("container crashed");
    expect(runner.destroyWorkspace).toHaveBeenCalledOnce();
  });

  it("destroys workspace even when applyPatchset throws", async () => {
    const initial = makeTask({ state: "REVIEW_PENDING" });
    const mocks = makeMocks(initial);
    const { runner } = makeWorkspaceRunner();
    runner.applyGerritPatchset.mockRejectedValueOnce(new Error("git fetch failed"));

    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    await expect(orch.runReview(initial.taskId)).rejects.toThrow("git fetch failed");
    expect(runner.destroyWorkspace).toHaveBeenCalledOnce();
  });

  it("marks REVIEW_FAILED when no project is configured for the Gerrit change", async () => {
    const initial = makeTask({ state: "REVIEW_PENDING", projectId: null });
    const mocks = makeMocks(initial);
    mocks.store.getProjectById.mockResolvedValue(null);
    const { runner } = makeWorkspaceRunner();

    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    await expect(orch.runReview(initial.taskId)).rejects.toThrow(/No VE project linked/);
    const transitions = mocks.store.transition.mock.calls.map((c: [unknown, unknown]) => c[1]);
    expect(transitions).toContain("REVIEW_FAILED");
    expect(runner.createWorkspace).not.toHaveBeenCalled();
  });

  it("marks REVIEW_FAILED when prepareProjectWorkspace reports failure", async () => {
    const initial = makeTask({ state: "REVIEW_PENDING" });
    const mocks = makeMocks(initial);
    const { runner } = makeWorkspaceRunner();
    runner.prepareProjectWorkspace.mockResolvedValue({
      success: false,
      localPath: "/workspaces/review-42",
      error: "clone error",
    });

    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    await expect(orch.runReview(initial.taskId)).rejects.toThrow(/clone error/);
    const transitions = mocks.store.transition.mock.calls.map((c: [unknown, unknown]) => c[1]);
    expect(transitions).toContain("REVIEW_FAILED");
    expect(runner.destroyWorkspace).toHaveBeenCalledOnce();
  });

  it("marks REVIEW_FAILED when workspaceRunner lacks prepareProjectWorkspace", async () => {
    const initial = makeTask({ state: "REVIEW_PENDING" });
    const mocks = makeMocks(initial);
    const { runner } = makeWorkspaceRunner();
    (runner as unknown as Record<string, unknown>)["prepareProjectWorkspace"] = undefined;

    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    await expect(orch.runReview(initial.taskId)).rejects.toThrow(/prepareProjectWorkspace/);
    const transitions = mocks.store.transition.mock.calls.map((c: [unknown, unknown]) => c[1]);
    expect(transitions).toContain("REVIEW_FAILED");
  });

  it("marks REVIEW_FAILED when workspaceRunner lacks runReviewInDocker", async () => {
    const initial = makeTask({ state: "REVIEW_PENDING" });
    const mocks = makeMocks(initial);
    const { runner } = makeWorkspaceRunner();
    (runner as unknown as Record<string, unknown>)["runReviewInDocker"] = undefined;

    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    await expect(orch.runReview(initial.taskId)).rejects.toThrow(/runReviewInDocker/);
    const transitions = mocks.store.transition.mock.calls.map((c: [unknown, unknown]) => c[1]);
    expect(transitions).toContain("REVIEW_FAILED");
  });
});

describe("ReviewOrchestrator.runReview â terminal state guard", () => {
  const terminalStates: TaskState[] = ["REVIEW_DONE", "REVIEW_FAILED", "FAILED", "DONE", "ABANDONED"];

  for (const state of terminalStates) {
    it(`throws without calling stateStore.transition when task is in ${state}`, async () => {
      const initial = makeTask({ state });
      const mocks = makeMocks(initial);
      const { runner } = makeWorkspaceRunner();
      const orch = new ReviewOrchestrator(makeDeps(mocks, runner));

      await expect(orch.runReview(initial.taskId)).rejects.toThrow(/non-resumable state/);
      expect(mocks.store.transition).not.toHaveBeenCalled();
    });
  }
});

describe("Unused symbols import sanity check", () => {
  it("exposes ReviewOrchestrator type", () => {
    const _orch: ReviewOrchestrator | undefined = undefined;
    expect(_orch).toBeUndefined();
  });
});
