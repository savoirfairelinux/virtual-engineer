import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Integration } from "../../src/interfaces.js";

const { logger } = vi.hoisted(() => ({
  logger: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock("../../src/logger.js", () => ({
  getLogger: vi.fn(() => logger),
}));

import {
  GerritStreamEventsManager,
  type GerritStreamOrchestrator,
  type GerritStreamReviewTrigger,
} from "../../src/connectors/gerritStreamEvents.js";

// ─── Fakes ────────────────────────────────────────────────────────────────────

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn((signal?: NodeJS.Signals | number) => {
    this.emit("close", null, typeof signal === "string" ? signal : null);
    return true;
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const VE_SSH_USER = "ve";

function makeIntegration(id: string, overrides: Partial<Integration> = {}): Integration {
  return {
    id,
    provider: "gerrit",
    name: id,
    configJson: JSON.stringify({
      sshHost: "gerrit.example.com",
      sshPort: 29418,
      sshUser: VE_SSH_USER,
      // Resolved key path injected by preprocessConfig (generated-key mode).
      _resolvedSshKeyPath: "/tmp/id_rsa",
    }),
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * Build an sshQueryFn mock that dispatches by query shape:
 *  - `--all-reviewers` (reviewer-check) → NDJSON with `allReviewers`
 *  - `status:open reviewer:<user>` (backfill) → empty NDJSON (by default)
 *
 * Pass `backfillChangeIds` to make backfill return specific change IDs.
 */
function makeSshReviewerQueryFn(reviewerUsernames: string[], backfillChangeIds: string[] = []) {
  const reviewerNdjson = [
    JSON.stringify({ number: 1, allReviewers: reviewerUsernames.map((u) => ({ username: u, name: u })) }),
    JSON.stringify({ type: "stats", rowCount: 1, runTimeMilliseconds: 1 }),
  ].join("\n");
  const backfillNdjson = [
    ...backfillChangeIds.map((id) => JSON.stringify({ id, number: 1 })),
    JSON.stringify({ type: "stats", rowCount: backfillChangeIds.length, runTimeMilliseconds: 1 }),
  ].join("\n");
  return vi.fn(async (args: string[], _config: Record<string, unknown>) => {
    if (args.includes("--all-reviewers")) return reviewerNdjson;
    return backfillNdjson;
  });
}

/** Count sshQueryFn calls that match the `--all-reviewers` reviewer-check query. */
function countReviewerChecks(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter((call) => Array.isArray(call[0]) && (call[0] as string[]).includes("--all-reviewers")).length;
}

/** Count sshQueryFn calls that match the `status:open reviewer:<user>` backfill query. */
function countBackfillQueries(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter((call) => Array.isArray(call[0]) && (call[0] as string[]).some((a) => typeof a === "string" && a.startsWith("status:open reviewer:"))).length;
}

function createManager(
  children: FakeChildProcess[],
  sshQueryFn?: (args: string[], config: Record<string, unknown>) => Promise<string>
) {
  const orchestrator: GerritStreamOrchestrator = {
    triggerFeedbackForChange: vi.fn(async () => {}),
    markChangeMerged: vi.fn(async () => {}),
    markChangeAbandoned: vi.fn(async () => {}),
  };
  const reviewTrigger: GerritStreamReviewTrigger = {
    triggerReviewForChange: vi.fn(async () => {}),
  };
  const spawnProcess = vi.fn(() => {
    const child = children.shift();
    if (!child) throw new Error("No fake child process left for spawn");
    return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
  });

  type SshQueryFnType = (args: string[], config: { sshHost: string; sshPort: number; sshUser: string; sshKeyPath?: string | undefined }) => Promise<string>;

  const manager = new GerritStreamEventsManager({
    orchestrator,
    getReviewTrigger: () => reviewTrigger,
    reconnectDelayMs: 50,
    spawnProcess: spawnProcess as typeof import("node:child_process").spawn,
    ...(sshQueryFn !== undefined ? { sshQueryFn: sshQueryFn as SshQueryFnType } : {}),
  });

  return { manager, orchestrator, reviewTrigger, spawnProcess };
}

async function flushAsyncWork(): Promise<void> {
  // setImmediate fires after all pending microtasks are drained, which is
  // necessary because queryVeIsReviewer adds extra async hops via sshQueryFn.
  await new Promise<void>((resolve) => setImmediate(resolve));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GerritStreamEventsManager", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("state is 'connecting' after spawn and only transitions to 'connected' on first stdout data", async () => {
    const child = new FakeChildProcess();
    const { manager } = createManager([child]);

    await manager.reconcile([makeIntegration("gerrit-a")]);

    // Before spawn: connecting
    expect(manager.getStatus("gerrit-a")).toEqual(expect.objectContaining({ state: "connecting" }));

    // After spawn: still connecting (SSH process started, handshake not yet complete)
    child.emit("spawn");
    expect(manager.getStatus("gerrit-a")).toEqual(expect.objectContaining({ state: "connecting" }));

    // After first stdout byte: now connected
    child.stdout.write(JSON.stringify({ type: "change-merged", change: { id: "I1" } }) + "\n");
    await flushAsyncWork();
    expect(manager.getStatus("gerrit-a")).toEqual(expect.objectContaining({ state: "connected" }));

    // Second event does not change state (idempotent)
    child.stdout.write(JSON.stringify({ type: "change-merged", change: { id: "I2" } }) + "\n");
    await flushAsyncWork();
    expect(manager.getStatus("gerrit-a")).toEqual(expect.objectContaining({ state: "connected" }));
  });

  it("SSH spawn args include BatchMode=yes and ConnectTimeout=30", async () => {
    const child = new FakeChildProcess();
    const { manager, spawnProcess } = createManager([child]);

    await manager.reconcile([makeIntegration("gerrit-a")]);

    expect(spawnProcess).toHaveBeenCalledWith(
      "ssh",
      expect.arrayContaining(["BatchMode=yes", expect.stringMatching(/^ConnectTimeout=/)]),
      expect.anything()
    );
  });

  it("logs every JSON event payload at info level when it arrives", async () => {
    const child = new FakeChildProcess();
    const { manager } = createManager([child]);

    await manager.reconcile([makeIntegration("gerrit-a")]);
    child.emit("spawn");
    logger.info.mockClear();

    child.stdout.write(JSON.stringify({ type: "comment-added", change: { id: "Icomment" } }) + "\n");
    await flushAsyncWork();

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationId: "gerrit-a",
        integrationName: "gerrit-a",
        payload: expect.objectContaining({
          type: "comment-added",
          change: expect.objectContaining({ id: "Icomment" }),
        }),
      }),
      "Gerrit stream-events: raw event received"
    );
  });

  it("routes merged/abandoned events and comment-added feedback to orchestrator", async () => {
    const child = new FakeChildProcess();
    const { manager, orchestrator, reviewTrigger, spawnProcess } = createManager([child]);

    await manager.reconcile([makeIntegration("gerrit-a")]);
    expect(spawnProcess).toHaveBeenCalledTimes(1);

    child.emit("spawn");
    child.stdout.write(JSON.stringify({ type: "change-merged", change: { id: "Imerged" } }) + "\n");
    child.stdout.write(JSON.stringify({ type: "change-abandoned", change: { id: "Iabandoned" } }) + "\n");
    child.stdout.write(JSON.stringify({ type: "comment-added", change: { id: "Icomment" } }) + "\n");
    await flushAsyncWork();

    expect(orchestrator.markChangeMerged).toHaveBeenCalledWith("gerrit-a", "Imerged");
    expect(orchestrator.markChangeAbandoned).toHaveBeenCalledWith("gerrit-a", "Iabandoned");
    expect(orchestrator.triggerFeedbackForChange).toHaveBeenCalledWith("gerrit-a", "Icomment");
    // No review triggers for any of the above
    expect(reviewTrigger.triggerReviewForChange).not.toHaveBeenCalled();
    expect(manager.getStatus("gerrit-a")).toEqual(expect.objectContaining({
      state: "connected",
      lastEventType: "comment-added",
    }));
  });

  it("comment-added: injects stream-event comment payload into triggerFeedbackForChange", async () => {
    // Regression: Gerrit `gerrit query --comments` does not reliably return
    // top-level change messages, so the stream event payload is the authoritative
    // source of feedback text for comment-added events.
    const child = new FakeChildProcess();
    const { manager, orchestrator } = createManager([child]);

    await manager.reconcile([makeIntegration("gerrit-a")]);
    child.emit("spawn");

    child.stdout.write(
      JSON.stringify({
        type: "comment-added",
        change: { id: "Ireview" },
        author: { username: "alice", email: "alice@example.com" },
        comment: "Patch Set 1:\n\nPlease add documentation for each function",
        eventCreatedOn: 1710000500,
      }) + "\n"
    );
    await flushAsyncWork();

    expect(orchestrator.triggerFeedbackForChange).toHaveBeenCalledWith(
      "gerrit-a",
      "Ireview",
      [expect.objectContaining({
        id: "gerrit-msg-1710000500",
        author: "alice@example.com",
        message: "Please add documentation for each function",
        unresolved: true,
      })]
    );
  });

  it("comment-added: skips stream-event comment authored by VE itself", async () => {
    const child = new FakeChildProcess();
    const { manager, orchestrator } = createManager([child]);

    await manager.reconcile([makeIntegration("gerrit-a")]);
    child.emit("spawn");

    child.stdout.write(
      JSON.stringify({
        type: "comment-added",
        change: { id: "Iself" },
        author: { username: VE_SSH_USER },
        comment: "Patch Set 1:\n\nUploaded a fix",
        eventCreatedOn: 1710000600,
      }) + "\n"
    );
    await flushAsyncWork();

    // Falls through to 2-arg call (no stream comments injected)
    expect(orchestrator.triggerFeedbackForChange).toHaveBeenCalledWith("gerrit-a", "Iself");
  });

  it("comment-added: skips CI build-bot and vote-only stream comments", async () => {
    const child = new FakeChildProcess();
    const { manager, orchestrator } = createManager([child]);

    await manager.reconcile([makeIntegration("gerrit-a")]);
    child.emit("spawn");

    child.stdout.write(
      JSON.stringify({
        type: "comment-added",
        change: { id: "Ici" },
        author: { username: "jenkins", email: "jenkins@ci.test" },
        comment: "Patch Set 1:  Build Started https://jenkins.test/job/x/1/ (1/4)",
        eventCreatedOn: 1710000700,
      }) + "\n"
    );
    child.stdout.write(
      JSON.stringify({
        type: "comment-added",
        change: { id: "Ivote" },
        author: { username: "alice", email: "alice@example.com" },
        comment: "Patch Set 2: Code-Review+2",
        eventCreatedOn: 1710000800,
      }) + "\n"
    );
    await flushAsyncWork();

    // Both fall through to the 2-arg call: no stream comment injected → no feedback.
    expect(orchestrator.triggerFeedbackForChange).toHaveBeenCalledWith("gerrit-a", "Ici");
    expect(orchestrator.triggerFeedbackForChange).toHaveBeenCalledWith("gerrit-a", "Ivote");
    expect(orchestrator.triggerFeedbackForChange).not.toHaveBeenCalledWith(
      "gerrit-a",
      expect.any(String),
      expect.arrayContaining([expect.objectContaining({ author: "jenkins@ci.test" })])
    );
  });

  it("comment-added: surfaces a Build Failed stream comment tagged with ci-failure- id (not dropped as noise)", async () => {
    const child = new FakeChildProcess();
    const { manager, orchestrator } = createManager([child]);

    await manager.reconcile([makeIntegration("gerrit-a")]);
    child.emit("spawn");

    child.stdout.write(
      JSON.stringify({
        type: "comment-added",
        change: { id: "Ifailed" },
        author: { username: "jenkins", email: "jenkins@ci.test" },
        comment: "Patch Set 1: Verified-1\n\nBuild Failed\n\nhttps://jenkins.test/job/x/1/ : FAILURE",
        eventCreatedOn: 1710000900,
      }) + "\n"
    );
    await flushAsyncWork();

    expect(orchestrator.triggerFeedbackForChange).toHaveBeenCalledWith(
      "gerrit-a",
      "Ifailed",
      [expect.objectContaining({ id: expect.stringMatching(/^ci-failure-/) })]
    );
  });

  it("starts and stops one listener per active Gerrit integration", async () => {
    const childA = new FakeChildProcess();
    const childB = new FakeChildProcess();
    const { manager, spawnProcess } = createManager([childA, childB]);

    await manager.reconcile([makeIntegration("gerrit-a"), makeIntegration("gerrit-b")]);
    expect(spawnProcess).toHaveBeenCalledTimes(2);

    childA.emit("spawn");
    childB.emit("spawn");
    await manager.reconcile([makeIntegration("gerrit-a")]);

    expect(childB.kill).toHaveBeenCalledWith("SIGTERM");
    expect(manager.getStatus("gerrit-b")).toBeNull();
    expect(manager.getStatus("gerrit-a")).toEqual(expect.objectContaining({ state: "connecting" }));
  });

  it("reconnects after an unexpected disconnect", async () => {
    vi.useFakeTimers();

    const firstChild = new FakeChildProcess();
    const secondChild = new FakeChildProcess();
    const { manager, spawnProcess } = createManager([firstChild, secondChild]);

    await manager.reconcile([makeIntegration("gerrit-a")]);
    firstChild.emit("spawn");
    firstChild.emit("close", 255, null);

    expect(manager.getStatus("gerrit-a")).toEqual(expect.objectContaining({
      state: "reconnecting",
      reconnectCount: 1,
    }));

    await vi.advanceTimersByTimeAsync(50);
    expect(spawnProcess).toHaveBeenCalledTimes(2);

    secondChild.emit("spawn");
    expect(manager.getStatus("gerrit-a")).toEqual(expect.objectContaining({
      state: "connecting",
      reconnectCount: 1,
    }));
  });

  // ── reviewer-added ──────────────────────────────────────────────────────────

  it("reviewer-added: triggers review when VE itself is added as reviewer", async () => {
    const child = new FakeChildProcess();
    const { manager, orchestrator, reviewTrigger } = createManager([child]);

    await manager.reconcile([makeIntegration("gerrit-a")]);
    child.emit("spawn");

    child.stdout.write(
      JSON.stringify({
        type: "reviewer-added",
        change: { id: "Ichange" },
        reviewer: { username: VE_SSH_USER, name: "Virtual Engineer" },
      }) + "\n"
    );
    await flushAsyncWork();

    expect(orchestrator.triggerFeedbackForChange).toHaveBeenCalledWith("gerrit-a", "Ichange");
    expect(reviewTrigger.triggerReviewForChange).toHaveBeenCalledTimes(1);
    // Re-adding VE as a reviewer is a manual relaunch → force a fresh review.
    expect(reviewTrigger.triggerReviewForChange).toHaveBeenCalledWith("gerrit-a", "Ichange", { force: true });
  });

  it("reviewer-added: does NOT trigger review when a different user is added", async () => {
    const child = new FakeChildProcess();
    const { manager, orchestrator, reviewTrigger } = createManager([child]);

    await manager.reconcile([makeIntegration("gerrit-a")]);
    child.emit("spawn");

    child.stdout.write(
      JSON.stringify({
        type: "reviewer-added",
        change: { id: "Ichange" },
        reviewer: { username: "alice", name: "Alice" },
      }) + "\n"
    );
    await flushAsyncWork();

    expect(orchestrator.triggerFeedbackForChange).toHaveBeenCalledWith("gerrit-a", "Ichange");
    expect(reviewTrigger.triggerReviewForChange).not.toHaveBeenCalled();
  });

  it("reviewer-added: does NOT trigger review when reviewer field is absent", async () => {
    const child = new FakeChildProcess();
    const { manager, reviewTrigger } = createManager([child]);

    await manager.reconcile([makeIntegration("gerrit-a")]);
    child.emit("spawn");

    child.stdout.write(
      JSON.stringify({ type: "reviewer-added", change: { id: "Ichange" } }) + "\n"
    );
    await flushAsyncWork();

    expect(reviewTrigger.triggerReviewForChange).not.toHaveBeenCalled();
  });

  // ── patchset-created ────────────────────────────────────────────────────────

  it("patchset-created: triggers review for REWORK patchset when VE is a reviewer", async () => {
    const sshQuery = makeSshReviewerQueryFn([VE_SSH_USER, "alice"]);
    const child = new FakeChildProcess();
    const { manager, orchestrator, reviewTrigger } = createManager([child], sshQuery);

    await manager.reconcile([makeIntegration("gerrit-a")]);
    child.emit("spawn");

    child.stdout.write(
      JSON.stringify({
        type: "patchset-created",
        change: { id: "Ipatch" },
        patchSet: { kind: "REWORK", number: 3 },
      }) + "\n"
    );
    await flushAsyncWork();

    expect(orchestrator.triggerFeedbackForChange).toHaveBeenCalledWith("gerrit-a", "Ipatch");
    expect(countReviewerChecks(sshQuery)).toBe(1);
    expect(reviewTrigger.triggerReviewForChange).toHaveBeenCalledTimes(1);
    // Automatic patchset-created trigger: no force (must not re-review a patchset
    // already reviewed; a genuinely new patchset is re-reviewed on its own merit).
    expect(reviewTrigger.triggerReviewForChange).toHaveBeenCalledWith("gerrit-a", "Ipatch");
  });

  it("patchset-created: does NOT trigger review for TRIVIAL_REBASE (SSH not called)", async () => {
    const sshQuery = makeSshReviewerQueryFn([VE_SSH_USER]);
    const child = new FakeChildProcess();
    const { manager, orchestrator, reviewTrigger } = createManager([child], sshQuery);

    await manager.reconcile([makeIntegration("gerrit-a")]);
    child.emit("spawn");

    child.stdout.write(
      JSON.stringify({
        type: "patchset-created",
        change: { id: "Ipatch" },
        patchSet: { kind: "TRIVIAL_REBASE", number: 4 },
      }) + "\n"
    );
    await flushAsyncWork();

    expect(orchestrator.triggerFeedbackForChange).toHaveBeenCalledWith("gerrit-a", "Ipatch");
    expect(countReviewerChecks(sshQuery)).toBe(0);
    expect(reviewTrigger.triggerReviewForChange).not.toHaveBeenCalled();
  });

  it.each(["NO_CHANGE", "NO_CODE_CHANGE"])(
    "patchset-created: does NOT trigger review for %s kind",
    async (kind) => {
      const sshQuery = makeSshReviewerQueryFn([VE_SSH_USER]);
      const child = new FakeChildProcess();
      const { manager, reviewTrigger } = createManager([child], sshQuery);

      await manager.reconcile([makeIntegration("gerrit-a")]);
      child.emit("spawn");

      child.stdout.write(
        JSON.stringify({ type: "patchset-created", change: { id: "Ipatch" }, patchSet: { kind } }) + "\n"
      );
      await flushAsyncWork();

      expect(countReviewerChecks(sshQuery)).toBe(0);
      expect(reviewTrigger.triggerReviewForChange).not.toHaveBeenCalled();
    }
  );

  it("patchset-created: does NOT trigger review when VE is not in the reviewer list", async () => {
    const sshQuery = makeSshReviewerQueryFn(["alice", "bob"]); // VE not present
    const child = new FakeChildProcess();
    const { manager, orchestrator, reviewTrigger } = createManager([child], sshQuery);

    await manager.reconcile([makeIntegration("gerrit-a")]);
    child.emit("spawn");

    child.stdout.write(
      JSON.stringify({
        type: "patchset-created",
        change: { id: "Ipatch" },
        patchSet: { kind: "REWORK", number: 2 },
      }) + "\n"
    );
    await flushAsyncWork();

    expect(orchestrator.triggerFeedbackForChange).toHaveBeenCalledWith("gerrit-a", "Ipatch");
    expect(countReviewerChecks(sshQuery)).toBe(1);
    expect(reviewTrigger.triggerReviewForChange).not.toHaveBeenCalled();
  });

  it("patchset-created: does NOT trigger review and does NOT crash when SSH query fails", async () => {
    const failingSshQuery = vi.fn(async () => { throw new Error("SSH connection refused"); });
    const child = new FakeChildProcess();
    const { manager, orchestrator, reviewTrigger } = createManager(
      [child],
      failingSshQuery as unknown as (args: string[], config: Record<string, unknown>) => Promise<string>
    );

    await manager.reconcile([makeIntegration("gerrit-a")]);
    child.emit("spawn");

    child.stdout.write(
      JSON.stringify({
        type: "patchset-created",
        change: { id: "Ipatch" },
        patchSet: { kind: "REWORK", number: 1 },
      }) + "\n"
    );
    await flushAsyncWork();

    expect(orchestrator.triggerFeedbackForChange).toHaveBeenCalledWith("gerrit-a", "Ipatch");
    expect(reviewTrigger.triggerReviewForChange).not.toHaveBeenCalled();
    // Stream listener must still be alive
    expect(manager.getStatus("gerrit-a")).toEqual(expect.objectContaining({ state: "connected" }));
  });

  it("feedback (triggerFeedbackForChange) always fires for patchset-created and comment-added regardless of review filtering", async () => {
    // Even when review is blocked (wrong kind, not a reviewer), feedback must still be delivered
    const sshQuery = makeSshReviewerQueryFn([]); // VE not a reviewer
    const child = new FakeChildProcess();
    const { manager, orchestrator, reviewTrigger } = createManager([child], sshQuery);

    await manager.reconcile([makeIntegration("gerrit-a")]);
    child.emit("spawn");

    child.stdout.write(
      JSON.stringify({ type: "patchset-created", change: { id: "Ip1" }, patchSet: { kind: "TRIVIAL_REBASE" } }) + "\n"
    );
    child.stdout.write(
      JSON.stringify({ type: "patchset-created", change: { id: "Ip2" }, patchSet: { kind: "REWORK" } }) + "\n"
    );
    child.stdout.write(
      JSON.stringify({ type: "comment-added", change: { id: "Ic" } }) + "\n"
    );
    await flushAsyncWork();

    expect(orchestrator.triggerFeedbackForChange).toHaveBeenCalledTimes(3);
    expect(orchestrator.triggerFeedbackForChange).toHaveBeenCalledWith("gerrit-a", "Ip1");
    expect(orchestrator.triggerFeedbackForChange).toHaveBeenCalledWith("gerrit-a", "Ip2");
    expect(orchestrator.triggerFeedbackForChange).toHaveBeenCalledWith("gerrit-a", "Ic");
    expect(reviewTrigger.triggerReviewForChange).not.toHaveBeenCalled();
  });

  it("orchestrator errors during event processing are caught and logged — listener stays alive and does not cause an unhandled rejection", async () => {
    const child = new FakeChildProcess();
    const { manager, orchestrator } = createManager([child]);

    // Simulate an agent timeout propagating back through triggerFeedbackForChange
    (orchestrator.triggerFeedbackForChange as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Agent timed out after 600000ms")
    );

    await manager.reconcile([makeIntegration("gerrit-a")]);
    child.emit("spawn");
    child.stdout.write(JSON.stringify({ type: "comment-added", change: { id: "Ifail" } }) + "\n");
    await flushAsyncWork();

    // The error must be logged — not thrown as an unhandled rejection
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ integrationId: "gerrit-a" }),
      "error processing Gerrit stream event"
    );
    // The listener must still be alive after the error
    expect(manager.getStatus("gerrit-a")).toEqual(expect.objectContaining({ state: "connected" }));
  });

  it("event processing continues after a failed event — subsequent events are still dispatched", async () => {
    const child = new FakeChildProcess();
    const { manager, orchestrator } = createManager([child]);

    const callOrder: string[] = [];
    (orchestrator.triggerFeedbackForChange as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("first call fails"))
      .mockImplementation(async () => { callOrder.push("ok"); });

    await manager.reconcile([makeIntegration("gerrit-a")]);
    child.emit("spawn");

    child.stdout.write(
      JSON.stringify({ type: "comment-added", change: { id: "Ifail" } }) + "\n" +
      JSON.stringify({ type: "comment-added", change: { id: "Iok" } }) + "\n"
    );
    await flushAsyncWork();

    // First call fails (logged), second call succeeds
    expect(logger.error).toHaveBeenCalledOnce();
    expect(callOrder).toEqual(["ok"]);
  });

  // ── serialized event processing ─────────────────────────────────────────────

  it("serializes event processing: reviewer-added + patchset-created in same chunk do not race", async () => {
    // Simulate SSH buffering: both events arrive in one TCP chunk.
    // Before the fix, both would be processed concurrently (fire-and-forget),
    // and the patchset-created handler's queryVeIsReviewer would see VE as
    // already added, triggering a second review concurrently.
    //
    // With serialized processing, reviewer-added runs and completes first,
    // then patchset-created runs. Both trigger reviews, but sequentially —
    // allowing the orchestrator to deduplicate the second call.
    const sshQuery = makeSshReviewerQueryFn([VE_SSH_USER]);
    const child = new FakeChildProcess();
    const { manager, reviewTrigger } = createManager([child], sshQuery);

    // Track call order to verify serialization (not concurrent).
    const callOrder: string[] = [];
    (reviewTrigger.triggerReviewForChange as ReturnType<typeof vi.fn>).mockImplementation(
      async () => { callOrder.push("review"); }
    );

    await manager.reconcile([makeIntegration("gerrit-a")]);
    child.emit("spawn");

    // Write both events in a single chunk — they arrive together.
    child.stdout.write(
      JSON.stringify({
        type: "reviewer-added",
        change: { id: "Isame" },
        reviewer: { username: VE_SSH_USER, name: "Virtual Engineer" },
      }) + "\n" +
      JSON.stringify({
        type: "patchset-created",
        change: { id: "Isame" },
        patchSet: { kind: "REWORK", number: 1 },
      }) + "\n"
    );
    await flushAsyncWork();

    // Both events trigger review calls, but they are sequential (not concurrent).
    expect(reviewTrigger.triggerReviewForChange).toHaveBeenCalledTimes(2);
    expect(callOrder).toEqual(["review", "review"]);
  });

  describe("backfill on first stream-events connect", () => {
    it("queries open reviews assigned to VE and triggers review for each on first connect", async () => {
      const sshQuery = makeSshReviewerQueryFn([], ["Iassigned1", "Iassigned2", "Iassigned3"]);
      const child = new FakeChildProcess();
      const { manager, reviewTrigger } = createManager([child], sshQuery);

      await manager.reconcile([makeIntegration("gerrit-a")]);
      child.emit("spawn");
      child.stdout.write(JSON.stringify({ type: "change-merged", change: { id: "Iother" } }) + "\n");
      await flushAsyncWork();

      expect(countBackfillQueries(sshQuery)).toBe(1);
      expect(sshQuery.mock.calls[0]?.[0]).toEqual(["query", "--format", "JSON", `status:open reviewer:${VE_SSH_USER}`]);
      expect(reviewTrigger.triggerReviewForChange).toHaveBeenCalledTimes(3);
      expect(reviewTrigger.triggerReviewForChange).toHaveBeenCalledWith("gerrit-a", "Iassigned1");
      expect(reviewTrigger.triggerReviewForChange).toHaveBeenCalledWith("gerrit-a", "Iassigned2");
      expect(reviewTrigger.triggerReviewForChange).toHaveBeenCalledWith("gerrit-a", "Iassigned3");
    });

    it("runs at most once per integration (not on subsequent stdout chunks)", async () => {
      const sshQuery = makeSshReviewerQueryFn([], ["Ionce"]);
      const child = new FakeChildProcess();
      const { manager } = createManager([child], sshQuery);

      await manager.reconcile([makeIntegration("gerrit-a")]);
      child.emit("spawn");
      child.stdout.write(JSON.stringify({ type: "change-merged", change: { id: "I1" } }) + "\n");
      await flushAsyncWork();
      child.stdout.write(JSON.stringify({ type: "change-merged", change: { id: "I2" } }) + "\n");
      await flushAsyncWork();

      expect(countBackfillQueries(sshQuery)).toBe(1);
    });

    it("caps backfill at 20 changes and logs a warning when more are returned", async () => {
      const tooMany = Array.from({ length: 25 }, (_, i) => `Itoo${i}`);
      const sshQuery = makeSshReviewerQueryFn([], tooMany);
      const child = new FakeChildProcess();
      const { manager, reviewTrigger } = createManager([child], sshQuery);

      await manager.reconcile([makeIntegration("gerrit-a")]);
      child.emit("spawn");
      child.stdout.write(JSON.stringify({ type: "change-merged", change: { id: "Iignored" } }) + "\n");
      await flushAsyncWork();

      expect(reviewTrigger.triggerReviewForChange).toHaveBeenCalledTimes(20);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ integrationId: "gerrit-a", totalFound: 25, cap: 20 }),
        expect.stringContaining("backfill capped")
      );
    });

    it("does nothing on backfill query failure and logs a warning (does not throw)", async () => {
      const failingSshQuery = vi.fn(async (args: string[]) => {
        if (args.some((a) => a.startsWith("status:open reviewer:"))) {
          throw new Error("SSH refused");
        }
        return "";
      });
      const child = new FakeChildProcess();
      const { manager, reviewTrigger } = createManager([child], failingSshQuery);

      await manager.reconcile([makeIntegration("gerrit-a")]);
      child.emit("spawn");
      child.stdout.write(JSON.stringify({ type: "change-merged", change: { id: "Iboot" } }) + "\n");
      await flushAsyncWork();

      expect(reviewTrigger.triggerReviewForChange).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ integrationId: "gerrit-a" }),
        expect.stringContaining("backfill query failed")
      );
    });

    it("logs info and skips trigger when no open reviews are assigned", async () => {
      const sshQuery = makeSshReviewerQueryFn([], []);
      const child = new FakeChildProcess();
      const { manager, reviewTrigger } = createManager([child], sshQuery);

      await manager.reconcile([makeIntegration("gerrit-a")]);
      child.emit("spawn");
      child.stdout.write(JSON.stringify({ type: "change-merged", change: { id: "Iboot" } }) + "\n");
      await flushAsyncWork();

      expect(reviewTrigger.triggerReviewForChange).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ integrationId: "gerrit-a", sshUser: VE_SSH_USER }),
        expect.stringContaining("no assigned open reviews")
      );
    });

    it("continues backfilling remaining changes if one triggerReviewForChange throws", async () => {
      const sshQuery = makeSshReviewerQueryFn([], ["Iok1", "Ifail", "Iok2"]);
      const child = new FakeChildProcess();
      const { manager, reviewTrigger } = createManager([child], sshQuery);
      reviewTrigger.triggerReviewForChange = vi.fn(async (_intId: string, changeId: string) => {
        if (changeId === "Ifail") throw new Error("downstream boom");
      });

      await manager.reconcile([makeIntegration("gerrit-a")]);
      child.emit("spawn");
      child.stdout.write(JSON.stringify({ type: "change-merged", change: { id: "Iboot" } }) + "\n");
      await flushAsyncWork();

      expect(reviewTrigger.triggerReviewForChange).toHaveBeenCalledTimes(3);
      expect(reviewTrigger.triggerReviewForChange).toHaveBeenCalledWith("gerrit-a", "Iok2");
    });

    it("does not backfill when no reviewTrigger is configured", async () => {
      const sshQuery = makeSshReviewerQueryFn([], ["Iassigned"]);
      const child = new FakeChildProcess();
      const spawnProcess = vi.fn(() => child as unknown as ReturnType<typeof import("node:child_process").spawn>);
      type SshQueryFnType = (args: string[], config: { sshHost: string; sshPort: number; sshUser: string; sshKeyPath?: string | undefined }) => Promise<string>;
      const manager = new GerritStreamEventsManager({
        orchestrator: { triggerFeedbackForChange: vi.fn(), markChangeMerged: vi.fn(), markChangeAbandoned: vi.fn() },
        getReviewTrigger: () => undefined,
        spawnProcess: spawnProcess as unknown as typeof import("node:child_process").spawn,
        sshQueryFn: sshQuery as unknown as SshQueryFnType,
      });

      await manager.reconcile([makeIntegration("gerrit-b")]);
      child.emit("spawn");
      child.stdout.write(JSON.stringify({ type: "change-merged", change: { id: "Iboot" } }) + "\n");
      await flushAsyncWork();

      expect(countBackfillQueries(sshQuery)).toBe(0);
    });
  });
});