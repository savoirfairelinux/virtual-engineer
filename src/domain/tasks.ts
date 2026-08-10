import type {
  ExternalChangeId,
  ProjectId,
  TaskId,
  TicketId,
} from "./identifiers.js";

export const CODE_GEN_STATES = [
  "DETECTED",
  "CONTEXT_BUILDING",
  "AGENT_RUNNING",
  "IN_REVIEW",
  "FEEDBACK_PROCESSING",
  "RETRY_CYCLE",
  "MERGED",
  "CLOSING",
  "DONE",
  "FAILED",
  "ABANDONED",
] as const;

export const CODE_REVIEW_STATES = [
  "REVIEW_PENDING",
  "REVIEW_RUNNING",
  "REVIEW_COMMENTING",
  "REVIEW_WATCHING",
  "REVIEW_DONE",
  "REVIEW_FAILED",
] as const;

export type CodeGenState = (typeof CODE_GEN_STATES)[number];
export type CodeReviewState = (typeof CODE_REVIEW_STATES)[number];

export const TASK_STATES = [...CODE_GEN_STATES, ...CODE_REVIEW_STATES] as const;

export type TaskState = CodeGenState | CodeReviewState;
export type TaskType = "code-gen" | "code-review";

export const CODE_GEN_TERMINAL_STATES: ReadonlySet<CodeGenState> = new Set<CodeGenState>([
  "DONE",
  "FAILED",
  "ABANDONED",
]);

export const CODE_REVIEW_TERMINAL_STATES: ReadonlySet<CodeReviewState> = new Set<CodeReviewState>([
  "REVIEW_DONE",
  "REVIEW_FAILED",
]);

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  ...CODE_GEN_TERMINAL_STATES,
  ...CODE_REVIEW_TERMINAL_STATES,
]);

/** Dashboard-facing workflow bucket for a task state — distinct from state-machine terminality. */
export type TaskWorkflowBucket = "active" | "watching" | "done" | "failed";

function classifyTaskWorkflowBucket(state: TaskState): TaskWorkflowBucket {
  switch (state) {
    case "DETECTED":
    case "CONTEXT_BUILDING":
    case "AGENT_RUNNING":
    case "FEEDBACK_PROCESSING":
    case "RETRY_CYCLE":
    case "CLOSING":
    case "REVIEW_RUNNING":
    case "REVIEW_COMMENTING":
      return "active";
    case "IN_REVIEW":
    case "REVIEW_PENDING":
    case "REVIEW_WATCHING":
      return "watching";
    case "MERGED":
    case "DONE":
    case "REVIEW_DONE":
      return "done";
    case "FAILED":
    case "ABANDONED":
    case "REVIEW_FAILED":
      return "failed";
    default: {
      // Exhaustiveness check — a new TaskState must be classified here.
      const _exhaustive: never = state;
      throw new Error(`Unclassified task state: ${String(_exhaustive)}`);
    }
  }
}

/** Single source of truth for dashboard bucketing (active/watching/done/failed) across every `TaskState`. */
export const TASK_WORKFLOW_BUCKETS: ReadonlyMap<TaskState, TaskWorkflowBucket> = new Map(
  TASK_STATES.map((state) => [state, classifyTaskWorkflowBucket(state)])
);

export interface Task {
  taskId: TaskId;
  ticketId: TicketId;
  ticketSourceLabel: string;
  ticketTitle: string;
  ticketDescription: string;
  state: TaskState;
  taskType: TaskType;
  externalChangeId: ExternalChangeId | null;
  currentPatchset: number;
  reviewedPatchset: number | null;
  cycleCount: number;
  createdAt: Date;
  updatedAt: Date;
  failureReason: string | null;
  ticketUrl: string | null;
  reviewUrl: string | null;
  projectId?: ProjectId | null | undefined;
  displayId: string | null;
  pushRef?: string | null;
}

export interface ChangePerRepository {
  id: string;
  taskId: TaskId;
  repoKey: string;
  changeId: string;
  reviewUrl: string | null;
  status: string;
  integrationId: string;
  reviewSystem: string;
  commitIndex: number;
  subjectHash: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StateTransition {
  id: number;
  taskId: TaskId;
  fromState: TaskState;
  toState: TaskState;
  metadata: Record<string, unknown>;
  createdAt: Date;
}