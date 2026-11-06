import { describe, it, expect, vi } from "vitest";
import { gitlabMergeRequestWebhookHandler } from "../../src/webhooks/handlers/gitlab-merge-request.js";
import type { WebhookContext, WebhookCapableOrchestrator, ProjectLookupStore } from "../../src/webhooks/webhookServer.js";
import type { Integration } from "../../src/interfaces.js";
import { getLogger } from "../../src/logger.js";

const integration: Integration = {
  id: "mr-1",
  provider: "gitlab",
  name: "MR",
  configJson: JSON.stringify({ webhookSecret: "x", baseUrl: "https://gitlab/", token: "t" }),
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
    triggerReviewForChange: vi.fn(async () => {}),
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

  it("qualifies the review trigger with the GitLab project path", async () => {
    const { ctx, orch } = makeCtx("merge_request", {
      object_attributes: { iid: 15, action: "update", oldrev: "old" },
      project: { path_with_namespace: "group/project" },
    });
    const r = await gitlabMergeRequestWebhookHandler(ctx);
    expect(r.status).toBe(202);
    expect(orch.triggerReviewForChange).toHaveBeenCalledWith("mr-1", "group/project#15");
    expect(orch.triggerFeedbackForChange).toHaveBeenCalledWith("mr-1", "group/project#15");
  });

  it("triggers review only for a GitLab revision update", async () => {
    const { ctx, orch } = makeCtx("merge_request", {
      object_attributes: { iid: 16, action: "update", oldrev: "abc123" },
      project: { path_with_namespace: "group/project" },
    });
    await gitlabMergeRequestWebhookHandler(ctx);

    expect(orch.triggerReviewForChange).toHaveBeenCalledWith("mr-1", "group/project#16");
  });

  it("routes reviewer-list changes through verified assignment handling", async () => {
    const { ctx, orch } = makeCtx("merge_request", {
      object_attributes: { iid: 17, action: "update" },
      project: { path_with_namespace: "group/project" },
      changes: { reviewers: { previous: [], current: [{ username: "ve-bot" }] } },
    });
    await gitlabMergeRequestWebhookHandler(ctx);

    expect(orch.triggerReviewForChange).toHaveBeenCalledWith(
      "mr-1",
      "group/project#17",
      { triggerCause: "reviewer-change" },
    );
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

  describe("project identities", () => {
    // GitLab bindings may record a repository by path or by numeric project id.
    const project = { id: 7, path_with_namespace: "group/project" };

    it.each([
      { action: "merge", entryPoint: "markChangeMerged" },
      { action: "close", entryPoint: "markChangeAbandoned" },
      { action: "update", entryPoint: "triggerFeedbackForChange" },
    ] as const)("routes '$action' under the project path and its numeric id", async ({ action, entryPoint }) => {
      const { ctx, orch } = makeCtx("merge_request", { object_attributes: { iid: 42, action }, project });

      const r = await gitlabMergeRequestWebhookHandler(ctx);

      expect(r.status).toBe(202);
      expect(vi.mocked(orch[entryPoint]).mock.calls).toEqual([
        ["mr-1", "group/project#42"],
        ["mr-1", "7#42"],
      ]);
    });

    it("routes Note Hook feedback under both project identities", async () => {
      const { ctx, orch } = makeCtx("note", { merge_request: { iid: 42 }, project });

      await gitlabMergeRequestWebhookHandler(ctx);

      expect(vi.mocked(orch.triggerFeedbackForChange).mock.calls).toEqual([
        ["mr-1", "group/project#42"],
        ["mr-1", "7#42"],
      ]);
    });

    it("keeps review triggers on the project path only", async () => {
      const { ctx, orch } = makeCtx("merge_request", {
        object_attributes: { iid: 42, action: "update", oldrev: "abc123" },
        project,
      });

      await gitlabMergeRequestWebhookHandler(ctx);

      expect(orch.triggerReviewForChange).toHaveBeenCalledExactlyOnceWith("mr-1", "group/project#42");
    });

    it.each([0, -7, 7.5, "7", null])("ignores an invalid numeric project id (%s)", async (id) => {
      const { ctx, orch } = makeCtx("merge_request", {
        object_attributes: { iid: 42, action: "merge" },
        project: { id, path_with_namespace: "group/project" },
      });

      await gitlabMergeRequestWebhookHandler(ctx);

      expect(orch.markChangeMerged).toHaveBeenCalledExactlyOnceWith("mr-1", "group/project#42");
    });

    it("does not add a numeric identity to an unqualified IID", async () => {
      const { ctx, orch } = makeCtx("merge_request", { object_attributes: { iid: 42, action: "merge" }, project: { id: 7 } });

      await gitlabMergeRequestWebhookHandler(ctx);

      expect(orch.markChangeMerged).toHaveBeenCalledExactlyOnceWith("mr-1", "42");
    });

    it("still routes the numeric identity when the path identity fails", async () => {
      const { ctx, orch } = makeCtx("merge_request", { object_attributes: { iid: 42, action: "merge" }, project });
      vi.mocked(orch.markChangeMerged).mockRejectedValueOnce(new Error("path routing failed"));

      await expect(gitlabMergeRequestWebhookHandler(ctx)).rejects.toThrow("path routing failed");

      expect(orch.markChangeMerged).toHaveBeenLastCalledWith("mr-1", "7#42");
    });
  });
});
