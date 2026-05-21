import type { WebhookHandler } from "../webhookServer.js";

/**
 * Phase 5 — GitLab Merge Request Hook + Note Hook handler.
 *
 * Supported events (path component):
 *  - merge_request                 — Merge Request Hook
 *  - merge_request.update          — explicit alias
 *  - merge_request.approved
 *  - merge_request.merged
 *  - merge_request.closed
 *  - note                          — Note Hook on an MR
 *
 * Routing key: payload.object_attributes.iid (the MR IID is the changeId in
 * `change_per_repository`). The handler dispatches to the orchestrator's
 * webhook entry points; it does NOT itself read `change_per_repository`.
 */

export const SUPPORTED_GITLAB_MR_EVENTS = [
  "merge_request",
  "merge_request.update",
  "merge_request.approved",
  "merge_request.merged",
  "merge_request.closed",
  "note",
] as const;

/** Handle GitLab Merge Request Hook and Note Hook events, routing to the appropriate orchestrator action. */
export const gitlabMergeRequestWebhookHandler: WebhookHandler = async (ctx) => {
  if (ctx.event === "note") {
    return handleNote(ctx);
  }
  if (ctx.event !== "merge_request" && !ctx.event.startsWith("merge_request.")) {
    return { status: 202, body: { ignored: true, reason: `Unhandled event '${ctx.event}'` } };
  }

  const mr = extractMr(ctx.payload);
  if (!mr) {
    return { status: 400, body: { error: "Payload missing 'object_attributes' for merge request" } };
  }

  const action = mr.action ?? eventToAction(ctx.event);
  const changeId = String(mr.iid);

  if (action === "merge" || action === "merged") {
    await ctx.orchestrator.markChangeMerged(ctx.integrationId, changeId);
    return { status: 202, body: { queued: true, action: "merged", changeId } };
  }

  if (action === "close" || action === "closed") {
    await ctx.orchestrator.markChangeAbandoned(ctx.integrationId, changeId);
    return { status: 202, body: { queued: true, action: "abandoned", changeId } };
  }

  // open / update / approved → re-poll feedback
  await ctx.orchestrator.triggerFeedbackForChange(ctx.integrationId, changeId);
  return { status: 202, body: { queued: true, action: action ?? "feedback", changeId } };
};

const handleNote: WebhookHandler = async (ctx) => {
  if (typeof ctx.payload !== "object" || ctx.payload === null) {
    return { status: 400, body: { error: "Invalid note payload" } };
  }
  const root = ctx.payload as Record<string, unknown>;
  const mrField = root["merge_request"];
  if (typeof mrField !== "object" || mrField === null) {
    return { status: 202, body: { ignored: true, reason: "Note is not on a merge request" } };
  }
  const mr = mrField as Record<string, unknown>;
  const iid = mr["iid"] ?? mr["id"];
  if (typeof iid !== "number" && typeof iid !== "string") {
    return { status: 400, body: { error: "Note payload missing merge_request.iid" } };
  }
  await ctx.orchestrator.triggerFeedbackForChange(ctx.integrationId, String(iid));
  return { status: 202, body: { queued: true, action: "feedback", changeId: String(iid) } };
};

interface GitlabMrPayload {
  iid: number | string;
  action?: string;
}

/** Extract the MR IID and action from a raw GitLab MR Hook payload's `object_attributes`. */
function extractMr(payload: unknown): GitlabMrPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const root = payload as Record<string, unknown>;
  const attrs = root["object_attributes"];
  if (typeof attrs !== "object" || attrs === null) return null;
  const a = attrs as Record<string, unknown>;
  const iid = a["iid"] ?? a["id"];
  if (typeof iid !== "number" && typeof iid !== "string") return null;
  const action = typeof a["action"] === "string" ? (a["action"] as string) : undefined;
  return action !== undefined ? { iid, action } : { iid };
}

/** Map a dotted event path (e.g. `merge_request.approved`) to its action suffix. */
function eventToAction(event: string): string | undefined {
  const suffix = event.split(".")[1];
  return suffix;
}
