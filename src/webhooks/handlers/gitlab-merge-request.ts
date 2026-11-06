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
 * `change_per_repository`), qualified by the project's `path_with_namespace`.
 * Lifecycle and feedback events are also routed under the payload's numeric
 * `project.id`, since bindings may record a repository by either identity. The
 * handler dispatches to the orchestrator's webhook entry points; it does NOT
 * itself read `change_per_repository`.
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
  const reviewChangeId = qualifyReviewChangeId(ctx.payload, changeId);
  const lifecycleChangeIds = qualifyLifecycleChangeIds(ctx.payload, changeId, reviewChangeId);
  const reviewerChanged = hasReviewerChange(ctx.payload);

  if (action === "merge" || action === "merged") {
    await routeEachIdentity(lifecycleChangeIds, (id) => ctx.orchestrator.markChangeMerged(ctx.integrationId, id));
    return { status: 202, body: { queued: true, action: "merged", changeId } };
  }

  if (action === "close" || action === "closed") {
    await routeEachIdentity(lifecycleChangeIds, (id) => ctx.orchestrator.markChangeAbandoned(ctx.integrationId, id));
    return { status: 202, body: { queued: true, action: "abandoned", changeId } };
  }

  // open / reopen / update → trigger a fresh review pass (when a reviewer is wired).
  const revisionTrigger = action === "open" || action === "opened" || action === "reopen" || action === "reopened"
    || ((action === "update" || action === "updated") && mr.oldrev !== undefined);
  if ((revisionTrigger || reviewerChanged) && ctx.orchestrator.triggerReviewForChange) {
    try {
      if (reviewerChanged) {
        await ctx.orchestrator.triggerReviewForChange(ctx.integrationId, reviewChangeId, {
          triggerCause: "reviewer-change",
        });
      } else {
        await ctx.orchestrator.triggerReviewForChange(ctx.integrationId, reviewChangeId);
      }
    } catch (err) {
      ctx.log.warn({ err, changeId, action }, "review trigger failed; continuing with feedback check");
    }
  }

  // open / update / approved → re-poll feedback
  await routeEachIdentity(lifecycleChangeIds, (id) => ctx.orchestrator.triggerFeedbackForChange(ctx.integrationId, id));
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
  const reviewChangeId = qualifyReviewChangeId(ctx.payload, String(iid));
  const lifecycleChangeIds = qualifyLifecycleChangeIds(ctx.payload, String(iid), reviewChangeId);
  await routeEachIdentity(lifecycleChangeIds, (id) => ctx.orchestrator.triggerFeedbackForChange(ctx.integrationId, id));
  return { status: 202, body: { queued: true, action: "feedback", changeId: reviewChangeId } };
};

interface GitlabMrPayload {
  iid: number | string;
  action?: string;
  oldrev?: string | undefined;
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
  const action = typeof a["action"] === "string" ? (a["action"]) : undefined;
  const oldrev = typeof a["oldrev"] === "string" && a["oldrev"].length > 0 ? a["oldrev"] : undefined;
  return {
    iid,
    ...(action !== undefined ? { action } : {}),
    ...(oldrev !== undefined ? { oldrev } : {}),
  };
}

/** Map a dotted event path (e.g. `merge_request.approved`) to its action suffix. */
function eventToAction(event: string): string | undefined {
  const suffix = event.split(".")[1];
  return suffix;
}

/** Qualify reviewer triggers so an MR IID cannot select the wrong project. */
function qualifyReviewChangeId(payload: unknown, iid: string): string {
  if (typeof payload !== "object" || payload === null) return iid;
  const root = payload as Record<string, unknown>;
  const project = root["project"];
  if (typeof project === "object" && project !== null) {
    const path = (project as Record<string, unknown>)["path_with_namespace"];
    if (typeof path === "string" && path.length > 0) return `${path}#${iid}`;
  }
  return iid;
}

/**
 * Qualified ids for lifecycle and feedback routing. Project bindings may record
 * a GitLab repository by path or by numeric project id, and the authenticated
 * payload names both identities of the same project; each qualified id still
 * matches only change rows recorded for that repository identity.
 */
function qualifyLifecycleChangeIds(payload: unknown, iid: string, pathChangeId: string): string[] {
  const projectId = extractProjectId(payload);
  return pathChangeId === iid || projectId === null ? [pathChangeId] : [pathChangeId, `${projectId}#${iid}`];
}

function extractProjectId(payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null) return null;
  const project = (payload as Record<string, unknown>)["project"];
  if (typeof project !== "object" || project === null) return null;
  const id = (project as Record<string, unknown>)["id"];
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Route one event under each project identity; a failure for one never skips another. */
async function routeEachIdentity(
  changeIds: readonly string[],
  route: (changeId: string) => Promise<void>,
): Promise<void> {
  const failures: unknown[] = [];
  for (const changeId of changeIds) {
    try {
      await route(changeId);
    } catch (err) {
      failures.push(err);
    }
  }
  if (failures.length > 0) throw failures[0];
}

/** Detect GitLab reviewer-list changes without treating every metadata update as a revision. */
function hasReviewerChange(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const changes = (payload as Record<string, unknown>)["changes"];
  if (typeof changes !== "object" || changes === null) return false;
  const reviewers = (changes as Record<string, unknown>)["reviewers"];
  if (typeof reviewers !== "object" || reviewers === null) return false;
  const record = reviewers as Record<string, unknown>;
  return "current" in record || "previous" in record;
}
