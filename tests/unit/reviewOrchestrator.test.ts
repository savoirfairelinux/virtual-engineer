import { describe, it, expect, vi, beforeEach } from "vitest";
import { ReviewOrchestrator } from "../../src/review/reviewOrchestrator.js";
import { computeCommentHash, computeThreadReplyHash } from "../../src/review/commentHash.js";
import {
  makeExternalChangeId,
  makeProjectId,
  makeTaskId,
  makeTicketId,
  type ProjectRecord,
  type ReviewChangeDetails,
  type ReviewChangeDiff,
  type ReviewDiscussionThread,
  type ReviewProvider,
  type Task,
  type TaskState,
  type WorkspaceRunner,
  type PatchsetCheckoutOptions,
} from "../../src/interfaces.js";

const CHANGE_ID = makeExternalChangeId("p~master~Iabc");

const PATCHSET_OPTIONS: Omit<PatchsetCheckoutOptions, "revisionNumber" | "patchset"> = {
  vcsBaseUrl: "ssh://admin@gerrit.test:29418",
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
    skillDiscoveryEnabled: false,
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
    applyPriorPatchset: vi.fn(async () => undefined),
    runReviewInDocker: vi.fn(async () => ({ rawOutput })),
    destroyWorkspace: vi.fn(async () => undefined),
    cloneRepo: vi.fn(),
    runAgent: vi.fn(),
  } as unknown as WorkspaceRunner & {
    createWorkspace: ReturnType<typeof vi.fn>;
    prepareProjectWorkspace: ReturnType<typeof vi.fn>;
    applyPriorPatchset: ReturnType<typeof vi.fn>;
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
    incrementCycle: vi.fn(async () => {
      if (store.task) {
        const next = store.task.cycleCount + 1;
        store.task = { ...store.task, cycleCount: next };
        return next;
      }
      return 1;
    }),
    getAgentCycles: vi.fn(async () => []),
    saveAgentCycle: vi.fn(async () => undefined),
    getPostedReviewCommentHashes: vi.fn(async () => new Set<string>()),
    getPostedReviewComments: vi.fn(async () => []),
    markReviewCommentsPosted: vi.fn(async () => undefined),
    getHandledThreadReplyHashes: vi.fn(async () => new Set<string>()),
    markThreadReplyPosted: vi.fn(async () => undefined),
    findProjectsByReviewTarget: vi.fn(async () => [makeProject()]),
    getProjectById: vi.fn(async () => makeProject()),
    setTaskProjectId: vi.fn(async () => undefined),
    findReviewedCodeReviewTask: vi.fn(async () => null),
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
      await runner.applyPriorPatchset(handle, {
        ...PATCHSET_OPTIONS,
        revisionNumber: details.changeNumber,
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
    const projectIds = mocks.store.createReviewTask.mock.calls.map(
      (c: unknown[]) => (c[0] as { projectId?: string }).projectId
    );
    expect(projectIds).toEqual(["proj-1", "proj-2"]);
  });

  it("skips an automatic trigger when the review server reports VE already reviewed the current patchset (fresh instance)", async () => {
    // Fresh instance: no local task row exists, so the per-task dedup guards
    // cannot help. The provider's server-side check is the authoritative
    // cross-instance signal that VE already reviewed this patchset.
    mocks = makeMocks();
    (mocks.provider as { hasReviewedCurrentPatchset?: unknown }).hasReviewedCurrentPatchset = vi.fn(
      async () => true
    );
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    const tasks = await orch.startReviewTask({ changeId: CHANGE_ID });
    expect(tasks).toHaveLength(0);
    expect(mocks.store.createReviewTask).not.toHaveBeenCalled();
    expect(mocks.store.findProjectsByReviewTarget).not.toHaveBeenCalled();
  });

  it("proceeds when the review server reports VE has NOT reviewed the current patchset", async () => {
    mocks = makeMocks();
    (mocks.provider as { hasReviewedCurrentPatchset?: unknown }).hasReviewedCurrentPatchset = vi.fn(
      async () => false
    );
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    const tasks = await orch.startReviewTask({ changeId: CHANGE_ID });
    expect(tasks).toHaveLength(1);
    expect(mocks.store.createReviewTask).toHaveBeenCalledTimes(1);
  });

  it("bypasses the server-side already-reviewed guard when force is set (manual re-add)", async () => {
    mocks = makeMocks();
    const spy = vi.fn(async () => true);
    (mocks.provider as { hasReviewedCurrentPatchset?: unknown }).hasReviewedCurrentPatchset = spy;
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    const tasks = await orch.startReviewTask({ changeId: CHANGE_ID, force: true });
    expect(tasks).toHaveLength(1);
    expect(mocks.store.createReviewTask).toHaveBeenCalledTimes(1);
    // Force path must not even consult the server-side guard.
    expect(spy).not.toHaveBeenCalled();
  });

  it("proceeds (fail-open) when the server-side already-reviewed check throws", async () => {
    mocks = makeMocks();
    (mocks.provider as { hasReviewedCurrentPatchset?: unknown }).hasReviewedCurrentPatchset = vi.fn(
      async () => {
        throw new Error("ssh timeout");
      }
    );
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    const tasks = await orch.startReviewTask({ changeId: CHANGE_ID });
    expect(tasks).toHaveLength(1);
    expect(mocks.store.createReviewTask).toHaveBeenCalledTimes(1);
  });

  it("does NOT re-trigger when the current patchset was already reviewed (automatic resync)", async () => {
    // Resting state after a completed review: REVIEW_WATCHING with reviewedPatchset
    // == currentPatchset. An automatic resync (backfill / polling / webhook
    // re-delivery) must not launch a second review on the same patchset.
    const existing = makeTask({ state: "REVIEW_WATCHING", currentPatchset: 2, reviewedPatchset: 2 });
    mocks = makeMocks(existing);
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    const tasks = await orch.startReviewTask({ changeId: CHANGE_ID });
    expect(tasks).toHaveLength(0);
    expect(mocks.store.createReviewTask).not.toHaveBeenCalled();
  });

  it("does NOT create a duplicate task when a terminal REVIEW_DONE row already reviewed this patchset", async () => {
    // The double-review bug: a terminal row used to fall through and spawn a new
    // task. The reviewedPatchset guard now skips it for automatic triggers.
    const existing = makeTask({ state: "REVIEW_DONE", currentPatchset: 2, reviewedPatchset: 2 });
    mocks = makeMocks(existing);
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    const tasks = await orch.startReviewTask({ changeId: CHANGE_ID });
    expect(tasks).toHaveLength(0);
    expect(mocks.store.createReviewTask).not.toHaveBeenCalled();
  });

  it("does NOT create a duplicate task for a REVIEW_DONE row with an unrecorded (null) reviewedPatchset", async () => {
    // Legacy / interrupted completed review: state is REVIEW_DONE but
    // reviewedPatchset was never persisted. A startup backfill must still skip
    // it rather than re-review a change VE already finished.
    const existing = makeTask({ state: "REVIEW_DONE", currentPatchset: 2, reviewedPatchset: null });
    mocks = makeMocks(existing);
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    const tasks = await orch.startReviewTask({ changeId: CHANGE_ID });
    expect(tasks).toHaveLength(0);
    expect(mocks.store.createReviewTask).not.toHaveBeenCalled();
  });

  it("re-triggers a REVIEW_DONE row with a null reviewedPatchset when force is set (manual re-trigger)", async () => {
    const existing = makeTask({ state: "REVIEW_DONE", currentPatchset: 2, reviewedPatchset: null });
    mocks = makeMocks(existing);
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    const tasks = await orch.startReviewTask({ changeId: CHANGE_ID, force: true });
    expect(tasks).toHaveLength(1);
    expect(mocks.store.createReviewTask).toHaveBeenCalledTimes(1);
  });

  it("creates a new review task for a REVIEW_DONE row with a null reviewedPatchset when the patchset advanced", async () => {
    // Completed review with an unrecorded patchset, but Gerrit has since moved
    // to a newer patchset — this is NOT a duplicate and must still be reviewed.
    const existing = makeTask({ state: "REVIEW_DONE", currentPatchset: 2, reviewedPatchset: null });
    mocks = makeMocks(existing);
    (mocks.provider.getChangeDetails as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeDetails({ currentPatchset: 3 })
    );
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    const tasks = await orch.startReviewTask({ changeId: CHANGE_ID });
    expect(tasks).toHaveLength(1);
    expect(mocks.store.createReviewTask).toHaveBeenCalledTimes(1);
  });

  it("re-queues an already-reviewed REVIEW_WATCHING task when force is set (manual re-trigger)", async () => {
    const existing = makeTask({ state: "REVIEW_WATCHING", currentPatchset: 2, reviewedPatchset: 2 });
    mocks = makeMocks(existing);
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    const tasks = await orch.startReviewTask({ changeId: CHANGE_ID, force: true });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.taskId).toBe(existing.taskId);
    expect(mocks.store.createReviewTask).not.toHaveBeenCalled();
  });

  it("creates a fresh review task when force is set and the prior review is terminal", async () => {
    const existing = makeTask({ state: "REVIEW_DONE", currentPatchset: 2, reviewedPatchset: 2 });
    mocks = makeMocks(existing);
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    const tasks = await orch.startReviewTask({ changeId: CHANGE_ID, force: true });
    expect(tasks).toHaveLength(1);
    expect(mocks.store.createReviewTask).toHaveBeenCalledTimes(1);
  });

  it("does NOT create a new task when a prior integration already reviewed this patchset (integration delete+recreate)", async () => {
    // Simulates: integration deleted+recreated with new UUID → getTaskByTicketId returns
    // null (ticketId changed), but findReviewedCodeReviewTask finds the prior reviewed task.
    mocks = makeMocks(undefined);
    mocks.store.getTaskByTicketId = vi.fn(async () => null);
    const priorTask = makeTask({ state: "REVIEW_DONE", currentPatchset: 2, reviewedPatchset: 2 });
    mocks.store.findReviewedCodeReviewTask = vi.fn(async () => priorTask);
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    const tasks = await orch.startReviewTask({ changeId: CHANGE_ID });
    expect(tasks).toHaveLength(0);
    expect(mocks.store.createReviewTask).not.toHaveBeenCalled();
  });

  it("creates a new task with force=true even when a prior integration already reviewed this patchset", async () => {
    mocks = makeMocks(undefined);
    mocks.store.getTaskByTicketId = vi.fn(async () => null);
    const priorTask = makeTask({ state: "REVIEW_DONE", currentPatchset: 2, reviewedPatchset: 2 });
    mocks.store.findReviewedCodeReviewTask = vi.fn(async () => priorTask);
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    const tasks = await orch.startReviewTask({ changeId: CHANGE_ID, force: true });
    expect(tasks).toHaveLength(1);
    expect(mocks.store.createReviewTask).toHaveBeenCalledTimes(1);
  });

  it("re-triggers a watched change on a genuinely new patchset even when the old one was reviewed", async () => {
    const existing = makeTask({ state: "REVIEW_WATCHING", currentPatchset: 1, reviewedPatchset: 1 });
    mocks = makeMocks(existing);
    (mocks.provider.getChangeDetails as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeDetails({ currentPatchset: 2 })
    );
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    const tasks = await orch.startReviewTask({ changeId: CHANGE_ID });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.currentPatchset).toBe(2);
    expect(mocks.store.createReviewTask).not.toHaveBeenCalled();
  });
});

