/**
 * Review prompt builder.
 *
 * Assembles the full prompt string passed to the review agent by combining
 * change metadata, the diff, and per-reviewer instructions.
 */
import type { ReviewChangeDetails, ReviewChangeDiff } from "../interfaces.js";

/** Default upper bound on diff size injected into the prompt to avoid token blow-ups. */
const DEFAULT_MAX_DIFF_CHARS = 60_000;
const TRUNCATION_NOTE =
  "\n\n[... diff truncated to fit in the model context — review the rest from the repository if needed ...]";

export interface ReviewPromptInput {
  details: ReviewChangeDetails;
  diff: ReviewChangeDiff;
  /** User instructions/checklist for the review task. Required. */
  userPrompt: string;
  /** Optional override for the max diff size in characters. Defaults to 60 000. */
  maxDiffChars?: number | undefined;
}

/** Build the full prompt sent to the review agent for a single change. */
export function buildReviewPrompt(input: ReviewPromptInput): string {
  const { details, diff, userPrompt, maxDiffChars } = input;

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

  const diffSections = renderDiffSections(diff, maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS);

  return [
    header,
    ``,
    `## User Instructions`,
    userPrompt,
    ``,
    `## Files in this patchset`,
    fileListing || "(no files reported)",
    ``,
    `## Unified diffs`,
    diffSections,
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
