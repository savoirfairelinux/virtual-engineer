import type { WebhookHandler, WebhookContext } from "../webhookServer.js";
import { buildTicketSourceLabel } from "../../utils/ticketSourceLabel.js";

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
 *  - issues                        (opened, reopened, edited, assigned, labeled)
 *                                  — enqueues a coding task for the matching VE
 *                                    project (issue_tracking intake)
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
    case "issues":
      return handleIssues(ctx);
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
  const repo = extractFullName(payload);
  if (!repo) return { status: 400, body: { error: "Payload missing 'repository.full_name'" } };
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
  const repo = extractFullName(payload);
  if (!repo) return { status: 400, body: { error: "Payload missing 'repository.full_name'" } };
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
  const repo = extractFullName(payload);
  if (!repo) return { status: 400, body: { error: "Payload missing 'repository.full_name'" } };
  const changeId = `${repo}#${number}`;
  const action = typeof payload["action"] === "string" ? payload["action"] : undefined;
  ctx.log.info({ changeId, action }, "GitHub PR issue_comment: triggering feedback check");
  await ctx.orchestrator.triggerFeedbackForChange(ctx.integrationId, changeId);
  return { status: 202, body: { queued: true, action: "feedback", changeId } };
};

/** Issue actions that should enqueue (or refresh) a coding task. */
const INGEST_ISSUE_ACTIONS = new Set(["opened", "reopened", "edited", "assigned", "labeled"]);

/**
 * Ingest a GitHub issue as a coding task for the VE project bound to the
 * issue's repository (issue_tracking ticketProjectKey = `owner/repo`).
 * startTaskForProject dedups against in-progress tasks, so repeated events are
 * safe.
 */
const handleIssues: WebhookHandler = async (ctx) => {
  const payload = asObject(ctx.payload);
  if (!payload) return { status: 400, body: { error: "Invalid payload" } };

  const action = typeof payload["action"] === "string" ? payload["action"] : undefined;
  if (action === undefined || !INGEST_ISSUE_ACTIONS.has(action)) {
    return { status: 202, body: { ignored: true, reason: `Unhandled issues action '${action ?? "unknown"}'` } };
  }

  const issue = asObject(payload["issue"]);
  if (!issue) return { status: 400, body: { error: "Payload missing 'issue'" } };

  // Defensive: GitHub fires `pull_request` events for PRs, but never enqueue a
  // PR through the issue intake path even if a pull_request ref leaks through.
  if (asObject(issue["pull_request"])) {
    return { status: 202, body: { ignored: true, reason: "Payload references a pull request, not an issue" } };
  }

  const number = issue["number"];
  if (typeof number !== "number" && typeof number !== "string") {
    return { status: 400, body: { error: "Issue payload missing 'number'" } };
  }
  const repo = extractFullName(payload);
  if (!repo) return { status: 400, body: { error: "Payload missing 'repository.full_name'" } };

  const project = await ctx.projectStore.findProjectByTicketSource(ctx.integrationId, repo);
  if (!project) {
    return {
      status: 202,
      body: { ignored: true, reason: `No coding project for ticket source ${ctx.integrationId}/${repo}` },
    };
  }

  const title = typeof issue["title"] === "string" ? issue["title"] : undefined;
  const body = typeof issue["body"] === "string" ? issue["body"] : undefined;
  const htmlUrl = typeof issue["html_url"] === "string" ? issue["html_url"] : undefined;

  await ctx.orchestrator.startTaskForProject(
    {
      id: String(number),
      ...(title !== undefined ? { subject: title } : {}),
      ...(body !== undefined ? { description: body } : {}),
      ...(htmlUrl !== undefined ? { webUrl: htmlUrl } : {}),
    },
    project,
    buildTicketSourceLabel(ctx.integration.provider, ctx.integrationId)
  );

  ctx.log.info({ issueNumber: String(number), projectId: project.id, action }, "GitHub issue ingested as coding task");
  return { status: 202, body: { queued: true, taskTicketId: String(number), projectId: project.id } };
};

function extractFullName(payload: Record<string, unknown>): string | undefined {
  const repository = asObject(payload["repository"]);
  if (!repository) return undefined;
  const full = repository["full_name"];
  return typeof full === "string" && full.includes("/") ? full : undefined;
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
