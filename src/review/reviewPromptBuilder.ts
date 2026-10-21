/**
 * Review prompt builder.
 *
 * Assembles the full prompt string passed to the review agent by combining
 * change metadata, the diff, and per-reviewer instructions.
 */
import {
  REVIEW_ATTACHMENT_DIR,
  type ReviewAttachment,
  type ReviewChangeDetails,
  type ReviewChangeDiff,
  type ReviewDiscussionThread,
  type ReviewMergeContext,
} from "../interfaces.js";

const DEFAULT_MAX_COMMIT_MESSAGE_CHARS = 8_000;
/**
 * Upper bound on inline diff content, including file listings, delta guidance,
 * notices, and separators (~100k tokens). Larger diffs are attached in full as
 * repository files so the agent keeps access to every file.
 */
export const DEFAULT_MAX_INLINE_DIFF_CHARS = 400_000;
export const FULL_DIFF_ATTACHMENT = "change.diff";
export const DELTA_DIFF_ATTACHMENT = "since-last-review.diff";
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
  /** Inline diff budget in characters; defaults to {@link DEFAULT_MAX_INLINE_DIFF_CHARS}. */
  maxInlineDiffChars?: number | undefined;
}

/** Prompt plus the files it references, which must be written before the agent runs. */
export interface ReviewPrompt {
  prompt: string;
  attachments: ReviewAttachment[];
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
export function buildReviewPrompt(input: ReviewPromptInput): ReviewPrompt {
  const {
    details,
    diff,
    instructionsPrompt,
    priorComments,
    reassessPriorFindings,
    discussionThreads,
    sinceLastReview,
    maxInlineDiffChars = DEFAULT_MAX_INLINE_DIFF_CHARS,
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

  let fileListing = diff.files
    .map((f) => `- ${f.status.toUpperCase().padEnd(8)} ${f.path}`)
    .join("\n") || "(no files reported)";

  const hasDelta = sinceLastReview !== undefined && sinceLastReview.diff.files.length > 0;
  const attachments: ReviewAttachment[] = [];
  const fullDiffText = renderDiffSections(diff.files);
  const deltaDiffText = hasDelta ? renderDiffSections(sinceLastReview.diff.files) : "";
  const deltaGuidanceLength = hasDelta ? renderSinceLastReview("").length : 0;
  const fitsInline =
    fileListing.length + fullDiffText.length + deltaDiffText.length + deltaGuidanceLength <= maxInlineDiffChars;
  if (!fitsInline) {
    fileListing = `See the diffs and their attachments for all ${diff.files.length} files.`;
  }
  const diffBudget = maxInlineDiffChars - fileListing.length - deltaGuidanceLength;
  // Over budget, the delta gets at most half the budget and the full diff the rest.
  const deltaBudget = hasDelta ? Math.floor(diffBudget / 2) : 0;
  const deltaSections = fitsInline || !hasDelta || deltaDiffText.length <= deltaBudget
    ? deltaDiffText
    : renderBudgetedDiff(sinceLastReview.diff, deltaBudget, DELTA_DIFF_ATTACHMENT, attachments);
  const fullBudget = diffBudget - deltaSections.length;
  const diffSections = fitsInline || fullDiffText.length <= fullBudget
    ? fullDiffText
    : renderBudgetedDiff(diff, fullBudget, FULL_DIFF_ATTACHMENT, attachments);

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

  if (hasDelta) {
    sections.push(
      ``,
      `## Changes since last reviewed patchset (PS ${sinceLastReview.fromPatchset} \u2192 ${sinceLastReview.toPatchset})`,
      renderSinceLastReview(deltaSections),
    );
  }

  if (diff.merge !== undefined) {
    sections.push(``, `## Merge commit`, renderMergeContext(diff.merge, details.targetBranch));
  }

  sections.push(
    ``,
    `## Files in this patchset`,
    fileListing,
    ``,
    `## Unified diffs`,
    diffSections,
  );

  return { prompt: sections.join("\n"), attachments };
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

type ReviewDiffFile = ReviewChangeDiff["files"][number];

function renderFileDiff(file: ReviewDiffFile): string {
  return `### ${file.path} (${file.status})\n\`\`\`diff\n${file.patch || "(no textual diff)"}\n\`\`\``;
}

function renderDiffSections(files: readonly ReviewDiffFile[]): string {
  return files.map(renderFileDiff).join("\n\n");
}

/**
 * Render an oversized diff: the complete diff is attached as a repository file and
 * files and omission notices are inlined while they fit the budget. The compact
 * notice always points to the complete attachment, including overflowing listings.
 */
function renderBudgetedDiff(
  diff: ReviewChangeDiff,
  budget: number,
  attachmentName: string,
  attachments: ReviewAttachment[],
): string {
  const attachmentPath = `${REVIEW_ATTACHMENT_DIR}/${attachmentName}`;
  const renderNote = (count: number): string =>
    `> ${count} of ${diff.files.length} files are inlined below. Read every omitted file in ` +
    `\`${attachmentPath}\` (review tooling, not part of the change).`;
  let remaining = budget - renderNote(diff.files.length).length;
  if (remaining < 0) {
    throw new RangeError("Inline diff budget is too small to reference the complete review diff");
  }
  attachments.push({ fileName: attachmentName, content: renderDiffSections(diff.files) + "\n" });
  let inlinedCount = 0;
  const sections: string[] = [];
  for (const file of diff.files) {
    const rendered = renderFileDiff(file);
    if (rendered.length + 2 <= remaining) {
      remaining -= rendered.length + 2;
      inlinedCount += 1;
      sections.push(rendered);
      continue;
    }
    const lineCount = file.patch.length === 0 ? 0 : file.patch.split("\n").length;
    const notice = `### ${file.path} (${file.status})\n(diff not inlined: ${lineCount} lines — read the \`### ${file.path}\` section of \`${attachmentPath}\`)`;
    if (notice.length + 2 <= remaining) {
      remaining -= notice.length + 2;
      sections.push(notice);
    }
  }
  return [renderNote(inlinedCount), ...sections].join("\n\n");
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
function renderSinceLastReview(deltaDiffText: string): string {
  return [
    "These are the changes between the patchset you last reviewed and the current",
    "one. Focus genuinely new findings on this delta. If the change was rebased,",
    "some hunks here may be upstream churn rather than author edits — judge",
    "accordingly. The full change is still provided below for context.",
    "",
    deltaDiffText,
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
