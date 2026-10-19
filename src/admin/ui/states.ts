import type { TaskState } from "./types.ts";

/* ─── Tone palette mapping ─────────────────────────────────────────────── */
export const TONE = {
  active: { c: "var(--accent-strong)", bg: "var(--accent-soft)", b: "var(--accent-line)" },
  ok:     { c: "var(--ok)",            bg: "var(--ok-soft)",     b: "var(--ok)" },
  warn:   { c: "var(--warn)",          bg: "var(--warn-soft)",   b: "var(--warn)" },
  danger: { c: "var(--danger)",        bg: "var(--danger-soft)", b: "var(--danger)" },
  info:   { c: "var(--info)",          bg: "var(--info-soft)",   b: "var(--info)" },
  muted:  { c: "var(--muted-state)",   bg: "var(--muted-state-soft)", b: "var(--muted-state)" },
} as const;

export type ToneKey = keyof typeof TONE;

/* ─── State catalog ────────────────────────────────────────────────────── */
export interface StateMeta {
  label: string;
  tone: ToneKey;
  kind: "gen" | "rev";
}

export const STATES: Record<TaskState, StateMeta> = {
  // code-gen flow
  DETECTED:            { label: "DETECTED",            tone: "info",   kind: "gen" },
  CONTEXT_BUILDING:    { label: "IN_QUEUE",            tone: "info",   kind: "gen" },
  AGENT_RUNNING:       { label: "AGENT_RUNNING",       tone: "active", kind: "gen" },
  IN_REVIEW:           { label: "IN_REVIEW",           tone: "warn",   kind: "gen" },
  FEEDBACK_PROCESSING: { label: "FEEDBACK_PROCESSING", tone: "active", kind: "gen" },
  RETRY_CYCLE:         { label: "IN_QUEUE",            tone: "info",   kind: "gen" },
  MERGED:              { label: "MERGED",              tone: "ok",     kind: "gen" },
  CLOSING:             { label: "CLOSING",             tone: "active", kind: "gen" },
  DONE:                { label: "DONE",                tone: "ok",     kind: "gen" },
  FAILED:              { label: "FAILED",              tone: "danger", kind: "gen" },
  ABANDONED:           { label: "ABANDONED",           tone: "muted",  kind: "gen" },
  // code-review flow
  REVIEW_PENDING:      { label: "REVIEW_PENDING",      tone: "info",   kind: "rev" },
  REVIEW_RUNNING:      { label: "REVIEW_RUNNING",      tone: "active", kind: "rev" },
  REVIEW_COMMENTING:   { label: "REVIEW_COMMENTING",   tone: "active", kind: "rev" },
  REVIEW_WATCHING:     { label: "REVIEW_WATCHING",     tone: "warn",   kind: "rev" },
  REVIEW_DONE:         { label: "REVIEW_DONE",         tone: "ok",     kind: "rev" },
  REVIEW_FAILED:       { label: "REVIEW_FAILED",       tone: "danger", kind: "rev" },
};

/* ─── Pipeline sequences ──────────────────────────────────────────────── */
export const GEN_PIPELINE: TaskState[] = [
  "DETECTED", "CONTEXT_BUILDING", "AGENT_RUNNING",
  "IN_REVIEW", "MERGED", "CLOSING", "DONE",
];
export const REV_PIPELINE: TaskState[] = [
  "REVIEW_PENDING", "REVIEW_RUNNING", "REVIEW_COMMENTING",
  "REVIEW_WATCHING", "REVIEW_DONE",
];

/* Short label per node */
export const NODE_SHORT: Partial<Record<TaskState, string>> = {
  DETECTED:          "Detected",
  CONTEXT_BUILDING:  "Queue",
  AGENT_RUNNING:     "Agent",
  RETRY_CYCLE:       "Queue",
  IN_REVIEW:         "Review",
  MERGED:            "Merged",
  CLOSING:           "Closing",
  DONE:              "Done",
  REVIEW_PENDING:    "Pending",
  REVIEW_RUNNING:    "Reviewing",
  REVIEW_COMMENTING: "Commenting",
  REVIEW_WATCHING:   "Watching",
  REVIEW_DONE:       "Done",
};

