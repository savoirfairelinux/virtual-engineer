/**
 * Severity ranking and volume gating for review comments.
 *
 * Keeps the inline review noise low by (1) folding comments below a minimum
 * severity into the summary instead of posting them inline, and (2) capping the
 * number of inline comments per pass, folding the overflow into the summary.
 * This logic is integration-agnostic — it runs in the orchestrator before any
 * provider-specific posting.
 */
import type { InlineReviewComment } from "../interfaces.js";

/** Canonical severity ladder. Higher rank = more important. */
const SEVERITY_RANKS: Record<string, number> = {
  // nit / cosmetic
  nit: 0,
  nitpick: 0,
  note: 0,
  minor: 0,
  trivial: 0,
  // informational / suggestions
  info: 1,
  information: 1,
  suggestion: 1,
  style: 1,
  // warnings
  warning: 2,
  warn: 2,
  major: 2,
  // blocking issues
  error: 3,
  critical: 3,
  blocker: 3,
  blocking: 3,
  bug: 3,
};

/** Severities of unknown wording are treated as "info" so they are not silently dropped. */
const DEFAULT_RANK = SEVERITY_RANKS["info"] ?? 1;

/** Map a free-form severity string to its numeric rank (higher = more severe). */
export function severityRank(severity: string): number {
  const key = severity.trim().toLowerCase();
  return SEVERITY_RANKS[key] ?? DEFAULT_RANK;
}

export interface SeverityGateOptions {
  /** Minimum severity word for a comment to be posted inline. */
  minSeverity: string;
  /** Maximum number of inline comments to post; the rest are folded into the summary. */
  maxComments: number;
}

export interface SeverityGateResult {
  /** Comments to post inline (meet the severity threshold and fit under the cap). */
  posted: InlineReviewComment[];
  /** Comments folded into the summary (below threshold or over the cap). */
  folded: InlineReviewComment[];
}

/**
 * Partition comments into those to post inline versus those to fold into the
 * summary. Comments below `minSeverity` are always folded. The remaining
 * comments are sorted by severity (most severe first) and capped at
 * `maxComments`; any overflow is folded too.
 */
export function applyVolumeAndSeverityGate(
  comments: InlineReviewComment[],
  opts: SeverityGateOptions
): SeverityGateResult {
  const minRank = severityRank(opts.minSeverity);

  const eligible: InlineReviewComment[] = [];
  const folded: InlineReviewComment[] = [];
  for (const c of comments) {
    if (severityRank(c.severity) >= minRank) eligible.push(c);
    else folded.push(c);
  }

  // Stable sort by severity descending so the most important issues survive the cap.
  const sorted = eligible
    .map((c, i) => ({ c, i }))
    .sort((a, b) => severityRank(b.c.severity) - severityRank(a.c.severity) || a.i - b.i)
    .map((x) => x.c);

  const posted = sorted.slice(0, Math.max(0, opts.maxComments));
  const overCap = sorted.slice(Math.max(0, opts.maxComments));

  return { posted, folded: [...folded, ...overCap] };
}

/**
 * Render the comments that were folded into the summary as a compact appendix.
 * Returns an empty string when there is nothing to fold.
 */
export function buildFoldedSummary(folded: InlineReviewComment[]): string {
  if (folded.length === 0) return "";
  const lines = folded.map((c) => {
    const message = c.message.replace(/\s+/g, " ").trim();
    const severity = c.severity.trim() || "note";
    return `- ${c.file}:${c.line} (${severity}) — ${message}`;
  });
  return ["", "Additional notes (not posted inline):", ...lines].join("\n");
}
