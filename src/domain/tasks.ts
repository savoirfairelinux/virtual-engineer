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