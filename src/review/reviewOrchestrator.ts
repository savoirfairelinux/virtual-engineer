import { randomUUID } from "node:crypto";
import { getLogger } from "../logger.js";
import {
  type AgentLogEvent,
  type AgentResult,
  type ExternalChangeId,
  type InlineReviewComment,
  type ProjectPushTargetRecord,
  type ReviewChangeDetails,
  type ReviewChangeDiff,
  type ReviewDiscussionThread,
  type ReviewProvider,
  type StateStore,
  type Task,
  type TaskId,
  type ThreadReplyRecordInput,
  type WorkspaceRunner,
  type WorkspaceHandle,
  TERMINAL_STATES,
  makeTaskId,
  makeTicketId,
} from "../interfaces.js";
import { buildReviewPrompt } from "./reviewPromptBuilder.js";
import { computeVote, parseReviewResult } from "./reviewResultParser.js";
import { filterCommentsByAllowedFiles } from "./commentFilter.js";
import { computeCommentHash, computeThreadReplyHash } from "./commentHash.js";
import { applyVolumeAndSeverityGate, buildFoldedSummary } from "./commentSeverity.js";
import { agentLogBus, pushToTaskBuffer, clearTaskEventBuffer } from "../agents/agentEventBus.js";

const log = getLogger("review-orchestrator");

/** Legacy interface implemented by `CopilotReviewAgent`. Kept for backward compatibility. */
export interface ReviewAgent {
  runReview(
    input: {
      changeId: ExternalChangeId;
      patchset: number;
      project: string;
      prompt: string;
      workingDirectory?: string | undefined;
    },
    onEvent?: ((event: { type: string; data?: unknown }) => void) | undefined,
  ): Promise<{ rawOutput: string }>;
}

export interface ReviewOrchestratorDeps {
  stateStore: Pick<
    StateStore,
    | "createReviewTask"
    | "getTask"
    | "getTaskByTicketId"
    | "transition"
    | "setReviewedPatchset"
    | "setFailureReason"
    | "incrementCycle"
    | "saveAgentCycle"
    | "getAgentCycles"
    | "findProjectsByReviewTarget"
    | "getProjectById"
    | "setTaskProjectId"
    | "updateExternalChangeId"
    | "getPostedReviewCommentHashes"
    | "getPostedReviewComments"
    | "markReviewCommentsPosted"
    | "getHandledThreadReplyHashes"
    | "markThreadReplyPosted"
  >;
  reviewProvider: ReviewProvider;
  /** Gerrit integration ID — used to look up the project via the review_target table. */
  integrationId: string;
  /** Authentication token for the agent integration (e.g. GitHub token for Copilot). */
  agentToken: string;
  /** Workspace runner — the review always runs in a Docker container. */
  workspaceRunner: WorkspaceRunner;
  /** Build the git clone URL and optional SSH key paths for the change's repository. */
  buildCloneTarget: (details: ReviewChangeDetails) => { cloneUrl: string; sshKeyPath: string | null; sshKnownHostsPath: string | null };
  /** Apply a provider-specific patchset onto the cloned workspace (e.g. Gerrit `refs/changes/…`). Omit for GitLab MR branches. */
  applyPatchset?: (handle: WorkspaceHandle, details: ReviewChangeDetails) => Promise<void>;
  /** Source label persisted on review tasks, typically `<type>:<integrationId>`. */
  sourceLabel?: string | undefined;
  /** Reviewer instructions (content of the `code-review` prompt from the DB). */
  reviewInstructions: string;
  /** System prompt for the review agent (integration-specific, e.g. `review-system-gerrit`). */
  reviewSystemPrompt: string;
  /** Model override for the agent. */
  model?: string | undefined;
  /** Maximum diff characters injected into the review prompt. Defaults to 60 000. */
  maxDiffChars?: number | undefined;
  /** Maximum number of inline comments posted per review pass. Defaults to 20. */
  maxReviewComments?: number | undefined;
  /** Maximum number of discussion-thread replies posted per review pass. Defaults to 20. */
  maxReviewReplies?: number | undefined;
  /** Minimum severity for a comment to be posted inline. Defaults to "info". */
  reviewMinSeverity?: string | undefined;
}

