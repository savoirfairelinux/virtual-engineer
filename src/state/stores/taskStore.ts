import type Database from "better-sqlite3";
import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type {
  AgentCycle,
  AgentLogEvent,
  AgentResult,
  ChangePerRepository,
  CostSummary,
  CostSummaryProject,
  CycleCost,
  ExternalChangeId,
  ModelUsageEntry,
  ModelUsageProject,
  ModelUsageSummary,
  PostedReviewComment,
  PostedReviewCommentInput,
  ProjectId,
  StateTransition,
  Task,
  TaskId,
  TaskState,
  ThreadReplyRecordInput,
  TicketId,
  ValidationResult,
} from "../../interfaces.js";
import { makeExternalChangeId, TERMINAL_STATES } from "../../interfaces.js";
import { computeCycleCost, hasCostData } from "../../agents/cycleCost.js";
import { getLogger } from "../../logger.js";
import { validateTransition } from "../stateMachine.js";
import {
  agentCycles,
  changePerRepository,
  postedReviewComments,
  processedComments,
  reviewThreadReplies,
  stateTransitions,
  tasks,
} from "../schema.js";
import * as schema from "../schema.js";

/**
 * True when `err` is a SQLite UNIQUE-constraint violation (better-sqlite3 sets
 * `code === "SQLITE_CONSTRAINT_UNIQUE"`). Used to distinguish the recoverable
 * active-ticket index conflict from genuine insert failures.
 */
function isUniqueConstraintViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

export interface TaskStoreApi {
  createTask(
    taskId: TaskId,
    ticketId: TicketId,
    ticketTitle?: string,
    ticketDescription?: string,
    ticketSourceLabel?: string,
    ticketUrl?: string,
    displayId?: string,
    ticketSource?: { integrationId: string; ticketProjectKey: string },
    projectId?: ProjectId
  ): Promise<Task>;
  getTask(taskId: TaskId): Promise<Task | null>;
  getTaskByTicketId(ticketId: TicketId, projectId?: ProjectId): Promise<Task | null>;
  getActiveTaskByTicketId(ticketId: TicketId, projectId?: ProjectId): Promise<Task | null>;
  getActiveTasks(): Promise<Task[]>;
  getAllTasks(): Promise<Task[]>;
  transition(taskId: TaskId, toState: TaskState, metadata?: Record<string, unknown>): Promise<Task>;
  updateExternalChangeId(taskId: TaskId, changeId: ExternalChangeId, patchset: number, reviewUrl?: string): Promise<void>;
  createReviewTask(input: {
    taskId: TaskId;
    ticketId: TicketId;
    subject: string;
    description?: string;
    sourceLabel?: string;
    changeId: ExternalChangeId;
    patchset: number;
    reviewUrl?: string;
    displayId?: string;
    projectId?: ProjectId;
  }): Promise<Task>;
  setReviewedPatchset(taskId: TaskId, patchset: number): Promise<void>;
  incrementCycle(taskId: TaskId): Promise<number>;
  setFailureReason(taskId: TaskId, reason: string): Promise<void>;
  saveAgentCycle(
    taskId: TaskId,
    cycleNumber: number,
    result: AgentResult,
    validationResult?: ValidationResult
  ): Promise<void>;
  getAgentCycles(taskId: TaskId): Promise<AgentCycle[]>;
  getAgentCycleEvents(taskId: TaskId, cycleNumber: number): Promise<AgentLogEvent[]>;
  getStateTransitions(taskId: TaskId): Promise<StateTransition[]>;
  getFailedAttemptCount(ticketId: TicketId, ticketSourceLabel?: string, projectId?: ProjectId): Promise<number>;
  getProcessedCommentIds(taskId: TaskId): Promise<Set<string>>;
  markCommentProcessed(taskId: TaskId, gerritCommentId: string): Promise<void>;
  getPostedReviewCommentHashes(taskId: TaskId): Promise<Set<string>>;
  getPostedReviewComments(taskId: TaskId): Promise<PostedReviewComment[]>;
  markReviewCommentsPosted(
    taskId: TaskId,
    changeId: ExternalChangeId,
    comments: PostedReviewCommentInput[]
  ): Promise<void>;
  markReviewCommentResolved(id: number): Promise<void>;
  getHandledThreadReplyHashes(taskId: TaskId): Promise<Set<string>>;
  markThreadReplyPosted(
    taskId: TaskId,
    changeId: ExternalChangeId,
    replies: ThreadReplyRecordInput[]
  ): Promise<void>;
  pauseTask(taskId: TaskId): Promise<Task>;
  resumeTask(taskId: TaskId): Promise<Task>;
  isTaskPaused(taskId: TaskId): Promise<boolean>;
  retryTask(taskId: TaskId): Promise<Task>;
  abandonTask(taskId: TaskId): Promise<Task>;
  deleteTask(taskId: TaskId): Promise<void>;
  deleteTaskGroup(taskId: TaskId): Promise<void>;
  saveChangePerRepository(
    taskId: TaskId,
    repoKey: string,
    changeId: string,
    reviewUrl: string | null,
    status: string,
    integrationId?: string,
    reviewSystem?: string,
    commitIndex?: number,
    subjectHash?: string | null
  ): Promise<void>;
  getChangesForTask(taskId: TaskId): Promise<ChangePerRepository[]>;
  getChangesForTasks(taskIds: TaskId[]): Promise<ChangePerRepository[]>;
  findTaskByExternalChangeId(integrationId: string | null, externalChangeId: string): Promise<Task | null>;
  findReviewedCodeReviewTask(changeId: string, projectId: ProjectId): Promise<Task | null>;
  setTaskProjectId(taskId: TaskId, projectId: ProjectId): Promise<void>;
  setTaskPushRef(taskId: TaskId, pushRef: string): Promise<void>;
  updateChangePerRepositoryStatus(taskId: TaskId, repoKey: string, status: string, changeId?: string): Promise<void>;
  orphanExcessChanges(taskId: TaskId, repoKey: string, maxCommitIndex: number): Promise<number>;
  getFailedTasksForProject(projectId: ProjectId): Promise<Task[]>;
  getCostSummary(options?: { since?: Date }): Promise<CostSummary>;
  getModelUsageSummary(options?: { since?: Date }): Promise<ModelUsageSummary>;
}

interface TaskStoreContext {
  db: BetterSQLite3Database<typeof schema>;
  raw: Database.Database;
}

