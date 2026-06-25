/**
 * Webhook handler registry.
 *
 * Maps each provider to its event handlers and the list of event names it
 * handles. A single provider (e.g. GitLab) may expose multiple handlers — one
 * per capability (issue tracking vs. merge requests) — dispatched by event name.
 * Queried by the webhook server to route incoming payloads.
 */
import type { ProviderId } from "../../interfaces.js";
import type { WebhookHandler } from "../webhookServer.js";
import { redmineWebhookHandler, SUPPORTED_REDMINE_EVENTS } from "./redmine.js";
import { gitlabIssueWebhookHandler, SUPPORTED_GITLAB_ISSUE_EVENTS } from "./gitlab-issue.js";
import { gitlabMergeRequestWebhookHandler, SUPPORTED_GITLAB_MR_EVENTS } from "./gitlab-merge-request.js";
import { githubPullRequestWebhookHandler, SUPPORTED_GITHUB_PR_EVENTS } from "./github-pull-request.js";

interface ProviderHandlerEntry {
  handler: WebhookHandler;
  events: readonly string[];
}

const PROVIDER_HANDLERS: Partial<Record<ProviderId, ProviderHandlerEntry[]>> = {
  redmine: [{ handler: redmineWebhookHandler, events: SUPPORTED_REDMINE_EVENTS }],
  gitlab: [
    { handler: gitlabIssueWebhookHandler, events: SUPPORTED_GITLAB_ISSUE_EVENTS },
    { handler: gitlabMergeRequestWebhookHandler, events: SUPPORTED_GITLAB_MR_EVENTS },
  ],
  github: [{ handler: githubPullRequestWebhookHandler, events: SUPPORTED_GITHUB_PR_EVENTS }],
};

/** Return true when the provider has at least one registered webhook handler. */
export function providerHasWebhookHandler(provider: string): boolean {
  return (PROVIDER_HANDLERS[provider as ProviderId]?.length ?? 0) > 0;
}

/**
 * Return the webhook handler for the given provider and event. When the event
 * is unknown, falls back to the provider's first handler so callers can still
 * route generic pings. Returns `undefined` if the provider is unsupported.
 */
export function getHandlerForProviderEvent(provider: string, event?: string): WebhookHandler | undefined {
  const entries = PROVIDER_HANDLERS[provider as ProviderId];
  if (!entries || entries.length === 0) return undefined;
  if (event) {
    const matched = entries.find((entry) => entry.events.includes(event));
    if (matched) return matched.handler;
  }
  return entries[0]?.handler;
}

/** Return all event names handled by the given provider (empty array if unknown). */
export function getSupportedEventsForProvider(provider: string): readonly string[] {
  const entries = PROVIDER_HANDLERS[provider as ProviderId];
  if (!entries) return [];
  return entries.flatMap((entry) => entry.events);
}