export interface StartReviewInput {
  changeId: ExternalChangeId;
  patchset?: number;
  project?: string;
  subject?: string;
  ownerAccountId?: string;
}

/**
 * ReviewOrchestrator drives the code-review lifecycle for a single change:
 *
 *   REVIEW_PENDING → REVIEW_RUNNING → REVIEW_COMMENTING
 *                  → REVIEW_WATCHING (if change is still open)
 *                  → REVIEW_DONE     (if merged / abandoned)
 *
 * It is intentionally agnostic of the concrete review backend (Gerrit, GitLab,
 * GitHub) and of the way the agent is executed (local CLI, Docker container,
 * remote service): both are injected as `reviewProvider` and `agent`.
 */
export class ReviewOrchestrator {
  constructor(private readonly deps: ReviewOrchestratorDeps) {}

  /**
   * Entry point used by the webhook handler. Idempotent per project: if an
   * active task already exists for a (project, change, patchset) triple, that
   * task is returned unchanged.
   *
   * Returns an array of tasks — one per VE project that covers this change.
   * Returns an empty array when the change cannot be reviewed (not OPEN, no
   * matching project, …).
   */
  async startReviewTask(input: StartReviewInput): Promise<Task[]> {
    const details = await this.deps.reviewProvider.getChangeDetails(input.changeId);
    if (details.status !== "OPEN") {
      log.info({ changeId: input.changeId, status: details.status }, "skipping review: change is not OPEN");
      return [];
    }

    const projects = await this.deps.stateStore.findProjectsByReviewTarget(
      this.deps.integrationId,
      details.project
    );
    if (projects.length === 0) {
      log.info(
        { changeId: input.changeId, integrationId: this.deps.integrationId, gerritProject: details.project },
        "skipping review: no VE project configured for this review target"
      );
      return [];
    }

    const sourceLabel = this.deps.sourceLabel ?? this.deps.reviewProvider.kind;
    const tasks: Task[] = [];

    for (const project of projects) {
      // Per-project ticketId prevents collisions when multiple projects cover the same change.
      const ticketId = makeTicketId(`${sourceLabel}:${details.changeNumber}:${project.id}`);

      const existing = await this.deps.stateStore.getTaskByTicketId(ticketId);
      if (existing && existing.taskType === "code-review" && !TERMINAL_STATES.has(existing.state)) {
        if (existing.currentPatchset === details.currentPatchset) {
          if (existing.state === "REVIEW_WATCHING") {
            // We already reviewed this patchset and are watching for a new one.
            // Do NOT push to tasks — a second runReview call on the same patchset
            // triggers a redundant agent run, a spurious `submitReview` call, and
            // the 422 "Line could not be resolved" / race-condition failures we've seen.
            log.debug(
              { taskId: existing.taskId, patchset: existing.currentPatchset },
              "review already completed for patchset — skipping re-trigger"
            );
            continue;
          }
          if (existing.state === "REVIEW_RUNNING" || existing.state === "REVIEW_COMMENTING") {
            // Review is actively in flight — skip to avoid a concurrent second pass.
            log.debug(
              { taskId: existing.taskId, state: existing.state, changeId: input.changeId },
              "review already in flight — skipping duplicate trigger"
            );
            continue;
          }
          // REVIEW_PENDING with same patchset: task was created (or manually reset)
          // but runReview has not yet run. Push so the caller will run it.
          tasks.push(existing);
          continue;
        }
        // New patchset arrived while a task is still active.
        // Always update the stored patchset number for admin-UI bookkeeping.
        if (existing.externalChangeId !== null) {
          await this.deps.stateStore.updateExternalChangeId(
            existing.taskId,
            existing.externalChangeId,
            details.currentPatchset,
            details.url
          );
        }
        if (existing.state === "REVIEW_WATCHING") {
          // Previous review completed — re-queue for a fresh review pass.
          log.info(
            { taskId: existing.taskId, oldPatchset: existing.currentPatchset, newPatchset: details.currentPatchset },
            "new patchset on watched change — re-triggering review"
          );
          tasks.push({ ...existing, currentPatchset: details.currentPatchset });
        }
        // REVIEW_PENDING / REVIEW_RUNNING: a run is already in flight.
        // runReview fetches fresh details from Gerrit, so the new patchset
        // will be picked up naturally. No second trigger needed.
        continue;
      }

      const taskId = makeTaskId(`review-${details.changeNumber}-${randomUUID().slice(0, 8)}`);
      const task = await this.deps.stateStore.createReviewTask({
        taskId,
        ticketId,
        subject: details.subject,
        description: details.description,
        sourceLabel,
        changeId: input.changeId,
        patchset: details.currentPatchset,
        reviewUrl: details.url,
        displayId: String(details.changeNumber),
      });
      await this.deps.stateStore.setTaskProjectId(task.taskId, project.id);
      log.info({ taskId, changeId: input.changeId, patchset: details.currentPatchset, projectId: project.id }, "code-review task created");
      tasks.push({ ...task, projectId: project.id });
    }

    return tasks;
  }

