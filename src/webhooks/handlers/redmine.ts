import type { WebhookHandler } from "../webhookServer.js";
import { buildTicketSourceLabel } from "../../utils/ticketSourceLabel.js";

/**
 * Phase 5 — Redmine webhook handler.
 *
 * Redmine doesn't ship a first-party webhook plugin, but several third-party
 * plugins (e.g. webhook, redmine_webhook) post JSON envelopes that look like:
 *   {
 *     "issue": { "id": 42, "subject": "...", "description": "...",
 *                "project": { "identifier": "my-project" },
 *                "assigned_to": { "id": 7 } },
 *     "url": "https://redmine.example.com/issues/42"
 *   }
 *
 * Supported events (path component after the integrationId):
 *  - issue.created
 *  - issue.updated
 *
 * Routing: payload.issue.project.identifier → ProjectRecord via
 * findProjectByTicketSource(integrationId, projectKey). If no matching coding
 * project is configured, the handler returns 202 ignored.
 */

export const SUPPORTED_REDMINE_EVENTS = ["issue.created", "issue.updated"] as const;

/** Handle Redmine issue webhook events and enqueue a coding task for the matching VE project. */
export const redmineWebhookHandler: WebhookHandler = async (ctx) => {
  if (!ctx.event.startsWith("issue.")) {
    return { status: 202, body: { ignored: true, reason: `Unhandled event '${ctx.event}'` } };
  }

  const issue = extractIssue(ctx.payload);
  if (!issue) {
    return { status: 400, body: { error: "Payload missing 'issue' object" } };
  }
  const projectKey = issue.projectIdentifier;
  if (!projectKey) {
    return { status: 400, body: { error: "Payload missing 'issue.project.identifier'" } };
  }

  const project = await ctx.projectStore.findProjectByTicketSource(ctx.integrationId, projectKey);
  if (!project) {
    return {
      status: 202,
      body: { ignored: true, reason: `No coding project for ticket source ${ctx.integrationId}/${projectKey}` },
    };
  }

  await ctx.orchestrator.startTaskForProject(
    {
      id: String(issue.id),
      ...(issue.subject !== undefined ? { subject: issue.subject } : {}),
      ...(issue.description !== undefined ? { description: issue.description } : {}),
      ...(issue.webUrl !== undefined ? { webUrl: issue.webUrl } : {}),
    },
    project,
    buildTicketSourceLabel(ctx.integration.provider, ctx.integrationId)
  );

  return { status: 202, body: { queued: true, taskTicketId: String(issue.id), projectId: project.id } };
};

interface RedmineIssuePayload {
  id: number | string;
  subject?: string | undefined;
  description?: string | undefined;
  projectIdentifier?: string | undefined;
  webUrl?: string | undefined;
}

/** Extract the issue fields and project identifier from a raw Redmine webhook payload. */
function extractIssue(payload: unknown): RedmineIssuePayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const root = payload as Record<string, unknown>;
  const issueRaw = root["issue"] ?? root["payload"];
  if (typeof issueRaw !== "object" || issueRaw === null) return null;
  const issue = issueRaw as Record<string, unknown>;
  const id = issue["id"];
  if (typeof id !== "number" && typeof id !== "string") return null;

  const project = isRecord(issue["project"]) ? issue["project"] : null;
  const projectIdentifier =
    typeof project?.["identifier"] === "string"
      ? (project["identifier"] as string)
      : typeof project?.["name"] === "string"
        ? (project["name"] as string)
        : undefined;

  return {
    id,
    subject: typeof issue["subject"] === "string" ? (issue["subject"] as string) : undefined,
    description: typeof issue["description"] === "string" ? (issue["description"] as string) : undefined,
    projectIdentifier,
    webUrl: typeof root["url"] === "string" ? (root["url"] as string) : undefined,
  };
}

/** Type guard: return true when `value` is a non-null plain object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
