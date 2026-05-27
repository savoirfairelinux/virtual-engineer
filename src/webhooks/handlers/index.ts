/**
 * Webhook handler registry.
 *
 * Maps each integration type to its event handler and the list of event names
 * it handles. Queried by the webhook server to route incoming payloads.
 */
import type { WebhookHandler } from "../webhookServer.js";
import { redmineWebhookHandler, SUPPORTED_REDMINE_EVENTS } from "./redmine.js";
import { gitlabIssueWebhookHandler, SUPPORTED_GITLAB_ISSUE_EVENTS } from "./gitlab-issue.js";
import { gitlabMergeRequestWebhookHandler, SUPPORTED_GITLAB_MR_EVENTS } from "./gitlab-merge-request.js";
import { githubPullRequestWebhookHandler, SUPPORTED_GITHUB_PR_EVENTS } from "./github-pull-request.js";

const HANDLERS: Record<string, WebhookHandler> = {
  "redmine": redmineWebhookHandler,
  "gitlab-issue": gitlabIssueWebhookHandler,
  "gitlab-merge-request": gitlabMergeRequestWebhookHandler,
  "github-pull-request": githubPullRequestWebhookHandler,
};

const SUPPORTED_EVENTS: Record<string, readonly string[]> = {
  "redmine": SUPPORTED_REDMINE_EVENTS,
  "gitlab-issue": SUPPORTED_GITLAB_ISSUE_EVENTS,
  "gitlab-merge-request": SUPPORTED_GITLAB_MR_EVENTS,
  "github-pull-request": SUPPORTED_GITHUB_PR_EVENTS,
};

/** Return the handler for the given integration type, or `undefined` if unsupported. */
export function getHandlerForIntegrationType(type: string): WebhookHandler | undefined {
  return HANDLERS[type];
}

/** Return the event names handled by the given integration type (empty array if unknown). */
export function getSupportedEventsForIntegrationType(type: string): readonly string[] {
  return SUPPORTED_EVENTS[type] ?? [];
}