  /**
   * Run a single review pass against the given task. Performs the full
   * REVIEW_PENDING → ... → REVIEW_WATCHING / REVIEW_DONE transition.
   */
  async runReview(taskId: TaskId): Promise<void> {
    const task = await this.deps.stateStore.getTask(taskId);
    if (!task) throw new Error(`Review task not found: ${taskId}`);
    if (task.taskType !== "code-review") {
      throw new Error(`Task ${taskId} is not a code-review task`);
    }
    if (task.externalChangeId === null) {
      throw new Error(`Review task ${taskId} has no change id`);
    }

    // Guard against calling runReview on terminal or otherwise non-resumable
    // states (e.g. REVIEW_DONE, REVIEW_FAILED, FAILED). Attempting transitions
    // from these states would throw InvalidTransitionError from the state
    // machine and leave the task in a confusing error state.
    const VALID_ENTRY_STATES = new Set(["REVIEW_PENDING", "REVIEW_WATCHING", "REVIEW_RUNNING"]);
    if (TERMINAL_STATES.has(task.state) || !VALID_ENTRY_STATES.has(task.state)) {
      throw new Error(
        `runReview called on task in non-resumable state: ${task.state} (taskId: ${taskId})`
      );
    }

    const changeId = task.externalChangeId;

    // Keep task.cycleCount in sync with persisted review cycles.
    const cycleNumber = await this.deps.stateStore.incrementCycle(taskId);

    // Collected agent log events for persistence.
    const collectedEvents: AgentLogEvent[] = [];

    const emitReviewEvent = (type: string, data: Record<string, unknown> = {}): void => {
      const event: AgentLogEvent = {
        type,
        timestamp: new Date().toISOString(),
        data,
        taskId,
        cycleNumber,
      };
      collectedEvents.push(event);
      pushToTaskBuffer(event);
      agentLogBus.emit("event", event);
    };

    try {
      // Allow re-runs from REVIEW_WATCHING by transitioning back to RUNNING.
      if (task.state === "REVIEW_WATCHING" || task.state === "REVIEW_PENDING") {
        await this.deps.stateStore.transition(taskId, "REVIEW_RUNNING");
      }

      emitReviewEvent("review.started", { changeId, patchset: task.currentPatchset, cycleNumber });

      const details = await this.deps.reviewProvider.getChangeDetails(changeId);
      const diff = await this.deps.reviewProvider.getChangeDiff(changeId, details.currentPatchset);

      // Resolve the VE project directly from the task (set by startReviewTask).
      const project = task.projectId
        ? await this.deps.stateStore.getProjectById(task.projectId)
        : null;
      if (!project) {
        throw new Error(
          `No VE project linked to review task "${taskId}". ` +
          `Ensure startReviewTask was called before runReview.`
        );
      }

      const { cloneUrl, sshKeyPath, sshKnownHostsPath } = this.deps.buildCloneTarget(details);
      const cloneTarget: ProjectPushTargetRecord = {
        id: -1,
        projectId: project.id,
        integrationId: this.deps.integrationId,
        repoKey: details.project,
        cloneUrl,
        targetBranch: details.targetBranch,
        role: "primary",
        commitOrder: 1,
        localPath: ".",
        sshKeyPath,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Feed comments VE already posted on this change back into the
      // prompt so the agent does not re-raise points it has already made.
      const priorComments = await this.deps.stateStore.getPostedReviewComments(taskId);

      // Fetch open human discussion threads so the agent can reply. Guarded:
      // providers without thread support skip this entirely. A thread is
      // eligible when it is unresolved, has at least one human (non-own)
      // comment, and the latest human message has not already been answered
      // (tracked by the reply ledger).
      const threadById = new Map<string, { thread: ReviewDiscussionThread; handledHash: string }>();
      const eligibleThreads: ReviewDiscussionThread[] = [];
      const threadsSupported =
        typeof this.deps.reviewProvider.getDiscussionThreads === "function" &&
        typeof this.deps.reviewProvider.postThreadReply === "function";
      if (threadsSupported && this.deps.reviewProvider.getDiscussionThreads !== undefined) {
        try {
          const handledHashes = await this.deps.stateStore.getHandledThreadReplyHashes(taskId);
          const allThreads = await this.deps.reviewProvider.getDiscussionThreads(changeId);
          for (const thread of allThreads) {
            if (thread.resolved) continue;
            const lastHuman = [...thread.comments].reverse().find((c) => !c.isOwn);
            if (lastHuman === undefined) continue;
            const handledHash = computeThreadReplyHash({
              threadId: thread.threadId,
              author: lastHuman.author,
              message: lastHuman.message,
            });
            if (handledHashes.has(handledHash)) continue;
            eligibleThreads.push(thread);
            threadById.set(thread.threadId, { thread, handledHash });
          }
        } catch (err) {
          log.warn({ err, taskId }, "failed to fetch discussion threads; continuing without replies");
        }
      }

      const prompt = buildReviewPrompt({
        details,
        diff,
        userPrompt: this.deps.reviewInstructions,
        ...(priorComments.length > 0
          ? {
              priorComments: priorComments.map((c) => ({
                file: c.file,
                line: c.line,
                message: c.message,
              })),
            }
          : {}),
        ...(eligibleThreads.length > 0 ? { discussionThreads: eligibleThreads } : {}),
        ...(this.deps.maxDiffChars !== undefined ? { maxDiffChars: this.deps.maxDiffChars } : {}),
      });

      emitReviewEvent("review.prompt_built", { promptLength: prompt.length, patchset: details.currentPatchset });

      if (this.deps.workspaceRunner.prepareProjectWorkspace === undefined) {
        throw new Error(
          "workspaceRunner does not support prepareProjectWorkspace — cannot clone repository for review."
        );
      }

      if (this.deps.workspaceRunner.runReviewInDocker === undefined) {
        throw new Error(
          "workspaceRunner does not support runReviewInDocker — Docker review execution is required."
        );
      }

      let handle: WorkspaceHandle | undefined;
      let rawOutput: string;

      try {
        handle = await this.deps.workspaceRunner.createWorkspace(taskId);

        const cloneResult = await this.deps.workspaceRunner.prepareProjectWorkspace(
          handle,
          [cloneTarget],
          project.postCloneScript || undefined,
          sshKnownHostsPath ?? undefined
        );
        if (!cloneResult.success) {
          throw new Error(`Repository clone failed: ${cloneResult.error ?? "unknown error"}`);
        }

        if (this.deps.applyPatchset !== undefined) {
          await this.deps.applyPatchset(handle, details);
        }

        emitReviewEvent("review.agent_started", { mode: "docker" });

        const stderrLineBuffer = { partial: "" };
        const reviewResult = await this.deps.workspaceRunner.runReviewInDocker(handle, {
          changeId,
          revisionNumber: details.changeNumber,
          patchset: details.currentPatchset,
          repositoryName: details.project,
          prompt,
          systemPrompt: this.deps.reviewSystemPrompt,
          agentToken: this.deps.agentToken,
          model: this.deps.model,
        }, {
          onStderrChunk: (chunk: string) => {
            stderrLineBuffer.partial += chunk;
            const lines = stderrLineBuffer.partial.split("\n");
            stderrLineBuffer.partial = lines.pop() ?? "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              this.processReviewStderrLine(trimmed, taskId, cycleNumber, collectedEvents);
            }
          },
        });
        if (stderrLineBuffer.partial.trim()) {
          this.processReviewStderrLine(stderrLineBuffer.partial.trim(), taskId, cycleNumber, collectedEvents);
        }
        rawOutput = reviewResult.rawOutput;
      } finally {
        if (handle !== undefined) {
          await this.deps.workspaceRunner.destroyWorkspace(handle).catch((err: unknown) =>
            log.warn({ err, taskId }, "failed to destroy review workspace")
          );
        }
      }

      emitReviewEvent("review.agent_completed", { outputLength: rawOutput.length });
      emitReviewEvent("review.parsing", {});

      const result = parseReviewResult(rawOutput);
      const vote = computeVote(result);

      // Fetch fresh details before posting to get the latest patchset.
      // This ensures we post the review on the latest patchset if a new one
      // was uploaded while the agent was running, preventing duplicate reviews
      // on older patchsets.
      const latestDetails = await this.deps.reviewProvider.getChangeDetails(changeId);
      const reviewPatchset = latestDetails.currentPatchset;

      // Deduplicate inline comments against ones VE already posted on
      // this change. Only newly-found issues are published; the overall vote and
      // summary still reflect the full result.
      const postedHashes = await this.deps.stateStore.getPostedReviewCommentHashes(taskId);
      const newComments = result.comments.filter(
        (c) => !postedHashes.has(computeCommentHash(c)),
      );
      const dedupedCount = result.comments.length - newComments.length;

      // Gate inline volume + severity. Comments below the minimum
      // severity or beyond the cap are folded into the summary instead of being
      // posted inline, keeping the review focused on what matters.
      const { posted: commentsToPost, folded } = applyVolumeAndSeverityGate(newComments, {
        minSeverity: this.deps.reviewMinSeverity ?? "info",
        maxComments: this.deps.maxReviewComments ?? 20,
      });
      const summary = result.summary + buildFoldedSummary(folded);

      // Validate the agent's replies against the eligible thread set: drop
      // hallucinated threadIds and duplicates, require a non-empty body, and
      // cap the volume. Replies are posted independently of the summary gate.
      const maxReplies = this.deps.maxReviewReplies ?? 20;
      const repliesToPost: Array<{ threadId: string; message: string; handledHash: string }> = [];
      const seenReplyThreadIds = new Set<string>();
      for (const reply of result.replies) {
        if (repliesToPost.length >= maxReplies) break;
        if (seenReplyThreadIds.has(reply.threadId)) continue;
        const entry = threadById.get(reply.threadId);
        if (entry === undefined) continue; // hallucinated or already-handled thread
        const message = reply.message.trim();
        if (message.length === 0) continue;
        seenReplyThreadIds.add(reply.threadId);
        repliesToPost.push({ threadId: reply.threadId, message, handledHash: entry.handledHash });
      }

      // Avoid re-posting an identical verdict on re-reviews. When a pass
      // finds nothing new to say (no inline comments, no folded notes, no
      // replies) and the overall vote matches the last review cycle, stay
      // silent instead of spamming another summary + vote notification.
      const hasNothingNew = commentsToPost.length === 0 && folded.length === 0;
      const previousVote = await this.getLastReviewVote(taskId);
      const skipPosting =
        cycleNumber > 1 &&
        hasNothingNew &&
        previousVote !== null &&
        previousVote === vote &&
        repliesToPost.length === 0;

      emitReviewEvent("review.posting_comments", {
        commentCount: commentsToPost.length,
        foldedCount: folded.length,
        dedupedCount,
        replyCount: repliesToPost.length,
        vote,
        skipped: skipPosting,
        summary: summary.slice(0, 200),
      });

      if (!skipPosting) {
        await this.postReview(changeId, reviewPatchset, commentsToPost, summary, vote, diff);
      }

      // Persist all newly-handled comment hashes (posted inline AND folded) so
      // future re-reviews skip them — avoiding both inline and summary spam.
      if (newComments.length > 0) {
        await this.deps.stateStore.markReviewCommentsPosted(
          taskId,
          changeId,
          newComments.map((c) => ({
            commentHash: computeCommentHash(c),
            file: c.file,
            line: c.line,
            message: c.message,
            severity: c.severity,
          })),
        );
      }

      // Post replies to human discussion threads (independent of the summary
      // gate). Each successfully-posted reply is recorded in the ledger so the
      // same human message is never answered twice across re-reviews.
      const postedReplies: ThreadReplyRecordInput[] = [];
      if (repliesToPost.length > 0 && this.deps.reviewProvider.postThreadReply !== undefined) {
        for (const r of repliesToPost) {
          try {
            await this.deps.reviewProvider.postThreadReply(changeId, reviewPatchset, r.threadId, r.message);
            postedReplies.push({
              threadId: r.threadId,
              handledCommentHash: r.handledHash,
              replyMessage: r.message,
            });
          } catch (err) {
            log.warn({ err, taskId, threadId: r.threadId }, "failed to post discussion reply");
          }
        }
        if (postedReplies.length > 0) {
          await this.deps.stateStore.markThreadReplyPosted(taskId, changeId, postedReplies);
        }
      }

      await this.deps.stateStore.transition(taskId, "REVIEW_COMMENTING");
      await this.deps.stateStore.setReviewedPatchset(taskId, reviewPatchset);

      emitReviewEvent("review.completed", {
        commentCount: commentsToPost.length,
        foldedCount: folded.length,
        dedupedCount,
        replyCount: postedReplies.length,
        vote,
        skipped: skipPosting,
        patchset: reviewPatchset,
      });

      // Save the review cycle to the database for history.
      const cycleResult: AgentResult = {
        status: "success",
        modifiedFiles: [],
        summary: result.summary,
        agentLogs: rawOutput,
        agentEvents: collectedEvents,
        metadata: {
          reviewMode: true,
          patchset: reviewPatchset,
          commentCount: result.comments.length,
          replyCount: postedReplies.length,
          vote,
          comments: result.comments,
          score: result.score,
        },
      };
      await this.deps.stateStore.saveAgentCycle(taskId, cycleNumber, cycleResult);
      clearTaskEventBuffer(taskId);

      // After commenting we either keep watching (open) or finish.
      const refreshed = await this.deps.reviewProvider.getChangeDetails(changeId);
      if (refreshed.status === "OPEN") {
        await this.deps.stateStore.transition(taskId, "REVIEW_WATCHING");
      } else {
        await this.deps.stateStore.transition(taskId, "REVIEW_DONE");
      }
    } catch (err) {
      const message = (err as Error).message ?? "review failed";
      log.error({ err, taskId }, "code review failed");
      emitReviewEvent("review.failed", { message });

      // Save a failure cycle for visibility.
      const failCycleResult: AgentResult = {
        status: "failed",
        modifiedFiles: [],
        summary: message,
        agentLogs: "",
        agentEvents: collectedEvents,
        metadata: { reviewMode: true, error: message },
      };
      await this.deps.stateStore.saveAgentCycle(taskId, cycleNumber, failCycleResult).catch(
        (saveErr: unknown) => log.warn({ err: saveErr, taskId }, "failed to save review failure cycle")
      );
      clearTaskEventBuffer(taskId);

      try {
        await this.deps.stateStore.setFailureReason(taskId, message);
        await this.deps.stateStore.transition(taskId, "REVIEW_FAILED");
      } catch (transitionErr) {
        log.error({ err: transitionErr, taskId }, "failed to mark review task as REVIEW_FAILED");
      }
      throw err;
    }
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  /**
   * Parse a single stderr line from the review container.
   * If it is a structured `__ve_event` JSON line, parse it and emit on the bus.
   * Otherwise wrap it as a generic `stderr.line` event.
   */
  private processReviewStderrLine(
    line: string,
    taskId: string,
    cycleNumber: number,
    collectedEvents: AgentLogEvent[]
  ): void {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed["__ve_event"] === true) {
        const event: AgentLogEvent = {
          type: typeof parsed["type"] === "string" ? parsed["type"] : "unknown",
          timestamp: typeof parsed["ts"] === "string" ? parsed["ts"] : new Date().toISOString(),
          data: parsed["data"] ?? null,
          taskId,
          cycleNumber,
        };
        collectedEvents.push(event);
        pushToTaskBuffer(event);
        agentLogBus.emit("event", event);
        return;
      }
    } catch {
      // Not JSON — fall through to plain text handling.
    }

