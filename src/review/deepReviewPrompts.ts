/**
 * Stage instructions of deep review.
 *
 * These texts were measured together; change them only as a new experiment.
 * They are code constants rather than prompt-store rows, so the built-in
 * prompt set stays unchanged.
 */
import type { InlineReviewComment } from "../interfaces.js";

const WORKING_RULES = `# Review Workflow

- Inspect enough surrounding code to verify each finding.
- Report only actionable issues introduced by the change; omit unsupported speculation.
- Anchor findings precisely, explain their impact, and suggest the smallest safe correction.
- Keep severity proportional to impact and the overall assessment concise.`;

const CONVENTIONS = `Learn how this repository does things before judging: read its contribution and style guidance when present (for example CONTRIBUTING, DEVELOPING, HACKING, AGENTS, style guides under docs/, and lint or format configuration), the code around each changed hunk, and at least one comparable existing implementation in the same directory or module. Ground each finding by citing the guidance or the existing code that sets the convention, and omit a preference you cannot ground this way. Give convention findings severity \`info\`, or \`nit\` when purely cosmetic.`;

function focused(title: string, scope: string): string {
  return `${WORKING_RULES}

## Scope of this pass: ${title}

${scope}

Other passes cover the rest of the review. Report only findings within this scope, and submit no comments when there are none.`;
}

/** Outside-in layers of the onion-peeling pathway, outermost first. */
export const ONION_LAYERS: ReadonlyArray<{ id: string; instructions: string }> = [
  {
    id: "intent",
    instructions: focused(
      "intent and scope",
      "Work out from the commit message and the diff what the change is meant to achieve. Report: a diff that does not do what the message says, or does more; statements in the commit message that the diff contradicts, and behavior changes it does not mention; unrelated changes that belong in a separate commit; an approach that cannot achieve the stated goal, or that this project would solve in another place (another layer, another repository, or upstream).",
    ),
  },
];

export type SpecialistId = "logic" | "state" | "contracts" | "maintainability";

/** Single-focus reviewers of the specialist-panel pathway. */
export const PANEL_SPECIALISTS: ReadonlyArray<{ id: SpecialistId; instructions: string }> = [
  {
    id: "logic",
    instructions: focused(
      "control flow and data",
      "Logic errors, wrong conditions, off-by-one and boundary values, unhandled error and early-return paths, missing or wrong checks of return values, and type, unit, or encoding mismatches. Follow each changed path to where its result is used.",
    ),
  },
  {
    id: "state",
    instructions: focused(
      "state, lifetime, and concurrency",
      "Ownership and lifetime of objects and registrations, resources that are not released, callbacks and asynchronous operations that outlive what they use, ordering and re-entrancy, blocking calls on event loops, races, and queues or state that can grow without bound.",
    ),
  },
  {
    id: "contracts",
    instructions: focused(
      "contracts and integration",
      "What the rest of the system expects from the changed code: callers and consumers of changed functions, interfaces, configuration keys, schemas, inter-process, network, and file formats, and build and packaging rules. Find where each changed name or key is consumed. Report mismatches with those consumers, with the definitions the change claims to implement, with supported dependency versions, and with existing deployments and upgrade paths; and report where the commit message and the diff disagree.",
    ),
  },
  {
    id: "maintainability",
    instructions: focused(
      "conventions, tests, and documentation",
      `Where the change departs from how this repository does things: an existing helper, type, or API that should have been used; duplicated logic; unnecessary or over-wide state, parameters, includes, or declarations; code in the wrong layer or file; misleading names. Also missing or ineffective tests for the new paths, and comments or documentation left inaccurate.\n\n${CONVENTIONS}`,
    ),
  },
];

/** Render findings as a numbered list for a later stage to read. */
export function renderFindings(comments: readonly InlineReviewComment[], maxMessageChars = 700): string {
  if (comments.length === 0) return "(none)";
  return comments
    .map((comment, index) => {
      const flat = comment.message.replace(/\s+/g, " ").trim();
      const message = flat.length <= maxMessageChars ? flat : `${flat.slice(0, maxMessageChars - 1)}…`;
      return `[${index + 1}] ${comment.file}:${comment.line} (${comment.severity}) ${message}`;
    })
    .join("\n");
}

/** Instructions of an inner onion layer, which is told what the outer layers raised. */
export function withOuterNotes(instructions: string, outer: readonly InlineReviewComment[]): string {
  if (outer.length === 0) return instructions;
  return `${instructions}

## Notes from the outer layers

Reviewers of the outer layers already raised the notes below. Do not repeat them. Where a note asks for code to be redesigned, moved, or removed, do not review the details of that code.

${renderFindings(outer)}`;
}

/** Instructions of the stage that merges and orders the findings of several passes without dropping any. */
export function rankerInstructions(candidates: readonly InlineReviewComment[]): string {
  return `# Consolidation Workflow

Several reviewers, each covering one aspect of this change, proposed the candidate findings below. Turn them into the one review that is posted.

- Merge candidates that describe the same problem into a single finding, keeping the clearest wording and the most precise file and line. Do not merge findings that are merely near each other.
- Keep every distinct finding. Drop a candidate only when it duplicates another, or when you open the cited code and it plainly shows the candidate is wrong.
- Order the findings by how much the author needs to act on them before the change is merged: first defects that break behavior, builds, or existing users; then departures from how this repository does things; then missing tests, documentation, and cosmetic points.
- Set severity in proportion to impact, keeping \`info\` or \`nit\` for convention, test, and documentation findings.
- Do not add findings of your own.

Submit the consolidated findings as the review comments, in that order, each written so it stands on its own.

## Candidate findings

${renderFindings(candidates, 1200)}`;
}
