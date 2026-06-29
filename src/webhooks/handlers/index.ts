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
 * Return the webhook handler for the given provider and event. The `event` is
 * the URL path segment (`/webhooks/:integrationId/:event`) and must match one of
 * the provider's supported event names — GitHub uses the literal `github`,
 * GitLab uses `object_kind` values, and Redmine uses `issue.*`. Returns
 * `undefined` when the provider is unsupported, the event is missing, or the
 * event matches no handler; the caller then treats the request as ignored
 * rather than mis-routing an unsupported event to an arbitrary handler.
 */
export function getHandlerForProviderEvent(provider: string, event?: string): WebhookHandler | undefined {
  const entries = PROVIDER_HANDLERS[provider as ProviderId];
  if (!entries || entries.length === 0) return undefined;
  if (!event) return undefined;
  return entries.find((entry) => entry.events.includes(event))?.handler;
}

/** Return all event names handled by the given provider (empty array if unknown). */
export function getSupportedEventsForProvider(provider: string): readonly string[] {
  const entries = PROVIDER_HANDLERS[provider as ProviderId];
  if (!entries) return [];
  return entries.flatMap((entry) => entry.events);
}