    // Plain text stderr line.
    const event: AgentLogEvent = {
      type: "stderr.line",
      timestamp: new Date().toISOString(),
      data: { line },
      taskId,
      cycleNumber,
    };
    collectedEvents.push(event);
    pushToTaskBuffer(event);
    agentLogBus.emit("event", event);
  }

  /**
   * Return the overall vote (-1/0/1) recorded on the most recent prior review
   * cycle for this task, or null when there is no prior cycle / no vote stored.
   * Used to suppress redundant re-votes when a re-review finds nothing new.
   */
  private async getLastReviewVote(taskId: TaskId): Promise<-1 | 0 | 1 | null> {
    const cycles = await this.deps.stateStore.getAgentCycles(taskId);
    for (let i = cycles.length - 1; i >= 0; i--) {
      const meta = cycles[i]?.result?.metadata;
      const vote = meta?.["vote"];
      if (vote === -1 || vote === 0 || vote === 1) return vote;
    }
    return null;
  }

  /** Post review comments and vote on the given change revision via the review provider. */
  private async postReview(
    changeId: ExternalChangeId,
    revision: number,
    comments: InlineReviewComment[],
    summary: string,
    score: -1 | 1,
    diff: ReviewChangeDiff
  ): Promise<void> {
    // An empty diff (e.g. a transient fetch failure) must not silently drop every
    // comment: fall back to no filtering rather than an all-rejecting empty set.
    const allowedFiles =
      diff.files.length > 0 ? new Set(diff.files.map((f) => f.path)) : undefined;
    const filteredComments = filterCommentsByAllowedFiles(comments, allowedFiles, { changeId, revision });
    // Prefer the combined call when available so a retry posts comments + vote in
    // one review event instead of two, avoiding duplicate inline comments.
    if (typeof this.deps.reviewProvider.postReviewWithComments === "function") {
      await this.deps.reviewProvider.postReviewWithComments(
        changeId,
        revision,
        filteredComments,
        summary,
        score,
      );
      return;
    }
    // Fallback two-call path for providers without combined posting. Guard on the
    // post-filter count so a batch where every comment is filtered out (all paths
    // outside the diff) never triggers an empty postReviewComments call.
    if (filteredComments.length > 0 || summary.trim().length > 0) {
      await this.deps.reviewProvider.postReviewComments(
        changeId,
        revision,
        filteredComments,
        summary,
      );
    }
    await this.deps.reviewProvider.vote(changeId, revision, score, summary);
  }

}

// Helper re-export for tests / consumers that want to type a raw details
// object without importing from interfaces directly.
export type { ReviewChangeDetails };
