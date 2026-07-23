import { z } from "zod";
import type {
  InlineReviewComment,
  ReviewAgentResult,
  ReviewSeverity,
  ThreadReply,
} from "../interfaces.js";

export const REVIEW_RESULT_START_MARKER = "REVIEW_RESULT_START";
export const REVIEW_RESULT_END_MARKER = "REVIEW_RESULT_END";

export type ReviewOutputContractKind = "gerrit" | "github" | "gitlab";

const SeveritySchema: z.ZodType<ReviewSeverity> = z.string().min(1);

const InlineCommentSchema: z.ZodType<InlineReviewComment> = z.object({
  file: z.string().min(1),
  line: z.number().int().nonnegative(),
  message: z.string().min(1),
  severity: SeveritySchema,
});

const ReplySchema: z.ZodType<ThreadReply> = z.object({
  threadId: z.string().min(1),
  message: z.string().min(1),
});

const SharedPayloadShape = {
  comments: z.array(InlineCommentSchema).default([]),
  summary: z.string().default(""),
  replies: z.array(ReplySchema).default([]),
};

const DecisionSchema = z.union([z.literal(-1), z.literal(0), z.literal(1)]);

const GerritPayloadSchema = z.object({
  ...SharedPayloadShape,
  vote: DecisionSchema,
}).strict();

const GitHubPayloadSchema = z.object({
  ...SharedPayloadShape,
  reviewAction: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
}).strict();

const GitLabPayloadSchema = z.object({
  ...SharedPayloadShape,
  approvalAction: z.enum(["APPROVE", "UNAPPROVE", "COMMENT"]),
}).strict();

export const LegacyReviewPayloadSchema = z.object({
  ...SharedPayloadShape,
  score: DecisionSchema.default(0),
});

const SHARED_FORMAT = `The JSON object must also contain:
- "comments": an array of { "file", "line", "message", "severity" } objects.
- "summary": a concise overall assessment.
- "replies": an array of { "threadId", "message" } objects. Use only thread IDs supplied in the task.

Use 1-based new-side diff line numbers. Use line 0 only for a file-level finding.
Use severity "error" or "warning" for actionable concerns, and "info" or "nit" for optional notes.`;

const CONTRACTS: Record<ReviewOutputContractKind, string> = {
  gerrit: `Return exactly one structured result block and no text outside it.

${REVIEW_RESULT_START_MARKER}
{
  "comments": [],
  "summary": "Overall assessment.",
  "vote": -1,
  "replies": []
}
${REVIEW_RESULT_END_MARKER}

"vote" is the Gerrit Code-Review label value: -1 requests changes, 0 is neutral, and 1 approves.
Gerrit supports file-level comments with line 0.

${SHARED_FORMAT}`,
  github: `Return exactly one structured result block and no text outside it.

${REVIEW_RESULT_START_MARKER}
{
  "comments": [],
  "summary": "Overall assessment.",
  "reviewAction": "COMMENT",
  "replies": []
}
${REVIEW_RESULT_END_MARKER}

"reviewAction" is a GitHub review event: "REQUEST_CHANGES", "COMMENT", or "APPROVE".
GitHub cannot anchor file-level comments; findings with line 0 are folded into the review summary.

${SHARED_FORMAT}`,
  gitlab: `Return exactly one structured result block and no text outside it.

${REVIEW_RESULT_START_MARKER}
{
  "comments": [],
  "summary": "Overall assessment.",
  "approvalAction": "COMMENT",
  "replies": []
}
${REVIEW_RESULT_END_MARKER}

"approvalAction" is a GitLab approval action: "UNAPPROVE", "COMMENT", or "APPROVE".
GitLab cannot position file-level comments; findings with line 0 are folded into the review summary.

${SHARED_FORMAT}`,
};

export function isReviewOutputContractKind(kind: string): kind is ReviewOutputContractKind {
  return kind === "gerrit" || kind === "github" || kind === "gitlab";
}

export function getReviewOutputContract(kind: string): string {
  if (!isReviewOutputContractKind(kind)) {
    throw new Error(`Unsupported review output contract: ${kind}`);
  }
  return CONTRACTS[kind];
}

export function appendReviewOutputContract(systemPrompt: string, kind: string): string {
  return `${systemPrompt.trim()}\n\n## Required output contract\n\n${getReviewOutputContract(kind)}`;
}

export function parseReviewPayload(kind: string, value: unknown): ReviewAgentResult | null {
  if (!isReviewOutputContractKind(kind)) {
    throw new Error(`Unsupported review output contract: ${kind}`);
  }

  if (kind === "gerrit") {
    const parsed = GerritPayloadSchema.safeParse(value);
    if (parsed.success) {
      const { vote, ...shared } = parsed.data;
      return { ...shared, score: vote };
    }
  } else if (kind === "github") {
    const parsed = GitHubPayloadSchema.safeParse(value);
    if (parsed.success) {
      const { reviewAction, ...shared } = parsed.data;
      const score = reviewAction === "APPROVE" ? 1 : reviewAction === "REQUEST_CHANGES" ? -1 : 0;
      return { ...shared, score };
    }
  } else {
    const parsed = GitLabPayloadSchema.safeParse(value);
    if (parsed.success) {
      const { approvalAction, ...shared } = parsed.data;
      const score = approvalAction === "APPROVE" ? 1 : approvalAction === "UNAPPROVE" ? -1 : 0;
      return { ...shared, score };
    }
  }

  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (
      Object.hasOwn(record, "vote") ||
      Object.hasOwn(record, "reviewAction") ||
      Object.hasOwn(record, "approvalAction")
    ) {
      return null;
    }
  }

  const legacy = LegacyReviewPayloadSchema.safeParse(value);
  return legacy.success ? legacy.data : null;
}