describe("ReviewOrchestrator.runReview â happy path", () => {
  it("runs the full Docker path: PENDING â RUNNING â COMMENTING â WATCHING", async () => {
    const initial = makeTask({ state: "REVIEW_PENDING" });
    const mocks = makeMocks(initial);
    const { runner } = makeWorkspaceRunner();
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));

    await orch.runReview(initial.taskId);

    expect(mocks.store.incrementCycle).toHaveBeenCalledWith(initial.taskId);
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

  it("does not re-post inline comments already posted on the change", async () => {
    const initial = makeTask({ state: "REVIEW_PENDING" });
    const mocks = makeMocks(initial);
    const { runner } = makeWorkspaceRunner();

    // Stateful posted-comment store shared across both review passes.
    const posted = new Set<string>();
    (mocks.store.getPostedReviewCommentHashes as ReturnType<typeof vi.fn>).mockImplementation(
      async () => new Set(posted)
    );
    (mocks.store.markReviewCommentsPosted as ReturnType<typeof vi.fn>).mockImplementation(
      async (_taskId: unknown, _changeId: unknown, comments: { commentHash: string }[]) => {
        for (const c of comments) posted.add(c.commentHash);
      }
    );

    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));

    // First pass: the single comment is new and gets posted + recorded.
    await orch.runReview(initial.taskId);
    expect(
      (mocks.provider.postReviewComments as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]
    ).toHaveLength(1);
    expect(posted.size).toBe(1);

    // Second pass on the same diff (task is now REVIEW_WATCHING, a valid entry).
    (mocks.provider.postReviewComments as ReturnType<typeof vi.fn>).mockClear();
    await orch.runReview(initial.taskId);

    // The identical comment is recognised as already posted → no inline comments.
    const secondPosted = (mocks.provider.postReviewComments as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[2] as unknown[];
    expect(secondPosted).toEqual([]);
    expect(posted.size).toBe(1);
  });

  it("does not re-post summary or vote on a re-review when nothing is new and the verdict is unchanged", async () => {
    const initial = makeTask({ state: "REVIEW_WATCHING", cycleCount: 1 });
    const mocks = makeMocks(initial);
    const { runner } = makeWorkspaceRunner();

    // The single comment from GOOD_RAW_OUTPUT is already on record.
    const knownHash = computeCommentHash({ file: "src/a.ts", message: "Bug" });
    (mocks.store.getPostedReviewCommentHashes as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Set([knownHash])
    );
    // The previous cycle recorded a blocking (-1) vote — same as this pass.
    (mocks.store.getAgentCycles as ReturnType<typeof vi.fn>).mockResolvedValue([
      { result: { metadata: { vote: -1 } } },
    ]);

    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    await orch.runReview(initial.taskId);

    // Nothing new to say and the verdict is unchanged → stay silent.
    expect(mocks.provider.postReviewComments).not.toHaveBeenCalled();
    expect(mocks.provider.vote).not.toHaveBeenCalled();
    // The lifecycle still advances internally (no external notification).
    const transitions = mocks.store.transition.mock.calls.map((c: [unknown, unknown]) => c[1]);
    expect(transitions).toContain("REVIEW_COMMENTING");
  });

  it("re-posts summary + vote on a forced re-review even when nothing is new and the verdict is unchanged", async () => {
    const initial = makeTask({ state: "REVIEW_WATCHING", cycleCount: 1, reviewedPatchset: 2 });
    const mocks = makeMocks(initial);
    const { runner } = makeWorkspaceRunner();

    // Same conditions as the silent re-review above: known comment, unchanged vote.
    const knownHash = computeCommentHash({ file: "src/a.ts", message: "Bug" });
    (mocks.store.getPostedReviewCommentHashes as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Set([knownHash])
    );
    (mocks.store.getAgentCycles as ReturnType<typeof vi.fn>).mockResolvedValue([
      { result: { metadata: { vote: -1 } } },
    ]);

    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    await orch.runReview(initial.taskId, { force: true });

    // Force bypasses the skip gate: the vote + summary are re-posted even though
    // nothing changed. Inline comments stay deduped (no duplicate comments).
    expect(mocks.provider.vote).toHaveBeenCalledWith(CHANGE_ID, 2, -1, "blocking");
    const postedComments = (mocks.provider.postReviewComments as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[2] as unknown[];
    expect(postedComments).toEqual([]);
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

  it("does not record or fold out-of-diff comments (only addressable paths persisted)", async () => {
    const initial = makeTask({ state: "REVIEW_PENDING" });
    const mocks = makeMocks(initial);
    const recorded: Array<{ file: string }> = [];
    (mocks.store.markReviewCommentsPosted as ReturnType<typeof vi.fn>).mockImplementation(
      async (_taskId: unknown, _changeId: unknown, comments: Array<{ file: string }>) => {
        recorded.push(...comments);
      }
    );
    // The hallucinated comment is below the inline-severity threshold, so before
    // the fix it would be folded into the summary AND recorded in
    // posted_review_comments even though postReview drops it before posting.
    const hallucinated = [
      "REVIEW_RESULT_START",
      JSON.stringify({
        comments: [
          { file: "src/a.ts", line: 1, message: "Real", severity: "error" },
          { file: "src/ghost.ts", line: 9, message: "Hallucinated", severity: "nit" },
        ],
        summary: "blocking",
        score: -1,
      }),
      "REVIEW_RESULT_END",
    ].join("\n");
    const { runner } = makeWorkspaceRunner(hallucinated);
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));

    await orch.runReview(initial.taskId);

    // Only the in-diff comment is recorded into posted_review_comments.
    expect(recorded.map((c) => c.file)).toEqual(["src/a.ts"]);
    // The folded-summary appendix never mentions the out-of-diff path.
    const summaryArg = (mocks.provider.vote as ReturnType<typeof vi.fn>).mock.calls[0]?.[3] as string;
    expect(summaryArg).not.toContain("src/ghost.ts");
  });

  it("posts the review on the LATEST patchset when a new one arrives during the agent run", async () => {
    // The change is cloned/reviewed at patchset 2, but a new patchset 3 is
    // uploaded while the agent runs. The review must be posted on 3 (the latest),
    // not on the stale patchset 2 captured at clone time.
    const initial = makeTask({ state: "REVIEW_PENDING" });
    const mocks = makeMocks(initial);
    const { runner } = makeWorkspaceRunner();
    (mocks.provider.getChangeDetails as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeDetails({ currentPatchset: 2 })) // clone/apply: reviewed patchset
      .mockResolvedValueOnce(makeDetails({ currentPatchset: 3 })) // fresh fetch before posting
      .mockResolvedValueOnce(makeDetails({ currentPatchset: 3 })); // post-check: still OPEN

    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    await orch.runReview(initial.taskId);

    expect(runner.applyPriorPatchset).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ patchset: 2 })
    );
    expect(mocks.provider.postReviewComments).toHaveBeenCalledWith(
      CHANGE_ID,
      3,
      [{ file: "src/a.ts", line: 1, message: "Bug", severity: "error" }],
      "blocking"
    );
    expect(mocks.provider.vote).toHaveBeenCalledWith(CHANGE_ID, 3, -1, "blocking");
    expect(mocks.store.setReviewedPatchset).toHaveBeenCalledWith(initial.taskId, 3);
    expect(mocks.provider.postReviewComments).not.toHaveBeenCalledWith(
      CHANGE_ID,
      2,
      expect.anything(),
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
    expect(runner.applyPriorPatchset).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ revisionNumber: 42, patchset: 2, ...PATCHSET_OPTIONS })
    );
    expect(runner.runReviewInDocker).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        changeId: CHANGE_ID,
        revisionNumber: 42,
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

