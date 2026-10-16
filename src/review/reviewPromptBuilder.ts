/**
 * Review prompt builder.
 *
 * Assembles the full prompt string passed to the review agent by combining
 * change metadata, the diff, and per-reviewer instructions.
 */
import type {
  ReviewChangeDetails,
  ReviewChangeDiff,
  ReviewDiscussionThread,
  ReviewMergeContext,
} from "../interfaces.js";

const DEFAULT_MAX_COMMIT_MESSAGE_CHARS = 8_000;
const COMMIT_MESSAGE_TRUNCATION_NOTE =
  "\n\n[... commit message truncated to fit in the model context ...]";
const MAX_LISTED_MERGED_COMMITS = 100;

export interface ReviewPromptInput {
  details: ReviewChangeDetails;
  diff: ReviewChangeDiff;
  /** Instructions/checklist appended to the dynamic review user prompt. */
  instructionsPrompt: string;
  /**
   * Comments VE has already posted on this change in previous review cycles.
   * Injected so the agent does not re-raise points it has already made.
   */
  priorComments?: PriorReviewComment[] | undefined;
  /** Hosted reviews reassess prior findings by their stable persisted IDs. */
  reassessPriorFindings?: boolean | undefined;
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
  id?: number | undefined;
  file: string;
  line: number;
  message: string;
}

/** Build the full prompt sent to the review agent for a single change. */
export function buildReviewPrompt(input: ReviewPromptInput): string {
  const {
    details,
    diff,
    instructionsPrompt,
    priorComments,
    reassessPriorFindings,
    discussionThreads,
    sinceLastReview,
  } = input;

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

  const diffSections = renderDiffSections(diff);

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
    `## Review Instructions`,
    instructionsPrompt,
  );

  if (priorComments && priorComments.length > 0) {
    sections.push(
      ``,
      reassessPriorFindings === true ? `## Previous findings to reassess` : `## Already reported (do not repeat)`,
      renderPriorComments(priorComments, reassessPriorFindings === true),
    );
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
      renderSinceLastReview(sinceLastReview),
    );
  }

  if (diff.merge !== undefined) {
    sections.push(``, `## Merge commit`, renderMergeContext(diff.merge, details.targetBranch));
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
function renderPriorComments(priorComments: PriorReviewComment[], reassess: boolean): string {
  const lines = priorComments.map((c) => {
    const message = c.message.replace(/\s+/g, " ").trim();
    if (reassess && c.id === undefined) {
      throw new Error("A prior finding cannot be reassessed without a persisted finding ID");
    }
    return `- ${reassess ? `findingId: ${c.id} · ` : ""}${c.file}:${c.line} — ${message}`;
  });
  const instructions = reassess
    ? [
        "For each findingId, inspect the current code and classify it as",
        "still_present, fixed, or uncertain in priorFindingAssessments, with",
        "concrete evidence. A resolved discussion alone does not prove a fix.",
        "Do not repeat still-present findings as new comments. Report a",
        "regression as a new finding only if an earlier issue was fixed.",
      ]
    : [
        "You have already left the following comments on this change in earlier",
        "review cycles. Do NOT repeat them; only report genuinely new issues:",
      ];
  return [
    ...instructions,
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

/** Render every file's diff; an oversized prompt must fail, not silently omit files. */
function renderDiffSections(diff: ReviewChangeDiff): string {
  return diff.files.map((file) =>
    `### ${file.path} (${file.status})\n\`\`\`diff\n${file.patch || "(no textual diff)"}\n\`\`\``
  ).join("\n\n");
}

function truncateCommitMessage(description: string): string {
  if (description.length <= DEFAULT_MAX_COMMIT_MESSAGE_CHARS) return description;
  const bodyLimit = DEFAULT_MAX_COMMIT_MESSAGE_CHARS - COMMIT_MESSAGE_TRUNCATION_NOTE.length;
  return description.slice(0, bodyLimit) + COMMIT_MESSAGE_TRUNCATION_NOTE;
}

/**
 * Render the inter-patchset delta as a guidance note followed by the delta diff.
 * Rebase noise (upstream changes pulled in between patchsets) may appear here;
 * the note tells the agent to treat it as such.
 */
function renderSinceLastReview(delta: SinceLastReviewDelta): string {
  return [
    "These are the changes between the patchset you last reviewed and the current",
    "one. Focus genuinely new findings on this delta. If the change was rebased,",
    "some hunks here may be upstream churn rather than author edits — judge",
    "accordingly. The full change is still provided below for context.",
    "",
    renderDiffSections(delta.diff),
  ].join("\n");
}

/** Scope a merge review to the merge's own changes; merged commits are context only. */
function renderMergeContext(merge: ReviewMergeContext, targetBranch: string): string {
  const [targetParent, mergedParent] = merge.parents;
  const lines = [
    `This change merges ${shortSha(mergedParent)} into \`${targetBranch}\` (first parent ${shortSha(targetParent)}).`,
    "The diff below compares the merge with the automatic merge of both parents, so it contains only",
    "what the merge itself changes: conflict resolutions (marked by `remerge CONFLICT` headers), manual",
    "edits, and changes from either parent that the merge dropped. Review only these changes: check that",
    "each resolution keeps the intent of both sides and that dropped changes are intentional.",
  ];
  if (merge.mergedCommits.length > 0) {
    lines.push(
      "",
      "The merged commits below were already reviewed in their own changes. Use them as context only and",
      "do not review their content again:",
      ...merge.mergedCommits
        .slice(0, MAX_LISTED_MERGED_COMMITS)
        .map((commit) => `- ${shortSha(commit.sha)} ${commit.subject}`),
    );
    const unlisted = merge.mergedCommits.length - MAX_LISTED_MERGED_COMMITS;
    if (unlisted > 0) lines.push(`- … and ${unlisted} more merged commits`);
  }
  lines.push(
    "",
    merge.commentableFiles.length > 0
      ? `Inline comments are accepted only on: ${merge.commentableFiles.map((path) => `\`${path}\``).join(", ")}. ` +
        "Report findings about other files in the summary, and use line 0 for files deleted by the merge."
      : "No file accepts inline comments on this merge: report every finding in the summary.",
  );
  return lines.join("\n");
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}
