import { describe, it, expect, vi } from "vitest";
import { gitlabMergeRequestWebhookHandler } from "../../src/webhooks/handlers/gitlab-merge-request.js";
import type { WebhookContext, WebhookCapableOrchestrator, ProjectLookupStore } from "../../src/webhooks/webhookServer.js";
import type { Integration } from "../../src/interfaces.js";
import { getLogger } from "../../src/logger.js";

const integration: Integration = {
  id: "mr-1",
  type: "gitlab-merge-request",
  name: "MR",
  configJson: JSON.stringify({ webhookSecret: "x", baseUrl: "https://gitlab/", projectId: "1", token: "t" }),
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeCtx(event: string, payload: unknown): {
  ctx: WebhookContext;
  orch: WebhookCapableOrchestrator;
} {
  const orch: WebhookCapableOrchestrator = {
    startTaskForProject: vi.fn(async () => {}),
    triggerFeedbackForChange: vi.fn(async () => {}),
    markChangeMerged: vi.fn(async () => {}),
    markChangeAbandoned: vi.fn(async () => {}),
  };
  const projectStore: ProjectLookupStore = { findProjectByTicketSource: vi.fn(async () => null) };
  return {
    orch,
    ctx: {
      integrationId: integration.id,
      integration,
      event,
      payload,
      rawBody: "",
      headers: {},
      projectStore,
      orchestrator: orch,
      log: getLogger("test"),
    },
  };
}

describe("gitlabMergeRequestWebhookHandler", () => {
  it("routes merge_request action 'merge' to markChangeMerged", async () => {
    const { ctx, orch } = makeCtx("merge_request", { object_attributes: { iid: 7, action: "merge" } });
    const r = await gitlabMergeRequestWebhookHandler(ctx);
    expect(r.status).toBe(202);
    expect(orch.markChangeMerged).toHaveBeenCalledWith("mr-1", "7");
    expect(orch.markChangeAbandoned).not.toHaveBeenCalled();
    expect(orch.triggerFeedbackForChange).not.toHaveBeenCalled();
  });

  it("routes action 'close' to markChangeAbandoned", async () => {
    const { ctx, orch } = makeCtx("merge_request", { object_attributes: { iid: 9, action: "close" } });
    const r = await gitlabMergeRequestWebhookHandler(ctx);
    expect(r.status).toBe(202);
    expect(orch.markChangeAbandoned).toHaveBeenCalledWith("mr-1", "9");
  });

  it("routes action 'update' to triggerFeedbackForChange", async () => {
    const { ctx, orch } = makeCtx("merge_request", { object_attributes: { iid: 5, action: "update" } });
    const r = await gitlabMergeRequestWebhookHandler(ctx);
    expect(r.status).toBe(202);
    expect(orch.triggerFeedbackForChange).toHaveBeenCalledWith("mr-1", "5");
  });

  it("routes action 'approved' to triggerFeedbackForChange", async () => {
    const { ctx, orch } = makeCtx("merge_request.approved", { object_attributes: { iid: 11 } });
    const r = await gitlabMergeRequestWebhookHandler(ctx);
    expect(r.status).toBe(202);
    expect(orch.triggerFeedbackForChange).toHaveBeenCalledWith("mr-1", "11");
  });

  it("routes Note Hook on a merge request to triggerFeedbackForChange", async () => {
    const { ctx, orch } = makeCtx("note", { merge_request: { iid: 13 }, object_attributes: { note: "hi" } });
    const r = await gitlabMergeRequestWebhookHandler(ctx);
    expect(r.status).toBe(202);
    expect(orch.triggerFeedbackForChange).toHaveBeenCalledWith("mr-1", "13");
  });

  it("ignores Note Hook when not on a merge request", async () => {
    const { ctx, orch } = makeCtx("note", { commit: { id: "abc" }, object_attributes: { note: "hi" } });
    const r = await gitlabMergeRequestWebhookHandler(ctx);
    expect(r.status).toBe(202);
    expect((r.body as { ignored: boolean }).ignored).toBe(true);
    expect(orch.triggerFeedbackForChange).not.toHaveBeenCalled();
  });

  it("returns 400 when merge_request payload missing iid", async () => {
    const { ctx } = makeCtx("merge_request", { object_attributes: { action: "merge" } });
    const r = await gitlabMergeRequestWebhookHandler(ctx);
    expect(r.status).toBe(400);
  });

  it("ignores unknown event", async () => {
    const { ctx } = makeCtx("issue", {});
    const r = await gitlabMergeRequestWebhookHandler(ctx);
    expect(r.status).toBe(202);
    expect((r.body as { ignored: boolean }).ignored).toBe(true);
  });
});