export function createTaskStore(context: TaskStoreContext): TaskStoreApi {
  const { db, raw } = context;

  function rowToTask(row: typeof tasks.$inferSelect): Task {
    return {
      taskId: row.taskId as TaskId,
      ticketId: row.ticketId as TicketId,
      ticketSourceLabel: row.ticketSourceLabel,
      ticketTitle: row.ticketTitle,
      ticketDescription: row.ticketDescription,
      state: row.state as TaskState,
      taskType: row.taskType,
      externalChangeId: row.gerritChangeId
        ? makeExternalChangeId(row.gerritChangeId)
        : null,
      currentPatchset: row.currentPatchset,
      reviewedPatchset: row.reviewedPatchset ?? null,
      cycleCount: row.cycleCount,
      failureReason: row.failureReason ?? null,
      ticketUrl: row.ticketUrl ?? null,
      reviewUrl: row.reviewUrl ?? null,
      projectId: (row.projectId ?? null) as Task["projectId"],
      displayId: (row as unknown as { displayId?: string | null }).displayId ?? null,
      pushRef: (row as unknown as { pushRef?: string | null }).pushRef ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async function getTask(taskId: TaskId): Promise<Task | null> {
    const row = await db.query.tasks.findFirst({
      where: eq(tasks.taskId, taskId),
    });
    return row ? rowToTask(row) : null;
  }

  async function getTaskByTicketId(ticketId: TicketId, projectId?: ProjectId): Promise<Task | null> {
    const row = await db.query.tasks.findFirst({
      where: projectId !== undefined
        ? and(eq(tasks.ticketId, ticketId), eq(tasks.projectId, projectId))
        : eq(tasks.ticketId, ticketId),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
    return row ? rowToTask(row) : null;
  }

  async function getActiveTaskByTicketId(ticketId: TicketId, projectId?: ProjectId): Promise<Task | null> {
    const row = await db.query.tasks.findFirst({
      where: and(
        eq(tasks.ticketId, ticketId),
        notInArray(tasks.state, [...TERMINAL_STATES]),
        ...(projectId !== undefined ? [eq(tasks.projectId, projectId)] : [])
      ),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
    return row ? rowToTask(row) : null;
  }

  // Recovery-only lookup mirroring `idx_tasks_active_ticket_id_noproject`:
  // the newest active task for this ticket that has no project binding.
  async function getActiveProjectlessTaskByTicketId(ticketId: TicketId): Promise<Task | null> {
    const row = await db.query.tasks.findFirst({
      where: and(
        eq(tasks.ticketId, ticketId),
        isNull(tasks.projectId),
        notInArray(tasks.state, [...TERMINAL_STATES])
      ),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
    return row ? rowToTask(row) : null;
  }

  async function createTask(
    taskId: TaskId,
    ticketId: TicketId,
    ticketTitle = "",
    ticketDescription = "",
    ticketSourceLabel = "redmine",
    ticketUrl?: string,
    displayId?: string,
    ticketSource?: { integrationId: string; ticketProjectKey: string },
    projectId?: ProjectId
  ): Promise<Task> {
    const now = new Date();
    try {
      await db.insert(tasks).values({
        taskId,
        ticketId,
        ticketSourceLabel,
        ticketTitle,
        ticketDescription,
        state: "DETECTED",
        gerritChangeId: null,
        currentPatchset: 0,
        cycleCount: 0,
        failureReason: null,
        ticketUrl: ticketUrl ?? null,
        displayId: displayId ?? null,
        projectId: projectId ?? null,
        ticketSourceIntegrationId: ticketSource?.integrationId ?? null,
        ticketSourceProjectKey: ticketSource?.ticketProjectKey ?? null,
        createdAt: now,
        updatedAt: now,
      });
    } catch (err: unknown) {
      // The partial unique index `idx_tasks_active_ticket_id` allows at most one
      // active (non-terminal) task per (project_id, ticket_id). A concurrent
      // create — or a stale active task that predates a newer terminal one —
      // may already hold that slot; reuse it instead of surfacing a UNIQUE
      // constraint error. We must look up the ACTIVE task specifically (the
      // newest task may be terminal) for the recovery to succeed.
      //
      // Only recover from the unique-constraint conflict: any other insert
      // failure (disk full, NOT NULL/FK violation, corruption) must surface
      // instead of being masked as a "reuse" of an unrelated active task.
      if (isUniqueConstraintViolation(err)) {
        // The conflict comes from one of two partial unique indexes. When
        // projectId is set the conflict is on the composite
        // (project_id, ticket_id) index, so scope recovery to that project.
        // When projectId is undefined the conflict is on the project-less
        // index (`idx_tasks_active_ticket_id_noproject`); recovery must reuse
        // the active task with project_id IS NULL — never the newest active
        // task across all projects, which could belong to a different project
        // and cause cross-project task reuse.
        const active =
          projectId !== undefined
            ? await getActiveTaskByTicketId(ticketId, projectId)
            : await getActiveProjectlessTaskByTicketId(ticketId);
        if (active) {
          return active;
        }
      }
      throw err;
    }
    const task = await getTask(taskId);
    if (!task) throw new Error(`Failed to create task ${taskId}`);
    return task;
  }

  async function getActiveTasks(): Promise<Task[]> {
    const rows = await db.query.tasks.findMany({
      where: notInArray(tasks.state, [...TERMINAL_STATES]),
    });
    return rows.map((row) => rowToTask(row));
  }

  async function getAllTasks(): Promise<Task[]> {
    const rows = await db.query.tasks.findMany({
      orderBy: (t, { desc }) => [desc(t.updatedAt)],
    });
    return rows.map((row) => rowToTask(row));
  }

  async function transition(
    taskId: TaskId,
    toState: TaskState,
    metadata: Record<string, unknown> = {}
  ): Promise<Task> {
    const task = await getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const result = validateTransition(task.state, toState);
    if (result === "idempotent") return task;

    const now = new Date();
    const isReviewPollingTransition =
      (task.state === "IN_REVIEW" && toState === "FEEDBACK_PROCESSING") ||
      (task.state === "FEEDBACK_PROCESSING" && toState === "IN_REVIEW");

    raw.transaction(() => {
      if (isReviewPollingTransition) {
        raw
          .prepare("UPDATE tasks SET state = ? WHERE task_id = ?")
          .run(toState, taskId);
      } else {
        raw
          .prepare("UPDATE tasks SET state = ?, updated_at = ? WHERE task_id = ?")
          .run(toState, Math.floor(now.getTime() / 1000), taskId);
      }

      raw
        .prepare(
          "INSERT INTO state_transitions (task_id, from_state, to_state, metadata, created_at) VALUES (?, ?, ?, ?, ?)"
        )
        .run(taskId, task.state, toState, JSON.stringify(metadata), Math.floor(now.getTime() / 1000));
    })();

    const updated = await getTask(taskId);
    if (!updated) throw new Error(`Task disappeared after transition: ${taskId}`);
    return updated;
  }

  async function updateExternalChangeId(
    taskId: TaskId,
    changeId: ExternalChangeId,
    patchset: number,
    reviewUrl?: string
  ): Promise<void> {
    const now = new Date();
    await db
      .update(tasks)
      .set({
        gerritChangeId: changeId,
        currentPatchset: patchset,
        updatedAt: now,
        ...(reviewUrl !== undefined ? { reviewUrl } : {}),
      })
      .where(eq(tasks.taskId, taskId));
  }

  async function createReviewTask(input: {
    taskId: TaskId;
    ticketId: TicketId;
    subject: string;
    description?: string;
    sourceLabel?: string;
    changeId: ExternalChangeId;
    patchset: number;
    reviewUrl?: string;
    displayId?: string;
    projectId?: ProjectId;
  }): Promise<Task> {
    const now = new Date();
    try {
      await db.insert(tasks).values({
        taskId: input.taskId,
        ticketId: input.ticketId,
        ticketSourceLabel: input.sourceLabel ?? "gerrit",
        ticketTitle: input.subject,
        ticketDescription: input.description ?? "",
        state: "REVIEW_PENDING",
        taskType: "code-review",
        gerritChangeId: input.changeId,
        currentPatchset: input.patchset,
        reviewedPatchset: null,
        cycleCount: 0,
        failureReason: null,
        ticketUrl: null,
        reviewUrl: input.reviewUrl ?? null,
        displayId: input.displayId ?? null,
        projectId: input.projectId ?? null,
        createdAt: now,
        updatedAt: now,
      });
    } catch (err: unknown) {
      const existing = await getTask(input.taskId);
      if (existing) return existing;
      throw err;
    }
    const task = await getTask(input.taskId);
    if (!task) throw new Error(`Failed to create review task ${input.taskId}`);
    return task;
  }

  async function setReviewedPatchset(taskId: TaskId, patchset: number): Promise<void> {
    const now = new Date();
    await db
      .update(tasks)
      .set({ reviewedPatchset: patchset, updatedAt: now })
      .where(eq(tasks.taskId, taskId));
  }

  async function incrementCycle(taskId: TaskId): Promise<number> {
    const task = await getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const newCount = task.cycleCount + 1;
    await db
      .update(tasks)
      .set({ cycleCount: newCount, updatedAt: new Date() })
      .where(eq(tasks.taskId, taskId));
    return newCount;
  }

  async function setFailureReason(taskId: TaskId, reason: string): Promise<void> {
    await db
      .update(tasks)
      .set({ failureReason: reason, updatedAt: new Date() })
      .where(eq(tasks.taskId, taskId));
  }

  async function saveAgentCycle(
    taskId: TaskId,
    cycleNumber: number,
    result: AgentResult,
    validationResult?: ValidationResult
  ): Promise<void> {
    const cost = computeCycleCost(result.agentEvents);
    await db.insert(agentCycles).values({
      taskId,
      cycleNumber,
      agentResult: JSON.stringify(result),
      validationResult: validationResult ? JSON.stringify(validationResult) : null,
      agentEvents: result.agentEvents ? JSON.stringify(result.agentEvents) : null,
      costAiCredits: cost.priced ? cost.aiCredits : null,
      costUsd: cost.usd > 0 ? cost.usd : null,
      premiumRequests: cost.premiumRequests > 0 ? cost.premiumRequests : null,
      costInputTokens: cost.tokens.input > 0 ? cost.tokens.input : null,
      costOutputTokens: cost.tokens.output > 0 ? cost.tokens.output : null,
      costCachedTokens: cost.tokens.cached > 0 ? cost.tokens.cached : null,
      costCacheWriteTokens: cost.tokens.cacheWrite > 0 ? cost.tokens.cacheWrite : null,
      costModelId: cost.modelId,
      createdAt: new Date(),
    });
  }

  async function getAgentCycles(taskId: TaskId): Promise<AgentCycle[]> {
    const rows = await db.query.agentCycles.findMany({
      where: eq(agentCycles.taskId, taskId),
    });
    return rows.map((row) => {
      let result: AgentResult;
      let validationResult: ValidationResult | null = null;
      try {
        result = JSON.parse(row.agentResult) as AgentResult;
      } catch {
        result = { status: "failed", summary: "[corrupt cycle data]", modifiedFiles: [], agentLogs: "", metadata: {} };
      }
      if (row.validationResult) {
        try {
          validationResult = JSON.parse(row.validationResult) as ValidationResult;
        } catch {
          validationResult = null;
        }
      }
      const hasSnapshot =
        row.costUsd !== null ||
        row.costAiCredits !== null ||
        row.premiumRequests !== null ||
        row.costInputTokens !== null ||
        row.costOutputTokens !== null ||
        row.costCachedTokens !== null ||
        row.costCacheWriteTokens !== null ||
        row.costModelId !== null;
      let cost: CycleCost | undefined;
      if (hasSnapshot) {
        cost = {
          priced: row.costAiCredits !== null,
          aiCredits: row.costAiCredits ?? 0,
          usd: row.costUsd ?? 0,
          premiumRequests: row.premiumRequests ?? 0,
          tokens: {
            input: row.costInputTokens ?? 0,
            output: row.costOutputTokens ?? 0,
            cached: row.costCachedTokens ?? 0,
            cacheWrite: row.costCacheWriteTokens ?? 0,
          },
          modelId: row.costModelId,
        };
      } else {
        // Legacy cycle (persisted before cost columns): recompute from the
        // streamed event log. Prefer the canonical `agent_events` column over
        // the larger agentResult JSON, which is more prone to truncation or
        // corruption (and is replaced by a placeholder when parsing fails above).
        let events = result.agentEvents;
        if (row.agentEvents) {
          try {
            events = JSON.parse(row.agentEvents) as AgentLogEvent[];
          } catch {
            // Fall back to events embedded in the parsed result.
          }
        }
        const recomputed = computeCycleCost(events);
        if (hasCostData(recomputed)) cost = recomputed;
      }
      return {
        id: row.id,
        taskId: row.taskId as TaskId,
        cycleNumber: row.cycleNumber,
        result,
        validationResult,
        createdAt: row.createdAt,
        ...(cost ? { cost } : {}),
      };
    });
  }

  async function getAgentCycleEvents(taskId: TaskId, cycleNumber: number): Promise<AgentLogEvent[]> {
    const row = await db.query.agentCycles.findFirst({
      where: (table, { and }) => and(eq(table.taskId, taskId), eq(table.cycleNumber, cycleNumber)),
    });
    if (!row?.agentEvents) return [];
    try {
      return JSON.parse(row.agentEvents) as AgentLogEvent[];
    } catch {
      return [];
    }
  }

  async function getStateTransitions(taskId: TaskId): Promise<StateTransition[]> {
    const rows = await db.query.stateTransitions.findMany({
      where: eq(stateTransitions.taskId, taskId),
      orderBy: (table, { asc }) => [asc(table.createdAt), asc(table.id)],
    });

    return rows.map((row) => {
      let metadata: Record<string, unknown>;
      try {
        metadata = JSON.parse(row.metadata) as Record<string, unknown>;
      } catch {
        metadata = {};
      }

      return {
        id: row.id,
        taskId: row.taskId as TaskId,
        fromState: row.fromState as TaskState,
        toState: row.toState as TaskState,
        metadata,
        createdAt: row.createdAt,
      };
    });
  }

  async function getFailedAttemptCount(
    ticketId: TicketId,
    ticketSourceLabel?: string,
    projectId?: ProjectId
  ): Promise<number> {
    const clauses: string[] = ["ticket_id = ?", "state IN ('FAILED', 'ABANDONED')"];
    const args: unknown[] = [ticketId];
    if (ticketSourceLabel !== undefined) {
      clauses.push("ticket_source_label = ?");
      args.push(ticketSourceLabel);
    }
    if (projectId !== undefined) {
      clauses.push("project_id = ?");
      args.push(projectId);
    }
    const row = raw
      .prepare(`SELECT COUNT(*) AS count FROM tasks WHERE ${clauses.join(" AND ")}`)
      .get(...args) as { count: number };
    return row.count;
  }

  async function getProcessedCommentIds(taskId: TaskId): Promise<Set<string>> {
    const rows = await db.query.processedComments.findMany({
      where: eq(processedComments.taskId, taskId),
    });
    return new Set(rows.map((row) => row.gerritCommentId));
  }

  async function markCommentProcessed(taskId: TaskId, gerritCommentId: string): Promise<void> {
    await db.insert(processedComments).values({
      taskId,
      gerritCommentId,
      createdAt: new Date(),
    });
  }

  async function getPostedReviewCommentHashes(taskId: TaskId): Promise<Set<string>> {
    const rows = await db.query.postedReviewComments.findMany({
      where: eq(postedReviewComments.taskId, taskId),
    });
    return new Set(rows.map((row) => row.commentHash));
  }

  async function getPostedReviewComments(taskId: TaskId): Promise<PostedReviewComment[]> {
    const rows = await db.query.postedReviewComments.findMany({
      where: eq(postedReviewComments.taskId, taskId),
    });
    return rows.map((row) => ({
      id: row.id,
      taskId: row.taskId as TaskId,
      changeId: makeExternalChangeId(row.changeId),
      commentHash: row.commentHash,
      file: row.file,
      line: row.line,
      message: row.message,
      severity: row.severity,
      providerThreadId: row.providerThreadId,
      resolved: row.resolved === 1,
      createdAt: row.createdAt,
    }));
  }

  async function markReviewCommentsPosted(
    taskId: TaskId,
    changeId: ExternalChangeId,
    comments: PostedReviewCommentInput[]
  ): Promise<void> {
    if (comments.length === 0) return;
    const now = Math.floor(Date.now() / 1000);
    // INSERT OR IGNORE so a duplicate (task_id, comment_hash) is silently skipped
    // rather than aborting the whole batch on the unique index.
    const stmt = raw.prepare(
      `INSERT OR IGNORE INTO posted_review_comments
         (task_id, change_id, comment_hash, file, line, message, severity, provider_thread_id, resolved, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
    );
    const insertMany = raw.transaction((items: PostedReviewCommentInput[]) => {
      for (const c of items) {
        stmt.run(
          taskId,
          String(changeId),
          c.commentHash,
          c.file,
          c.line,
          c.message,
          c.severity,
          c.providerThreadId ?? null,
          now
        );
      }
    });
    insertMany(comments);
  }

  async function markReviewCommentResolved(id: number): Promise<void> {
    raw.prepare("UPDATE posted_review_comments SET resolved = 1 WHERE id = ?").run(id);
  }

  async function getHandledThreadReplyHashes(taskId: TaskId): Promise<Set<string>> {
    const rows = await db.query.reviewThreadReplies.findMany({
      where: eq(reviewThreadReplies.taskId, taskId),
    });
    return new Set(rows.map((row) => row.handledCommentHash));
  }

  async function markThreadReplyPosted(
    taskId: TaskId,
    changeId: ExternalChangeId,
    replies: ThreadReplyRecordInput[]
  ): Promise<void> {
    if (replies.length === 0) return;
    const now = Math.floor(Date.now() / 1000);
    // INSERT OR IGNORE so a duplicate (task_id, thread_id, handled_comment_hash)
    // is silently skipped rather than aborting the whole batch.
    const stmt = raw.prepare(
      `INSERT OR IGNORE INTO review_thread_replies
         (task_id, change_id, thread_id, handled_comment_hash, reply_message, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const insertMany = raw.transaction((items: ThreadReplyRecordInput[]) => {
      for (const r of items) {
        stmt.run(taskId, String(changeId), r.threadId, r.handledCommentHash, r.replyMessage, now);
      }
    });
    insertMany(replies);
  }

  async function pauseTask(taskId: TaskId): Promise<Task> {
    const task = await getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const now = new Date();
    raw
      .prepare(
        "INSERT INTO state_transitions (task_id, from_state, to_state, metadata, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(taskId, task.state, task.state, JSON.stringify({ action: "pause" }), Math.floor(now.getTime() / 1000));

    return task;
  }

  async function resumeTask(taskId: TaskId): Promise<Task> {
    const task = await getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const now = new Date();
    raw
      .prepare(
        "INSERT INTO state_transitions (task_id, from_state, to_state, metadata, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(taskId, task.state, task.state, JSON.stringify({ action: "resume" }), Math.floor(now.getTime() / 1000));

    return task;
  }

  async function isTaskPaused(taskId: TaskId): Promise<boolean> {
    const row = raw
      .prepare(
        "SELECT metadata FROM state_transitions WHERE task_id = ? ORDER BY id DESC LIMIT 1"
      )
      .get(taskId) as { metadata: string } | undefined;

    if (!row) return false;

    try {
      const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
      const latestAction = metadata["action"] as string | undefined;
      return latestAction === "pause";
    } catch {
      return false;
    }
  }

  function isTaskOrphaned(task: Task): boolean {
    if (task.projectId === null) return true;
    const row = raw
      .prepare("SELECT 1 AS hit FROM projects WHERE id = ?")
      .get(task.projectId) as { hit: number } | undefined;
    return row === undefined;
  }

  function findAdoptionTargetForTask(taskId: TaskId): { projectId: string; integrationId: string; ticketProjectKey: string } | null {
    const snapshotRow = raw
      .prepare(
        "SELECT pib.project_id AS projectId, t.ticket_source_integration_id AS integrationId, " +
        "t.ticket_source_project_key AS ticketProjectKey FROM tasks t " +
        "JOIN project_integration_bindings pib " +
        "ON pib.capability = 'issue_tracking' " +
        "AND pib.integration_id = t.ticket_source_integration_id " +
        "AND json_extract(pib.config_json, '$.ticketProjectKey') = t.ticket_source_project_key " +
        "WHERE t.task_id = ? " +
        "AND t.ticket_source_integration_id IS NOT NULL " +
        "AND t.ticket_source_project_key IS NOT NULL"
      )
      .get(taskId) as { projectId: string; integrationId: string; ticketProjectKey: string } | undefined;
    if (snapshotRow) return snapshotRow;

    const labelRow = raw
      .prepare("SELECT ticket_source_label AS label FROM tasks WHERE task_id = ?")
      .get(taskId) as { label: string } | undefined;
    const integrationId = parseIntegrationIdFromLabel(labelRow?.label);
    if (integrationId === null) return null;

    const fallbackRows = raw
      .prepare(
        "SELECT project_id AS projectId, integration_id AS integrationId, " +
        "json_extract(config_json, '$.ticketProjectKey') AS ticketProjectKey " +
        "FROM project_integration_bindings WHERE capability = 'issue_tracking' AND integration_id = ?"
      )
      .all(integrationId) as { projectId: string; integrationId: string; ticketProjectKey: string }[];
    if (fallbackRows.length !== 1) return null;
    return fallbackRows[0] ?? null;
  }

  async function retryTask(taskId: TaskId): Promise<Task> {
    const task = await getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const isReview = task.taskType === "code-review";
    const resetState: TaskState = isReview ? "REVIEW_PENDING" : "DETECTED";
    // Adoption only applies to code-gen tasks: review tasks are tied to a
    // specific change/patchset and never lose their project mapping.
    const adoption = !isReview && isTaskOrphaned(task)
      ? findAdoptionTargetForTask(taskId)
      : null;
    if (isReview && isTaskOrphaned(task)) {
      const log = getLogger("task-store");
      log.warn(
        { taskId, state: task.state },
        "retrying an orphaned code-review task: project mapping cannot be restored, next runReview may fail"
      );
    }

    const now = new Date();
    raw.transaction(() => {
      const nowSec = Math.floor(now.getTime() / 1000);
      if (adoption !== null) {
        raw
          .prepare(
            "UPDATE tasks SET state = ?, failure_reason = ?, project_id = ?, " +
            "ticket_source_integration_id = COALESCE(ticket_source_integration_id, ?), " +
            "ticket_source_project_key = COALESCE(ticket_source_project_key, ?), " +
            "updated_at = ? WHERE task_id = ?"
          )
          .run(
            resetState,
            null,
            adoption.projectId,
            adoption.integrationId,
            adoption.ticketProjectKey,
            nowSec,
            taskId
          );
      } else {
        raw
          .prepare("UPDATE tasks SET state = ?, failure_reason = ?, updated_at = ? WHERE task_id = ?")
          .run(resetState, null, nowSec, taskId);
      }

      const metadata: Record<string, unknown> = { action: "retry" };
      if (adoption !== null) {
        metadata["adoptedProjectId"] = adoption.projectId;
      }
      raw
        .prepare(
          "INSERT INTO state_transitions (task_id, from_state, to_state, metadata, created_at) VALUES (?, ?, ?, ?, ?)"
        )
        .run(taskId, task.state, resetState, JSON.stringify(metadata), nowSec);
    })();

    const updated = await getTask(taskId);
    if (!updated) throw new Error(`Task disappeared after retry: ${taskId}`);
    return updated;
  }

  async function abandonTask(taskId: TaskId): Promise<Task> {
    const task = await getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const now = new Date();
    raw.transaction(() => {
      raw.prepare("UPDATE tasks SET state = ?, updated_at = ? WHERE task_id = ?").run("ABANDONED", Math.floor(now.getTime() / 1000), taskId);

      raw
        .prepare(
          "INSERT INTO state_transitions (task_id, from_state, to_state, metadata, created_at) VALUES (?, ?, ?, ?, ?)"
        )
        .run(taskId, task.state, "ABANDONED", JSON.stringify({ action: "abandon" }), Math.floor(now.getTime() / 1000));
    })();

    const updated = await getTask(taskId);
    if (!updated) throw new Error(`Task disappeared after abandon: ${taskId}`);
    return updated;
  }

  async function deleteTask(taskId: TaskId): Promise<void> {
    const task = await getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const now = Math.floor(Date.now() / 1000);

    if (!TERMINAL_STATES.has(task.state)) {
      raw.transaction(() => {
        raw.prepare("UPDATE tasks SET state = ?, updated_at = ? WHERE task_id = ?").run("ABANDONED", now, taskId);
        raw
          .prepare(
            "INSERT INTO state_transitions (task_id, from_state, to_state, metadata, created_at) VALUES (?, ?, ?, ?, ?)"
          )
          .run(taskId, task.state, "ABANDONED", JSON.stringify({ action: "delete" }), now);
      })();
      return;
    }

    raw.transaction(() => {
      raw.prepare("DELETE FROM change_per_repository WHERE task_id = ?").run(taskId);
      raw.prepare("DELETE FROM processed_comments WHERE task_id = ?").run(taskId);
      raw.prepare("DELETE FROM posted_review_comments WHERE task_id = ?").run(taskId);
      raw.prepare("DELETE FROM review_thread_replies WHERE task_id = ?").run(taskId);
      raw.prepare("DELETE FROM agent_cycles WHERE task_id = ?").run(taskId);
      raw.prepare("DELETE FROM state_transitions WHERE task_id = ?").run(taskId);
      raw.prepare("DELETE FROM tasks WHERE task_id = ?").run(taskId);
    })();
  }

  async function deleteTaskGroup(taskId: TaskId): Promise<void> {
    const anchor = raw
      .prepare("SELECT ticket_id, gerrit_change_id FROM tasks WHERE task_id = ?")
      .get(taskId) as { ticket_id: string; gerrit_change_id: string | null } | undefined;

    if (!anchor) return;

    const taskIds = new Set<string>();

    const byTicket = raw
      .prepare("SELECT task_id FROM tasks WHERE ticket_id = ?")
      .all(anchor.ticket_id) as Array<Record<string, unknown>>;
    for (const row of byTicket) taskIds.add(row["task_id"] as string);

    if (anchor.gerrit_change_id) {
      const byChange = raw
        .prepare("SELECT task_id FROM tasks WHERE gerrit_change_id = ?")
        .all(anchor.gerrit_change_id) as Array<Record<string, unknown>>;
      for (const row of byChange) taskIds.add(row["task_id"] as string);
    }

    if (taskIds.size === 0) return;

    raw.transaction(() => {
      for (const id of taskIds) {
        raw.prepare("DELETE FROM change_per_repository WHERE task_id = ?").run(id);
        raw.prepare("DELETE FROM processed_comments WHERE task_id = ?").run(id);
        raw.prepare("DELETE FROM posted_review_comments WHERE task_id = ?").run(id);
        raw.prepare("DELETE FROM review_thread_replies WHERE task_id = ?").run(id);
        raw.prepare("DELETE FROM agent_cycles WHERE task_id = ?").run(id);
        raw.prepare("DELETE FROM state_transitions WHERE task_id = ?").run(id);
        raw.prepare("DELETE FROM tasks WHERE task_id = ?").run(id);
      }
    })();
  }

  async function saveChangePerRepository(
    taskId: TaskId,
    repoKey: string,
    changeIdValue: string,
    reviewUrl: string | null,
    status: string,
    integrationId = "",
    reviewSystem = "",
    commitIndex = 0,
    subjectHash: string | null = null
  ): Promise<void> {
    const now = new Date();
    const id = commitIndex > 0 ? `${taskId}:${repoKey}:${commitIndex}` : `${taskId}:${repoKey}`;

    raw
      .prepare(
        `INSERT INTO change_per_repository (id, task_id, repo_key, change_id, review_url, status, integration_id, review_system, commit_index, subject_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           change_id = excluded.change_id,
           review_url = excluded.review_url,
           status = excluded.status,
           integration_id = excluded.integration_id,
           review_system = excluded.review_system,
           commit_index = excluded.commit_index,
           subject_hash = excluded.subject_hash,
           updated_at = excluded.updated_at`
      )
      .run(id, taskId, repoKey, changeIdValue, reviewUrl, status, integrationId, reviewSystem, commitIndex, subjectHash, Math.floor(now.getTime() / 1000), Math.floor(now.getTime() / 1000));
  }

  async function getChangesForTask(taskId: TaskId): Promise<ChangePerRepository[]> {
    const rows = await db
      .select()
      .from(changePerRepository)
      .where(eq(changePerRepository.taskId, taskId));

    return rows.map((row) => ({
      id: row.id,
      taskId: row.taskId as TaskId,
      repoKey: row.repoKey,
      changeId: row.changeId,
      reviewUrl: row.reviewUrl,
      status: row.status,
      integrationId: (row as unknown as { integrationId?: string }).integrationId ?? "",
      reviewSystem: (row as unknown as { reviewSystem?: string }).reviewSystem ?? "",
      commitIndex: (row as unknown as { commitIndex?: number }).commitIndex ?? 0,
      subjectHash: (row as unknown as { subjectHash?: string | null }).subjectHash ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  async function getChangesForTasks(taskIds: TaskId[]): Promise<ChangePerRepository[]> {
    if (taskIds.length === 0) return [];
    const rows = await db
      .select()
      .from(changePerRepository)
      .where(inArray(changePerRepository.taskId, taskIds as string[]));

    return rows.map((row) => ({
      id: row.id,
      taskId: row.taskId as TaskId,
      repoKey: row.repoKey,
      changeId: row.changeId,
      reviewUrl: row.reviewUrl,
      status: row.status,
      integrationId: (row as unknown as { integrationId?: string }).integrationId ?? "",
      reviewSystem: (row as unknown as { reviewSystem?: string }).reviewSystem ?? "",
      commitIndex: (row as unknown as { commitIndex?: number }).commitIndex ?? 0,
      subjectHash: (row as unknown as { subjectHash?: string | null }).subjectHash ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  async function findTaskByExternalChangeId(
    integrationId: string | null,
    externalChangeId: string
  ): Promise<Task | null> {
    if (!externalChangeId) return null;

    const singleRow = raw
      .prepare("SELECT * FROM tasks WHERE gerrit_change_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(externalChangeId) as Record<string, unknown> | undefined;
    if (singleRow) {
      const orm = await db.query.tasks.findFirst({
        where: eq(tasks.taskId, singleRow["task_id"] as TaskId),
      });
      if (orm) return rowToTask(orm);
    }

    const cprRow = integrationId
      ? raw
          .prepare(
            "SELECT task_id FROM change_per_repository WHERE change_id = ? AND integration_id = ? ORDER BY updated_at DESC LIMIT 1"
          )
          .get(externalChangeId, integrationId) as { task_id: string } | undefined
      : raw
          .prepare(
            "SELECT task_id FROM change_per_repository WHERE change_id = ? ORDER BY updated_at DESC LIMIT 1"
          )
          .get(externalChangeId) as { task_id: string } | undefined;

    if (cprRow) {
      const orm = await db.query.tasks.findFirst({
        where: eq(tasks.taskId, cprRow.task_id as TaskId),
      });
      if (orm) return rowToTask(orm);
    }

    return null;
  }

  async function findReviewedCodeReviewTask(changeId: string, projectId: ProjectId): Promise<Task | null> {
    if (!changeId) return null;
    const row = raw
      .prepare(
        "SELECT * FROM tasks WHERE gerrit_change_id = ? AND project_id = ? AND task_type = 'code-review' AND reviewed_patchset IS NOT NULL ORDER BY created_at DESC LIMIT 1"
      )
      .get(changeId, projectId as string) as Record<string, unknown> | undefined;
    if (!row) return null;
    const orm = await db.query.tasks.findFirst({
      where: eq(tasks.taskId, row["task_id"] as TaskId),
    });
    return orm ? rowToTask(orm) : null;
  }

  async function setTaskProjectId(taskId: TaskId, projectId: ProjectId): Promise<void> {
    raw
      .prepare("UPDATE tasks SET project_id = ?, updated_at = ? WHERE task_id = ?")
      .run(projectId as string, Math.floor(Date.now() / 1000), taskId);
  }

  async function setTaskPushRef(taskId: TaskId, pushRef: string): Promise<void> {
    raw
      .prepare("UPDATE tasks SET push_ref = ?, updated_at = ? WHERE task_id = ?")
      .run(pushRef, Math.floor(Date.now() / 1000), taskId);
  }

  async function updateChangePerRepositoryStatus(
    taskId: TaskId,
    repoKey: string,
    status: string,
    changeId?: string
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    if (changeId) {
      raw
        .prepare(
          "UPDATE change_per_repository SET status = ?, updated_at = ? WHERE task_id = ? AND change_id = ?"
        )
        .run(status, now, taskId, changeId);
    } else {
      const id = `${taskId}:${repoKey}`;
      raw
        .prepare(
          "UPDATE change_per_repository SET status = ?, updated_at = ? WHERE id = ?"
        )
        .run(status, now, id);
    }
  }

  /**
   * Mark change_per_repository rows as ORPHANED when a retry push produces fewer
   * commits than the previous cycle. Rows whose commitIndex exceeds maxCommitIndex
   * for the given task+repo are set to ORPHANED so they are excluded from future
   * feedback aggregation and Change-Id continuity.
   */
  async function getFailedTasksForProject(projectId: ProjectId): Promise<Task[]> {
    const rows = await db.query.tasks.findMany({
      where: and(eq(tasks.projectId, projectId), inArray(tasks.state, ["FAILED", "REVIEW_FAILED"])),
    });
    return rows.map((row) => rowToTask(row));
  }

  async function orphanExcessChanges(
    taskId: TaskId,
    repoKey: string,
    maxCommitIndex: number
  ): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    const result = raw
      .prepare(
        `UPDATE change_per_repository SET status = 'ORPHANED', updated_at = ?
         WHERE task_id = ? AND repo_key = ? AND commit_index > ?
           AND status NOT IN ('ORPHANED', 'NO_CHANGE', 'MERGED', 'ABANDONED')`
      )
      .run(now, taskId, repoKey, maxCommitIndex);
    return result.changes;
  }

  /**
   * Aggregate agent-cycle execution cost across all tasks, broken down per
   * project and totalled instance-wide. Cycles that were persisted before the
   * cost columns existed (or that never recorded a USD snapshot) are recomputed
   * from their captured event log, so historical runs are still accounted for.
   */
  async function getCostSummary(options?: { since?: Date }): Promise<CostSummary> {
    const sinceEpochSeconds =
      options?.since !== undefined ? Math.floor(options.since.getTime() / 1000) : null;

    interface Bucket {
      projectId: string | null;
      projectName: string | null;
      usd: number;
      aiCredits: number;
      premiumRequests: number;
      runCount: number;
    }
    const buckets = new Map<string, Bucket>();
    const keyOf = (projectId: string | null): string => projectId ?? "\u0000__unassigned__";
    const bucketFor = (projectId: string | null, projectName: string | null): Bucket => {
      const key = keyOf(projectId);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { projectId, projectName, usd: 0, aiCredits: 0, premiumRequests: 0, runCount: 0 };
        buckets.set(key, bucket);
      } else if (bucket.projectName === null && projectName !== null) {
        bucket.projectName = projectName;
      }
      return bucket;
    };

    const periodClause = sinceEpochSeconds !== null ? "WHERE c.created_at >= ?" : "";
    const periodArgs = sinceEpochSeconds !== null ? [sinceEpochSeconds] : [];

    // Pass 1: SQL aggregation of recorded snapshot costs + run counts per project.
    const aggregateRows = raw
      .prepare(
        `SELECT t.project_id AS projectId, p.name AS projectName,
                SUM(COALESCE(c.cost_usd, 0)) AS usd,
                SUM(COALESCE(c.cost_ai_credits, 0)) AS aiCredits,
                SUM(COALESCE(c.premium_requests, 0)) AS premiumRequests,
                COUNT(*) AS runCount
         FROM agent_cycles c
         JOIN tasks t ON t.task_id = c.task_id
         LEFT JOIN projects p ON p.id = t.project_id
         ${periodClause}
         GROUP BY t.project_id, p.name`
      )
      .all(...periodArgs) as Array<{
        projectId: string | null;
        projectName: string | null;
        usd: number;
        aiCredits: number;
        premiumRequests: number;
        runCount: number;
      }>;
    for (const row of aggregateRows) {
      const bucket = bucketFor(row.projectId, row.projectName);
      bucket.usd += row.usd;
      bucket.aiCredits += row.aiCredits;
      bucket.premiumRequests += row.premiumRequests;
      bucket.runCount += row.runCount;
    }

    // Pass 2: recompute cost for legacy cycles that have no USD snapshot but do
    // carry a captured event log (run counts already tallied in pass 1).
    const legacyRows = raw
      .prepare(
        `SELECT t.project_id AS projectId, p.name AS projectName,
                c.agent_events AS agentEvents, c.agent_result AS agentResult
         FROM agent_cycles c
         JOIN tasks t ON t.task_id = c.task_id
         LEFT JOIN projects p ON p.id = t.project_id
         WHERE c.cost_usd IS NULL
         ${sinceEpochSeconds !== null ? "AND c.created_at >= ?" : ""}`
      )
      .all(...periodArgs) as Array<{
        projectId: string | null;
        projectName: string | null;
        agentEvents: string | null;
        agentResult: string | null;
      }>;
    for (const row of legacyRows) {
      // Prefer the canonical `agent_events` column, but fall back to events
      // embedded in the serialized AgentResult for rows persisted before that
      // column existed (mirrors getAgentCycles' recompute-on-read behavior).
      let events: AgentLogEvent[] | undefined;
      if (row.agentEvents) {
        try {
          events = JSON.parse(row.agentEvents) as AgentLogEvent[];
        } catch {
          events = undefined;
        }
      }
      if (!events && row.agentResult) {
        try {
          events = (JSON.parse(row.agentResult) as AgentResult).agentEvents;
        } catch {
          events = undefined;
        }
      }
      if (!events) continue;
      const cost = computeCycleCost(events);
      if (!hasCostData(cost)) continue;
      const bucket = bucketFor(row.projectId, row.projectName);
      bucket.usd += cost.usd;
      bucket.aiCredits += cost.priced ? cost.aiCredits : 0;
      bucket.premiumRequests += cost.premiumRequests;
    }

    const perProject: CostSummaryProject[] = [...buckets.values()]
      .map((b) => ({
        projectId: b.projectId,
        projectName: b.projectName,
        usd: b.usd,
        aiCredits: b.aiCredits,
        premiumRequests: b.premiumRequests,
        runCount: b.runCount,
      }))
      .sort((a, b) => b.usd - a.usd || b.runCount - a.runCount);

    return {
      totalUsd: perProject.reduce((sum, p) => sum + p.usd, 0),
      totalAiCredits: perProject.reduce((sum, p) => sum + p.aiCredits, 0),
      totalPremiumRequests: perProject.reduce((sum, p) => sum + p.premiumRequests, 0),
      totalRuns: perProject.reduce((sum, p) => sum + p.runCount, 0),
      perProject,
      sinceEpochSeconds,
    };
  }

  /**
   * Aggregate AI-model usage (run count + USD) across all agent cycles, both
   * globally and per project. Cycles whose model id was not captured in a cost
   * snapshot but that carry an event log are recomputed so historical runs are
   * still attributed to the correct model.
   */
  async function getModelUsageSummary(options?: { since?: Date }): Promise<ModelUsageSummary> {
    const sinceEpochSeconds =
      options?.since !== undefined ? Math.floor(options.since.getTime() / 1000) : null;

    interface ModelAgg { runCount: number; usd: number }
    interface ProjectAgg { projectId: string | null; projectName: string | null; models: Map<string, ModelAgg> }

    const projectKey = (projectId: string | null): string => projectId ?? "\u0000__unassigned__";
    const modelKey = (modelId: string | null): string => modelId ?? "\u0000__unknown__";
    const projects = new Map<string, ProjectAgg>();

    const projectAggFor = (projectId: string | null, projectName: string | null): ProjectAgg => {
      const key = projectKey(projectId);
      let agg = projects.get(key);
      if (!agg) {
        agg = { projectId, projectName, models: new Map() };
        projects.set(key, agg);
      } else if (agg.projectName === null && projectName !== null) {
        agg.projectName = projectName;
      }
      return agg;
    };
    const addModel = (
      project: ProjectAgg,
      modelId: string | null,
      runCount: number,
      usd: number
    ): void => {
      const key = modelKey(modelId);
      const existing = project.models.get(key);
      if (existing) {
        existing.runCount += runCount;
        existing.usd += usd;
      } else {
        project.models.set(key, { runCount, usd });
      }
    };

    const periodArgs = sinceEpochSeconds !== null ? [sinceEpochSeconds] : [];

    // Pass 1: rows whose model is recorded (or that have no event log to
    // recompute from). Rows with a NULL model id but a captured event log are
    // deferred to pass 2 so they are attributed to their recomputed model.
    const aggregateRows = raw
      .prepare(
        `SELECT t.project_id AS projectId, p.name AS projectName,
                c.cost_model_id AS modelId,
                COUNT(*) AS runCount,
                SUM(COALESCE(c.cost_usd, 0)) AS usd
         FROM agent_cycles c
         JOIN tasks t ON t.task_id = c.task_id
         LEFT JOIN projects p ON p.id = t.project_id
         WHERE NOT (c.cost_model_id IS NULL AND COALESCE(c.agent_events, json_extract(c.agent_result, '$.agentEvents')) IS NOT NULL)
         ${sinceEpochSeconds !== null ? "AND c.created_at >= ?" : ""}
         GROUP BY t.project_id, p.name, c.cost_model_id`
      )
      .all(...periodArgs) as Array<{
        projectId: string | null;
        projectName: string | null;
        modelId: string | null;
        runCount: number;
        usd: number;
      }>;
    for (const row of aggregateRows) {
      const project = projectAggFor(row.projectId, row.projectName);
      addModel(project, row.modelId, row.runCount, row.usd);
    }

    // Pass 2: recompute model + USD for cycles missing a model snapshot.
    const legacyRows = raw
      .prepare(
        `SELECT t.project_id AS projectId, p.name AS projectName,
                COALESCE(c.agent_events, json_extract(c.agent_result, '$.agentEvents')) AS agentEvents
         FROM agent_cycles c
         JOIN tasks t ON t.task_id = c.task_id
         LEFT JOIN projects p ON p.id = t.project_id
         WHERE c.cost_model_id IS NULL AND COALESCE(c.agent_events, json_extract(c.agent_result, '$.agentEvents')) IS NOT NULL
         ${sinceEpochSeconds !== null ? "AND c.created_at >= ?" : ""}`
      )
      .all(...periodArgs) as Array<{
        projectId: string | null;
        projectName: string | null;
        agentEvents: string | null;
      }>;
    for (const row of legacyRows) {
      let modelId: string | null = null;
      let usd = 0;
      if (row.agentEvents) {
        try {
          const cost = computeCycleCost(JSON.parse(row.agentEvents) as AgentLogEvent[]);
          modelId = cost.modelId;
          usd = cost.usd;
        } catch {
          // Fall back to unknown model with zero cost.
        }
      }
      const project = projectAggFor(row.projectId, row.projectName);
      addModel(project, modelId, 1, usd);
    }

    // Build per-project view + fold into the global distribution.
    const globalModels = new Map<string, ModelAgg & { modelId: string | null }>();
    const perProject: ModelUsageProject[] = [];
    for (const project of projects.values()) {
      const models: ModelUsageEntry[] = [];
      for (const [key, agg] of project.models) {
        const modelId = key === "\u0000__unknown__" ? null : key;
        models.push({ modelId, runCount: agg.runCount, usd: agg.usd });
        const g = globalModels.get(key);
        if (g) {
          g.runCount += agg.runCount;
          g.usd += agg.usd;
        } else {
          globalModels.set(key, { modelId, runCount: agg.runCount, usd: agg.usd });
        }
      }
      models.sort((a, b) => b.runCount - a.runCount || b.usd - a.usd);
      perProject.push({ projectId: project.projectId, projectName: project.projectName, models });
    }

    const byModel: ModelUsageEntry[] = [...globalModels.values()]
      .map((m) => ({ modelId: m.modelId, runCount: m.runCount, usd: m.usd }))
      .sort((a, b) => b.runCount - a.runCount || b.usd - a.usd);

    perProject.sort(
      (a, b) =>
        b.models.reduce((s, m) => s + m.runCount, 0) - a.models.reduce((s, m) => s + m.runCount, 0)
    );

    return {
      byModel,
      perProject,
      totalRuns: byModel.reduce((s, m) => s + m.runCount, 0),
      totalUsd: byModel.reduce((s, m) => s + m.usd, 0),
      sinceEpochSeconds,
    };
  }

  return {
    createTask,
    getTask,
    getTaskByTicketId,
    getActiveTaskByTicketId,
    getActiveTasks,
    getAllTasks,
    transition,
    updateExternalChangeId,
    createReviewTask,
    setReviewedPatchset,
    incrementCycle,
    setFailureReason,
    saveAgentCycle,
    getAgentCycles,
    getAgentCycleEvents,
    getStateTransitions,
    getFailedAttemptCount,
    getProcessedCommentIds,
    markCommentProcessed,
    getPostedReviewCommentHashes,
    getPostedReviewComments,
    markReviewCommentsPosted,
    markReviewCommentResolved,
    getHandledThreadReplyHashes,
    markThreadReplyPosted,
    pauseTask,
    resumeTask,
    isTaskPaused,
    retryTask,
    abandonTask,
    deleteTask,
    deleteTaskGroup,
    saveChangePerRepository,
    getChangesForTask,
    getChangesForTasks,
    findTaskByExternalChangeId,
    findReviewedCodeReviewTask,
    setTaskProjectId,
    setTaskPushRef,
    updateChangePerRepositoryStatus,
    orphanExcessChanges,
    getFailedTasksForProject,
    getCostSummary,
    getModelUsageSummary,
  };
}

function parseIntegrationIdFromLabel(label: string | undefined | null): string | null {
  if (!label) return null;
  const separatorIndex = label.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === label.length - 1) return null;
  return label.slice(separatorIndex + 1);
}
