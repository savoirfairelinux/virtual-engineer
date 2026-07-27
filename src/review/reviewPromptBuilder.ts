/**
 * Review prompt builder.
 *
 * Assembles the full prompt string passed to the review agent by combining
 * change metadata, the diff, and per-reviewer instructions.
 */
import type { ReviewChangeDetails, ReviewChangeDiff, ReviewDiscussionThread } from "../interfaces.js";

/** Default upper bound on diff size injected into the prompt to avoid token blow-ups. */
const DEFAULT_MAX_DIFF_CHARS = 60_000;
const DEFAULT_MAX_COMMIT_MESSAGE_CHARS = 8_000;
const TRUNCATION_NOTE =
  "\n\n[... diff truncated to fit in the model context — review the rest from the repository if needed ...]";
const COMMIT_MESSAGE_TRUNCATION_NOTE =
  "\n\n[... commit message truncated to fit in the model context ...]";

export interface ReviewPromptInput {
  details: ReviewChangeDetails;
  diff: ReviewChangeDiff;
  /** User instructions/checklist for the review task. Required. */
  userPrompt: string;
  /** Optional override for the max diff size in characters. Defaults to 60 000. */
  maxDiffChars?: number | undefined;
  /**
   * Comments VE has already posted on this change in previous review cycles.
   * Injected so the agent does not re-raise points it has already made.
   */
  priorComments?: PriorReviewComment[] | undefined;
  /**
   * Open human discussion threads the agent may reply to. Each thread carries a
   * `threadId` the agent must echo back in its `replies[]` output to address it.
   */
  discussionThreads?: ReviewDiscussionThread[] | undefined;
  /**
   * On a re-review, the diff between the last patchset VE reviewed and the
   * current one. Surfaced as a focused "what changed since my last review"
   * section so the agent concentrates new findings on the delta while still
   * seeing the full change. Omitted on the first review pass.
   */
  sinceLastReview?: SinceLastReviewDelta | undefined;
}

/** Inter-patchset delta surfaced to the agent on a re-review. */
export interface SinceLastReviewDelta {
  /** Patchset VE last reviewed. */
  fromPatchset: number;
  /** Current patchset under review. */
  toPatchset: number;
  /** Diff between `fromPatchset` and `toPatchset`. */
  diff: ReviewChangeDiff;
}

/** A previously-posted review comment surfaced back to the agent as memory. */
export interface PriorReviewComment {
  file: string;
  line: number;
  message: string;
}

/** Build the full prompt sent to the review agent for a single change. */
export function buildReviewPrompt(input: ReviewPromptInput): string {
  const { details, diff, userPrompt, maxDiffChars, priorComments, discussionThreads, sinceLastReview } =
    input;

  const effectiveMax = maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS;
  const hasDelta = sinceLastReview !== undefined && sinceLastReview.diff.files.length > 0;
  // When both a delta section and a full diff are present, split the budget
  // equally so the combined diff content stays within effectiveMax chars.
  const deltaBudget = hasDelta ? Math.floor(effectiveMax / 2) : effectiveMax;
  const fullDiffBudget = hasDelta ? effectiveMax - deltaBudget : effectiveMax;

  const header = [
    `# Code Review Task`,
    ``,
    `Project: ${details.project}`,
    `Branch:  ${details.targetBranch}`,
    `Change:  ${details.changeId} (patchset ${diff.patchset})`,
    `Subject: ${details.subject}`,
    `URL:     ${details.url}`,
  ].join("\n");

  const fileListing = diff.files
    .map((f) => `- ${f.status.toUpperCase().padEnd(8)} ${f.path}`)
    .join("\n");

  const diffSections = renderDiffSections(diff, fullDiffBudget);

  const sections = [
    header,
  ];

  // Commit message body ("the why"). Omitted when the change has no description
  // beyond its subject so we never inject an empty section.
  const description = details.description.trim();
  if (description.length > 0) {
    sections.push(``, `## Commit message`, truncateCommitMessage(description));
  }

  sections.push(
    ``,
    `## User Instructions`,
    userPrompt,
  );

  if (priorComments && priorComments.length > 0) {
    sections.push(``, `## Already reported (do not repeat)`, renderPriorComments(priorComments));
  }

  if (discussionThreads && discussionThreads.length > 0) {
    sections.push(
      ``,
      `## Open discussion threads (respond where relevant)`,
      renderDiscussionThreads(discussionThreads),
    );
  }

  if (sinceLastReview && sinceLastReview.diff.files.length > 0) {
    sections.push(
      ``,
      `## Changes since last reviewed patchset (PS ${sinceLastReview.fromPatchset} \u2192 ${sinceLastReview.toPatchset})`,
      renderSinceLastReview(sinceLastReview, deltaBudget),
    );
  }

  sections.push(
    ``,
    `## Files in this patchset`,
    fileListing || "(no files reported)",
    ``,
    `## Unified diffs`,
    diffSections,
  );

  return sections.join("\n");
}

