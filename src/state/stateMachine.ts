import type { TaskState, CodeGenState, CodeReviewState } from "../interfaces.js";
import { TERMINAL_STATES } from "../interfaces.js";

/**
 * Valid transitions for the code-generation workflow.
 */
export const CODE_GEN_TRANSITIONS: ReadonlyMap<CodeGenState, ReadonlySet<CodeGenState>> = new Map([
  ["DETECTED", new Set<CodeGenState>(["CONTEXT_BUILDING", "FAILED"])],
  ["CONTEXT_BUILDING", new Set<CodeGenState>(["AGENT_RUNNING", "FAILED"])],
  ["AGENT_RUNNING", new Set<CodeGenState>(["IN_REVIEW", "RETRY_CYCLE", "FAILED", "ABANDONED"])],
  [
    "IN_REVIEW",
    new Set<CodeGenState>(["FEEDBACK_PROCESSING", "MERGED", "ABANDONED", "FAILED"]),
  ],
  [
    "FEEDBACK_PROCESSING",
    new Set<CodeGenState>(["RETRY_CYCLE", "IN_REVIEW", "FAILED", "ABANDONED"]),
  ],
  ["RETRY_CYCLE", new Set<CodeGenState>(["AGENT_RUNNING", "ABANDONED", "FAILED"])],
  ["MERGED", new Set<CodeGenState>(["CLOSING", "DONE", "FAILED"])],
  ["CLOSING", new Set<CodeGenState>(["DONE", "FAILED"])],
  // Terminal states — no outgoing transitions
  ["DONE", new Set<CodeGenState>()],
  ["FAILED", new Set<CodeGenState>()],
  ["ABANDONED", new Set<CodeGenState>()],
]);

/**
 * Valid transitions for the code-review workflow.
 */
export const CODE_REVIEW_TRANSITIONS: ReadonlyMap<CodeReviewState, ReadonlySet<CodeReviewState>> = new Map([
  ["REVIEW_PENDING", new Set<CodeReviewState>(["REVIEW_RUNNING", "REVIEW_FAILED"])],
  ["REVIEW_RUNNING", new Set<CodeReviewState>(["REVIEW_COMMENTING", "REVIEW_FAILED"])],
  [
    "REVIEW_COMMENTING",
    new Set<CodeReviewState>(["REVIEW_WATCHING", "REVIEW_DONE", "REVIEW_FAILED"]),
  ],
  [
    "REVIEW_WATCHING",
    new Set<CodeReviewState>(["REVIEW_RUNNING", "REVIEW_DONE", "REVIEW_FAILED"]),
  ],
  // Terminal states — no outgoing transitions
  ["REVIEW_DONE", new Set<CodeReviewState>()],
  ["REVIEW_FAILED", new Set<CodeReviewState>()],
]);

/**
 * Valid transitions for the Virtual Engineer state machine.
 * Key = current state, value = set of allowed next states.
 */
export const VALID_TRANSITIONS: ReadonlyMap<TaskState, ReadonlySet<TaskState>> = new Map([
  ...CODE_GEN_TRANSITIONS,
  ...CODE_REVIEW_TRANSITIONS,
] as [TaskState, ReadonlySet<TaskState>][]);

/** Error thrown when a requested state transition is not permitted by the state machine. */
export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: TaskState,
    public readonly to: TaskState
  ) {
    super(`Invalid state transition: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

/**
 * Validate a state transition. Returns `"idempotent"` when already in target state.
 * Throws `InvalidTransitionError` if the transition is not allowed.
 */
export function validateTransition(from: TaskState, to: TaskState): "valid" | "idempotent" {
  if (from === to) return "idempotent";

  if (TERMINAL_STATES.has(from)) {
    throw new InvalidTransitionError(from, to);
  }

  const allowed = VALID_TRANSITIONS.get(from);
  if (!allowed?.has(to)) {
    throw new InvalidTransitionError(from, to);
  }

  return "valid";
}
