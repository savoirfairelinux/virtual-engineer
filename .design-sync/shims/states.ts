import type { TaskState } from "./types.ts";

export const TONE = {
  active: { c: "var(--accent-strong)", bg: "var(--accent-soft)", b: "var(--accent-line)" },
  ok:     { c: "var(--ok)",            bg: "var(--ok-soft)",     b: "var(--ok)" },
  warn:   { c: "var(--warn)",          bg: "var(--warn-soft)",   b: "var(--warn)" },
  danger: { c: "var(--danger)",        bg: "var(--danger-soft)", b: "var(--danger)" },
  info:   { c: "var(--info)",          bg: "var(--info-soft)",   b: "var(--info)" },
  muted:  { c: "var(--muted-state)",   bg: "var(--muted-state-soft)", b: "var(--muted-state)" },
} as const;

export type ToneKey = keyof typeof TONE;

export const STATES: Record<TaskState, { label: string; tone: ToneKey; kind: "gen" | "rev" }> = {
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
  REVIEW_PENDING:      { label: "REVIEW_PENDING",      tone: "info",   kind: "rev" },
  REVIEW_RUNNING:      { label: "REVIEW_RUNNING",      tone: "active", kind: "rev" },
  REVIEW_COMMENTING:   { label: "REVIEW_COMMENTING",   tone: "active", kind: "rev" },
  REVIEW_WATCHING:     { label: "REVIEW_WATCHING",     tone: "warn",   kind: "rev" },
  REVIEW_DONE:         { label: "REVIEW_DONE",         tone: "ok",     kind: "rev" },
  REVIEW_FAILED:       { label: "REVIEW_FAILED",       tone: "danger", kind: "rev" },
};