/**
 * Render previously-posted comments as a compact checklist. The agent is told
 * not to repeat these so re-reviews only surface genuinely new findings.
 */
function renderPriorComments(priorComments: PriorReviewComment[]): string {
  const lines = priorComments.map((c) => {
    const message = c.message.replace(/\s+/g, " ").trim();
    return `- ${c.file}:${c.line} — ${message}`;
  });
  return [
    "You have already left the following comments on this change in earlier",
    "review cycles. Do NOT repeat them; only report genuinely new issues:",
    "",
    ...lines,
  ].join("\n");
}

/**
 * Render open human discussion threads as a numbered list. Each thread is
 * labelled with its opaque `threadId`; the agent must echo that id back in a
 * `replies[]` entry to address the thread. Replies are optional per thread.
 */
function renderDiscussionThreads(threads: ReviewDiscussionThread[]): string {
  const blocks = threads.map((thread) => {
    const anchor =
      thread.file !== null
        ? thread.line !== null
          ? `${thread.file}:${thread.line}`
          : thread.file
        : "(change-level)";
    const conversation = thread.comments
      .map((c) => {
        const who = c.isOwn ? `${c.author} (you)` : c.author;
        const message = c.message.replace(/\s+/g, " ").trim();
        return `    ${who}: ${message}`;
      })
      .join("\n");
    return [`- threadId: ${thread.threadId}  [${anchor}]`, conversation].join("\n");
  });
  return [
    "The following human discussion threads are open. Reply only where you can",
    "add value (answer a question, agree/disagree with reasoning, clarify your",
    "earlier feedback). To reply, add an entry to `replies[]` with the matching",
    "`threadId`. Leave a thread out if no reply is warranted.",
    "",
    ...blocks,
  ].join("\n");
}

/** Render each file's diff as a fenced code block, truncating when the total exceeds `maxDiffChars`. */
function renderDiffSections(diff: ReviewChangeDiff, maxDiffChars: number): string {
  const parts: string[] = [];
  let used = 0;
  for (const file of diff.files) {
    const block = `### ${file.path} (${file.status})\n\`\`\`diff\n${file.patch || "(no textual diff)"}\n\`\`\``;
    if (used + block.length > maxDiffChars) {
      parts.push(TRUNCATION_NOTE);
      break;
    }
    parts.push(block);
    used += block.length;
  }
  return parts.join("\n\n");
}

function truncateCommitMessage(description: string): string {
  if (description.length <= DEFAULT_MAX_COMMIT_MESSAGE_CHARS) return description;
  const bodyLimit = DEFAULT_MAX_COMMIT_MESSAGE_CHARS - COMMIT_MESSAGE_TRUNCATION_NOTE.length;
  return description.slice(0, bodyLimit) + COMMIT_MESSAGE_TRUNCATION_NOTE;
}

/**
 * Render the inter-patchset delta as a guidance note followed by the delta diff.
 * Caps the diff with the same per-section budget as the full diff. Rebase noise
 * (upstream changes pulled in between patchsets) may appear here; the note tells
 * the agent to treat it as such.
 */
function renderSinceLastReview(delta: SinceLastReviewDelta, maxDiffChars: number): string {
  return [
    "These are the changes between the patchset you last reviewed and the current",
    "one. Focus genuinely new findings on this delta. If the change was rebased,",
    "some hunks here may be upstream churn rather than author edits — judge",
    "accordingly. The full change is still provided below for context.",
    "",
    renderDiffSections(delta.diff, maxDiffChars),
  ].join("\n");
}