describe("ReviewOrchestrator.runReview - inter-patchset delta", () => {
  it("fetches the delta and injects it into the prompt on a re-review", async () => {
    const initial = makeTask({
      state: "REVIEW_WATCHING",
      cycleCount: 1,
      reviewedPatchset: 2,
      currentPatchset: 3,
    });
    const mocks = makeMocks(initial);
    const { runner } = makeWorkspaceRunner();

    (mocks.provider.getChangeDetails as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeDetails({ currentPatchset: 3 })
    );
    const getInterPatchsetDiff = vi.fn(async () =>
      makeDiff({
        patchset: 3,
        files: [{ path: "src/a.ts", status: "modified", patch: "+delta-line" }],
      })
    );
    mocks.provider.getInterPatchsetDiff =
      getInterPatchsetDiff as NonNullable<ReviewProvider["getInterPatchsetDiff"]>;

    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    await orch.runReview(initial.taskId);

    expect(getInterPatchsetDiff).toHaveBeenCalledWith(
      expect.objectContaining({ changeId: CHANGE_ID, currentPatchset: 3 }),
      2,
      3
    );
    const prompt = runner.runReviewInDocker.mock.calls[0]?.[1]?.prompt as string;
    expect(prompt).toContain("## Changes since last reviewed patchset (PS 2 \u2192 3)");
    expect(prompt).toContain("+delta-line");
  });

  it("does not fetch a delta on the first review (no prior reviewed patchset)", async () => {
    const initial = makeTask({
      state: "REVIEW_PENDING",
      reviewedPatchset: null,
      currentPatchset: 2,
    });
    const mocks = makeMocks(initial);
    const { runner } = makeWorkspaceRunner();
    const getInterPatchsetDiff = vi.fn(async () => makeDiff());
    mocks.provider.getInterPatchsetDiff =
      getInterPatchsetDiff as NonNullable<ReviewProvider["getInterPatchsetDiff"]>;

    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    await orch.runReview(initial.taskId);

    expect(getInterPatchsetDiff).not.toHaveBeenCalled();
    const prompt = runner.runReviewInDocker.mock.calls[0]?.[1]?.prompt as string;
    expect(prompt).not.toContain("## Changes since last reviewed patchset");
  });

  it("does not fetch a delta when the provider lacks getInterPatchsetDiff", async () => {
    const initial = makeTask({
      state: "REVIEW_WATCHING",
      cycleCount: 1,
      reviewedPatchset: 2,
      currentPatchset: 3,
    });
    const mocks = makeMocks(initial);
    const { runner } = makeWorkspaceRunner();
    (mocks.provider.getChangeDetails as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeDetails({ currentPatchset: 3 })
    );
    // Provider has no getInterPatchsetDiff (default mock omits it).
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    await orch.runReview(initial.taskId);

    const prompt = runner.runReviewInDocker.mock.calls[0]?.[1]?.prompt as string;
    expect(prompt).not.toContain("## Changes since last reviewed patchset");
  });

  it("degrades gracefully when the delta fetch fails", async () => {
    const initial = makeTask({
      state: "REVIEW_WATCHING",
      cycleCount: 1,
      reviewedPatchset: 2,
      currentPatchset: 3,
    });
    const mocks = makeMocks(initial);
    const { runner } = makeWorkspaceRunner();
    (mocks.provider.getChangeDetails as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeDetails({ currentPatchset: 3 })
    );
    mocks.provider.getInterPatchsetDiff = vi.fn(async () => {
      throw new Error("fetch failed");
    }) as NonNullable<ReviewProvider["getInterPatchsetDiff"]>;

    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    await expect(orch.runReview(initial.taskId)).resolves.toBeUndefined();
    const prompt = runner.runReviewInDocker.mock.calls[0]?.[1]?.prompt as string;
    expect(prompt).not.toContain("## Changes since last reviewed patchset");
  });

  it("does not fetch a delta when reviewedPatchset equals currentPatchset", async () => {
    const initial = makeTask({
      state: "REVIEW_WATCHING",
      cycleCount: 1,
      reviewedPatchset: 3,
      currentPatchset: 3,
    });
    const mocks = makeMocks(initial);
    const { runner } = makeWorkspaceRunner();
    (mocks.provider.getChangeDetails as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeDetails({ currentPatchset: 3 })
    );
    const getInterPatchsetDiff = vi.fn(async () => makeDiff());
    mocks.provider.getInterPatchsetDiff =
      getInterPatchsetDiff as NonNullable<ReviewProvider["getInterPatchsetDiff"]>;

    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    await orch.runReview(initial.taskId);

    expect(getInterPatchsetDiff).not.toHaveBeenCalled();
    const prompt = runner.runReviewInDocker.mock.calls[0]?.[1]?.prompt as string;
    expect(prompt).not.toContain("## Changes since last reviewed patchset");
  });

  it("omits the delta section in the prompt when the delta contains no files", async () => {
    const initial = makeTask({
      state: "REVIEW_WATCHING",
      cycleCount: 1,
      reviewedPatchset: 2,
      currentPatchset: 3,
    });
    const mocks = makeMocks(initial);
    const { runner } = makeWorkspaceRunner();
    (mocks.provider.getChangeDetails as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeDetails({ currentPatchset: 3 })
    );
    mocks.provider.getInterPatchsetDiff = vi.fn(async () =>
      makeDiff({ patchset: 3, files: [] })
    ) as NonNullable<ReviewProvider["getInterPatchsetDiff"]>;

    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));
    await orch.runReview(initial.taskId);

    const prompt = runner.runReviewInDocker.mock.calls[0]?.[1]?.prompt as string;
    expect(prompt).not.toContain("## Changes since last reviewed patchset");
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
    runner.applyPriorPatchset.mockRejectedValueOnce(new Error("git fetch failed"));

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

describe("ReviewOrchestrator.runReview - discussion replies", () => {
  function makeThread(overrides: Partial<ReviewDiscussionThread> = {}): ReviewDiscussionThread {
    return {
      threadId: "disc-1",
      file: "src/a.ts",
      line: 1,
      resolved: false,
      comments: [{ author: "alice", message: "Why this?", isOwn: false }],
      ...overrides,
    };
  }

  function rawWithReplies(
    replies: Array<{ threadId: string; message: string }>,
    opts: { comments?: unknown[]; summary?: string; score?: number } = {}
  ): string {
    return [
      "REVIEW_RESULT_START",
      JSON.stringify({
        comments: opts.comments ?? [],
        summary: opts.summary ?? "",
        score: opts.score ?? 0,
        replies,
      }),
      "REVIEW_RESULT_END",
    ].join("\n");
  }

  function withThreads(
    mocks: ReturnType<typeof makeMocks>,
    threads: ReviewDiscussionThread[]
  ): ReturnType<typeof vi.fn> {
    mocks.provider.getDiscussionThreads = vi.fn(async () => threads);
    const postThreadReply = vi.fn(async () => undefined);
    mocks.provider.postThreadReply = postThreadReply;
    return postThreadReply;
  }

  it("posts a reply for an eligible thread and records it in the ledger", async () => {
    const initial = makeTask({ state: "REVIEW_PENDING" });
    const mocks = makeMocks(initial);
    const postThreadReply = withThreads(mocks, [makeThread()]);
    const { runner } = makeWorkspaceRunner(
      rawWithReplies([{ threadId: "disc-1", message: "Good catch, fixed." }])
    );
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));

    await orch.runReview(initial.taskId);

    expect(postThreadReply).toHaveBeenCalledWith(CHANGE_ID, 2, "disc-1", "Good catch, fixed.");
    const handledHash = computeThreadReplyHash({
      threadId: "disc-1",
      author: "alice",
      message: "Why this?",
    });
    expect(mocks.store.markThreadReplyPosted).toHaveBeenCalledWith(initial.taskId, CHANGE_ID, [
      { threadId: "disc-1", handledCommentHash: handledHash, replyMessage: "Good catch, fixed." },
    ]);
  });

  it("does not reply to a resolved thread", async () => {
    const initial = makeTask({ state: "REVIEW_PENDING" });
    const mocks = makeMocks(initial);
    const postThreadReply = withThreads(mocks, [makeThread({ resolved: true })]);
    const { runner } = makeWorkspaceRunner(rawWithReplies([{ threadId: "disc-1", message: "x" }]));
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));

    await orch.runReview(initial.taskId);

    expect(postThreadReply).not.toHaveBeenCalled();
    expect(mocks.store.markThreadReplyPosted).not.toHaveBeenCalled();
  });

  it("does not reply to a thread that has only VE's own comments", async () => {
    const initial = makeTask({ state: "REVIEW_PENDING" });
    const mocks = makeMocks(initial);
    const postThreadReply = withThreads(mocks, [
      makeThread({ comments: [{ author: "ve-bot", message: "mine", isOwn: true }] }),
    ]);
    const { runner } = makeWorkspaceRunner(rawWithReplies([{ threadId: "disc-1", message: "x" }]));
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));

    await orch.runReview(initial.taskId);

    expect(postThreadReply).not.toHaveBeenCalled();
  });

  it("does not reply again when the latest human message was already answered", async () => {
    const initial = makeTask({ state: "REVIEW_PENDING" });
    const mocks = makeMocks(initial);
    const handledHash = computeThreadReplyHash({
      threadId: "disc-1",
      author: "alice",
      message: "Why this?",
    });
    (mocks.store.getHandledThreadReplyHashes as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Set([handledHash])
    );
    const postThreadReply = withThreads(mocks, [makeThread()]);
    const { runner } = makeWorkspaceRunner(rawWithReplies([{ threadId: "disc-1", message: "x" }]));
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));

    await orch.runReview(initial.taskId);

    expect(postThreadReply).not.toHaveBeenCalled();
  });

  it("drops replies that reference an unknown (hallucinated) threadId", async () => {
    const initial = makeTask({ state: "REVIEW_PENDING" });
    const mocks = makeMocks(initial);
    const postThreadReply = withThreads(mocks, [makeThread()]);
    const { runner } = makeWorkspaceRunner(
      rawWithReplies([{ threadId: "ghost-thread", message: "x" }])
    );
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));

    await orch.runReview(initial.taskId);

    expect(postThreadReply).not.toHaveBeenCalled();
  });

  it("drops replies with an empty body", async () => {
    const initial = makeTask({ state: "REVIEW_PENDING" });
    const mocks = makeMocks(initial);
    const postThreadReply = withThreads(mocks, [makeThread()]);
    const { runner } = makeWorkspaceRunner(rawWithReplies([{ threadId: "disc-1", message: "   " }]));
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));

    await orch.runReview(initial.taskId);

    expect(postThreadReply).not.toHaveBeenCalled();
  });

  it("caps the number of replies at maxReviewReplies", async () => {
    const initial = makeTask({ state: "REVIEW_PENDING" });
    const mocks = makeMocks(initial);
    const threads: ReviewDiscussionThread[] = [
      makeThread({ threadId: "disc-1", comments: [{ author: "a", message: "q1", isOwn: false }] }),
      makeThread({ threadId: "disc-2", comments: [{ author: "b", message: "q2", isOwn: false }] }),
      makeThread({ threadId: "disc-3", comments: [{ author: "c", message: "q3", isOwn: false }] }),
    ];
    const postThreadReply = withThreads(mocks, threads);
    const { runner } = makeWorkspaceRunner(
      rawWithReplies([
        { threadId: "disc-1", message: "r1" },
        { threadId: "disc-2", message: "r2" },
        { threadId: "disc-3", message: "r3" },
      ])
    );
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner, { maxReviewReplies: 2 }));

    await orch.runReview(initial.taskId);

    expect(postThreadReply).toHaveBeenCalledTimes(2);
  });

  it("posts a pending reply even on a re-review with an unchanged verdict", async () => {
    const initial = makeTask({ state: "REVIEW_WATCHING", cycleCount: 1 });
    const mocks = makeMocks(initial);
    // The lone inline comment is already on record and the prior vote matches,
    // so the summary/vote path would normally be skipped - but a pending reply
    // must still be delivered.
    const knownHash = computeCommentHash({ file: "src/a.ts", message: "Bug" });
    (mocks.store.getPostedReviewCommentHashes as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Set([knownHash])
    );
    (mocks.store.getAgentCycles as ReturnType<typeof vi.fn>).mockResolvedValue([
      { result: { metadata: { vote: -1 } } },
    ]);
    const postThreadReply = withThreads(mocks, [makeThread()]);
    const { runner } = makeWorkspaceRunner(
      rawWithReplies([{ threadId: "disc-1", message: "Replying here." }], {
        comments: [{ file: "src/a.ts", line: 1, message: "Bug", severity: "error" }],
        summary: "blocking",
        score: -1,
      })
    );
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));

    await orch.runReview(initial.taskId);

    expect(postThreadReply).toHaveBeenCalledWith(CHANGE_ID, 2, "disc-1", "Replying here.");
    expect(mocks.store.markThreadReplyPosted).toHaveBeenCalledOnce();
    // The verdict (summary + vote) is unchanged, so it must NOT be re-posted just
    // because a reply was delivered — replies and the verdict are decoupled.
    expect(mocks.provider.postReviewComments).not.toHaveBeenCalled();
    expect(mocks.provider.vote).not.toHaveBeenCalled();
  });

  it("re-posts the verdict alongside a reply when a genuinely new finding exists", async () => {
    const initial = makeTask({ state: "REVIEW_WATCHING", cycleCount: 1 });
    const mocks = makeMocks(initial);
    // Prior vote was 0; this pass surfaces a new blocking comment, so the
    // verdict genuinely changed and must be posted even though a reply also goes out.
    (mocks.store.getAgentCycles as ReturnType<typeof vi.fn>).mockResolvedValue([
      { result: { metadata: { vote: 0 } } },
    ]);
    const postThreadReply = withThreads(mocks, [makeThread()]);
    const { runner } = makeWorkspaceRunner(
      rawWithReplies([{ threadId: "disc-1", message: "Replying here." }], {
        comments: [{ file: "src/a.ts", line: 1, message: "Brand new bug", severity: "error" }],
        summary: "blocking",
        score: -1,
      })
    );
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));

    await orch.runReview(initial.taskId);

    expect(postThreadReply).toHaveBeenCalledOnce();
    // A new finding → the verdict IS posted.
    expect(mocks.provider.vote).toHaveBeenCalledWith(CHANGE_ID, 2, -1, "blocking");
  });

  it("ignores discussion threads when the provider lacks thread support", async () => {
    const initial = makeTask({ state: "REVIEW_PENDING" });
    const mocks = makeMocks(initial);
    // Provider has no getDiscussionThreads / postThreadReply (the default).
    const { runner } = makeWorkspaceRunner(rawWithReplies([{ threadId: "disc-1", message: "x" }]));
    const orch = new ReviewOrchestrator(makeDeps(mocks, runner));

    await orch.runReview(initial.taskId);

    expect(mocks.store.getHandledThreadReplyHashes).not.toHaveBeenCalled();
    expect(mocks.store.markThreadReplyPosted).not.toHaveBeenCalled();
  });
});

describe("Unused symbols import sanity check", () => {
  it("exposes ReviewOrchestrator type", () => {
    const _orch: ReviewOrchestrator | undefined = undefined;
    expect(_orch).toBeUndefined();
  });
});