/* Off-pipeline states anchor to another node and optionally flag the retry loop */
export const STATE_ANCHOR: Partial<Record<TaskState, { anchor: TaskState; loop: boolean }>> = {
  FEEDBACK_PROCESSING: { anchor: "IN_REVIEW",      loop: true },
  RETRY_CYCLE:         { anchor: "AGENT_RUNNING",  loop: true },
  REVIEW_COMMENTING:   { anchor: "REVIEW_COMMENTING", loop: false },
};

/* Where a bad-terminal state diverges from the happy path */
export const TERM_DIVERGE: Partial<Record<TaskState, TaskState>> = {
  FAILED:        "AGENT_RUNNING",
  ABANDONED:     "IN_REVIEW",
  REVIEW_FAILED: "REVIEW_RUNNING",
};

/* Dashboard categories, mirrored from src/domain/tasks.ts (not importable across the UI build boundary). */
export type TaskStatusCategory = "running" | "queued" | "watching" | "completed" | "failed" | "abandoned";
type WorkflowBucket = "active" | "watching" | "done" | "failed";

export function classifyStatusCategory(state: TaskState): TaskStatusCategory {
  switch (state) {
    case "AGENT_RUNNING":
    case "FEEDBACK_PROCESSING":
    case "CLOSING":
    case "REVIEW_RUNNING":
    case "REVIEW_COMMENTING":
      return "running";
    case "DETECTED":
    case "CONTEXT_BUILDING":
    case "RETRY_CYCLE":
    case "REVIEW_PENDING":
      return "queued";
    case "IN_REVIEW":
    case "REVIEW_WATCHING":
      return "watching";
    case "MERGED":
    case "DONE":
    case "REVIEW_DONE":
      return "completed";
    case "FAILED":
    case "REVIEW_FAILED":
      return "failed";
    case "ABANDONED":
      return "abandoned";
    default: {
      // Exhaustiveness check — a new TaskState must be classified here.
      const _exhaustive: never = state;
      throw new Error(`Unclassified task state: ${String(_exhaustive)}`);
    }
  }
}

/* Display order, label and tone for each category; STATES tones follow these. */
export const STATUS_CATEGORIES: readonly { id: TaskStatusCategory; label: string; tone: ToneKey }[] = [
  { id: "running",   label: "Running",   tone: "active" },
  { id: "queued",    label: "Queued",    tone: "info" },
  { id: "watching",  label: "Watching",  tone: "warn" },
  { id: "completed", label: "Completed", tone: "ok" },
  { id: "failed",    label: "Failed",    tone: "danger" },
  { id: "abandoned", label: "Abandoned", tone: "muted" },
];

const CATEGORY_WORKFLOW_BUCKET: Readonly<Record<TaskStatusCategory, WorkflowBucket>> = {
  running: "active",
  queued: "active",
  watching: "watching",
  completed: "done",
  failed: "failed",
  abandoned: "failed",
};

export function classifyWorkflowBucket(state: TaskState): WorkflowBucket {
  return CATEGORY_WORKFLOW_BUCKET[classifyStatusCategory(state)];
}

export const TERMINAL_STATES = new Set<TaskState>(
  (Object.keys(STATES) as TaskState[]).filter((s) => {
    const bucket = classifyWorkflowBucket(s);
    return bucket === "done" || bucket === "failed";
  })
);

export const ACTIVE_STATES = new Set<TaskState>(
  (Object.keys(STATES) as TaskState[]).filter((s) => classifyWorkflowBucket(s) === "active")
);

export function isActiveState(s: TaskState): boolean {
  return ACTIVE_STATES.has(s);
}

export function isTerminalState(s: TaskState): boolean {
  return TERMINAL_STATES.has(s);
}
