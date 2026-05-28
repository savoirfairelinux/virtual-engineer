import type { WebhookHandler, WebhookContext } from "../webhookServer.js";

/**
 * GitHub Pull Request webhook handler.
 *
 * GitHub sends the event name in the `X-GitHub-Event` HTTP header, not in the
 * URL path. Admins configure a single webhook URL of the form
 * `/webhooks/{integrationId}/github`, and this handler dispatches based on the
 * header.
 *
 * Supported events:
 *  - pull_request                  (opened, reopened, closed, synchronize, ...)
 *  - pull_request_review           (submitted, edited, dismissed)
 *  - pull_request_review_comment   (created, edited, deleted)
 *  - issue_comment                 (created, edited, deleted) — only when on a PR
 *
 * The path segment after the integration id MUST be `github` for this handler
 * to be invoked, but the actual dispatch key is the header.
 */

export const SUPPORTED_GITHUB_PR_EVENTS = ["github"] as const;

export const githubPullRequestWebhookHandler: WebhookHandler = async (ctx) => {
  const githubEvent = pickHeader(ctx.headers, "x-github-event");
  ctx.log.info(
    { integrationId: ctx.integrationId, githubEvent, deliveryId: pickHeader(ctx.headers, "x-github-delivery") },
    "GitHub webhook received"
  );
  if (!githubEvent) {
    return { status: 400, body: { error: "Missing X-GitHub-Event header" } };
  }

  switch (githubEvent) {
    case "pull_request":
      return handlePullRequest(ctx);
    case "pull_request_review":
    case "pull_request_review_comment":
      return handleReviewActivity(ctx);
    case "issue_comment":
      return handleIssueComment(ctx);
    case "ping":
      return { status: 200, body: { pong: true } };
    default:
      ctx.log.info({ githubEvent }, "GitHub webhook: event not handled");
      return { status: 202, body: { ignored: true, reason: `Unhandled GitHub event '${githubEvent}'` } };
  }
};

const handlePullRequest: WebhookHandler = async (ctx) => {
  const payload = asObject(ctx.payload);
  if (!payload) return { status: 400, body: { error: "Invalid payload" } };

  const action = typeof payload["action"] === "string" ? payload["action"] : undefined;
  const pr = asObject(payload["pull_request"]);
  if (!pr) return { status: 400, body: { error: "Payload missing 'pull_request'" } };
  const number = pr["number"];
  if (typeof number !== "number" && typeof number !== "string") {
    return { status: 400, body: { error: "Pull request payload missing 'number'" } };
  }
  const repo = extractRepoName(payload);
  if (!repo) return { status: 400, body: { error: "Payload missing 'repository.name'" } };
  const changeId = `${repo}#${number}`;

  if (action === "closed") {
    const merged = pr["merged"] === true;
    if (merged) {
      await ctx.orchestrator.markChangeMerged(ctx.integrationId, changeId);
      return { status: 202, body: { queued: true, action: "merged", changeId } };
    }
    await ctx.orchestrator.markChangeAbandoned(ctx.integrationId, changeId);
    return { status: 202, body: { queued: true, action: "abandoned", changeId } };
  }

  const reviewTriggerActions = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);
  if (action !== undefined && reviewTriggerActions.has(action) && ctx.orchestrator.triggerReviewForChange) {
    try {
      await ctx.orchestrator.triggerReviewForChange(ctx.integrationId, changeId);
    } catch (err) {
      ctx.log.warn({ err, changeId, action }, "review trigger failed; continuing with feedback check");
    }
  }

  await ctx.orchestrator.triggerFeedbackForChange(ctx.integrationId, changeId);
  return { status: 202, body: { queued: true, action: action ?? "feedback", changeId } };
};

const handleReviewActivity: WebhookHandler = async (ctx) => {
  const payload = asObject(ctx.payload);
  if (!payload) return { status: 400, body: { error: "Invalid payload" } };

  const pr = asObject(payload["pull_request"]);
  if (!pr) return { status: 400, body: { error: "Payload missing 'pull_request'" } };
  const number = pr["number"];
  if (typeof number !== "number" && typeof number !== "string") {
    return { status: 400, body: { error: "Pull request payload missing 'number'" } };
  }
  const repo = extractRepoName(payload);
  if (!repo) return { status: 400, body: { error: "Payload missing 'repository.name'" } };
  const changeId = `${repo}#${number}`;
  const action = typeof payload["action"] === "string" ? payload["action"] : undefined;
  ctx.log.info({ changeId, action }, "GitHub PR review activity: triggering feedback check");
  await ctx.orchestrator.triggerFeedbackForChange(ctx.integrationId, changeId);
  return { status: 202, body: { queued: true, action: "feedback", changeId } };
};

const handleIssueComment: WebhookHandler = async (ctx) => {
  const payload = asObject(ctx.payload);
  if (!payload) return { status: 400, body: { error: "Invalid payload" } };

  const issue = asObject(payload["issue"]);
  if (!issue) return { status: 400, body: { error: "Payload missing 'issue'" } };

  if (!asObject(issue["pull_request"])) {
    ctx.log.info({ issueNumber: issue["number"] }, "GitHub issue_comment: skipped (not on a PR)");
    return { status: 202, body: { ignored: true, reason: "Comment is on an issue, not a pull request" } };
  }

  const number = issue["number"];
  if (typeof number !== "number" && typeof number !== "string") {
    return { status: 400, body: { error: "Issue payload missing 'number'" } };
  }
  const repo = extractRepoName(payload);
  if (!repo) return { status: 400, body: { error: "Payload missing 'repository.name'" } };
  const changeId = `${repo}#${number}`;
  const action = typeof payload["action"] === "string" ? payload["action"] : undefined;
  ctx.log.info({ changeId, action }, "GitHub PR issue_comment: triggering feedback check");
  await ctx.orchestrator.triggerFeedbackForChange(ctx.integrationId, changeId);
  return { status: 202, body: { queued: true, action: "feedback", changeId } };
};

function extractRepoName(payload: Record<string, unknown>): string | undefined {
  const repository = asObject(payload["repository"]);
  if (!repository) return undefined;
  const name = repository["name"];
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function pickHeader(headers: WebhookContext["headers"], name: string): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}
