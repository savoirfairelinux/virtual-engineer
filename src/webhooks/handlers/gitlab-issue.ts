import type { WebhookHandler } from "../webhookServer.js";
import { buildTicketSourceLabel } from "../../utils/ticketSourceLabel.js";

/**
 * Phase 5 — GitLab Issue Hook handler.
 *
 * GitLab sends "Issue Hook" events with payload:
 *   {
 *     "object_kind": "issue",
 *     "project": { "path_with_namespace": "group/proj", "id": 42 },
 *     "object_attributes": { "iid": 7, "title": "...", "description": "...",
 *                            "url": "...", "action": "open" }
 *   }
 *
 * Supported events (path component):
 *  - issue        (matches GitLab's `Issue Hook`)
 *  - issue.open
 *  - issue.update
 *  - issue.reopen
 *
 * Routing key: payload.project.path_with_namespace
 */

export const SUPPORTED_GITLAB_ISSUE_EVENTS = [
  "issue",
  "issue.open",
  "issue.update",
  "issue.reopen",
] as const;

/** Handle GitLab Issue Hook events and enqueue a coding task for the matching VE project. */
export const gitlabIssueWebhookHandler: WebhookHandler = async (ctx) => {
  if (ctx.event !== "issue" && !ctx.event.startsWith("issue.")) {
    return { status: 202, body: { ignored: true, reason: `Unhandled event '${ctx.event}'` } };
  }

  const issue = extractGitlabIssue(ctx.payload);
  if (!issue) {
    return { status: 400, body: { error: "Payload missing 'object_attributes' or 'project'" } };
  }
  if (!issue.projectKey) {
    return { status: 400, body: { error: "Payload missing 'project.path_with_namespace'" } };
  }

  const project = await ctx.projectStore.findProjectByTicketSource(ctx.integrationId, issue.projectKey);
  if (!project) {
    return {
      status: 202,
      body: { ignored: true, reason: `No coding project for ticket source ${ctx.integrationId}/${issue.projectKey}` },
    };
  }

  await ctx.orchestrator.startTaskForProject(
    {
      id: String(issue.iid),
      ...(issue.title !== undefined ? { subject: issue.title } : {}),
      ...(issue.description !== undefined ? { description: issue.description } : {}),
      ...(issue.url !== undefined ? { webUrl: issue.url } : {}),
    },
    project,
    buildTicketSourceLabel(ctx.integration.provider, ctx.integrationId)
  );

  return { status: 202, body: { queued: true, taskTicketId: String(issue.iid), projectId: project.id } };
};

interface GitlabIssuePayload {
  iid: number | string;
  title?: string | undefined;
  description?: string | undefined;
  url?: string | undefined;
  projectKey?: string | undefined;
}

/** Extract the issue fields and project key from a raw GitLab Issue Hook payload. */
function extractGitlabIssue(payload: unknown): GitlabIssuePayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const root = payload as Record<string, unknown>;
  const attrs = root["object_attributes"];
  if (typeof attrs !== "object" || attrs === null) return null;
  const a = attrs as Record<string, unknown>;
  const iid = a["iid"] ?? a["id"];
  if (typeof iid !== "number" && typeof iid !== "string") return null;
  const project = root["project"];
  const projectKey = typeof project === "object" && project !== null
    ? (project as Record<string, unknown>)["path_with_namespace"]
    : undefined;
  return {
    iid,
    title: typeof a["title"] === "string" ? (a["title"] as string) : undefined,
    description: typeof a["description"] === "string" ? (a["description"] as string) : undefined,
    url: typeof a["url"] === "string" ? (a["url"] as string) : undefined,
    projectKey: typeof projectKey === "string" ? projectKey : undefined,
  };
}
