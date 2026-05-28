import { describe, it, expect, vi } from "vitest";
import { githubPullRequestWebhookHandler } from "../../src/webhooks/handlers/github-pull-request.js";
import type { WebhookContext, WebhookCapableOrchestrator, ProjectLookupStore } from "../../src/webhooks/webhookServer.js";
import type { IncomingMessage } from "node:http";
import type { Integration } from "../../src/interfaces.js";
import { getLogger } from "../../src/logger.js";

const integration: Integration = {
  id: "gh-1",
  type: "github-pull-request",
  name: "GH",
  configJson: JSON.stringify({
    mode: "github.com",
    authMode: "pat",
    token: "ghp_x",
    repositorySlug: "octocat/hello-world",
    webhookSecret: "s",
  }),
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeCtx(githubEvent: string | undefined, payload: unknown): {
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
  const headers: IncomingMessage["headers"] = githubEvent !== undefined ? { "x-github-event": githubEvent } : {};
  return {
    orch,
    ctx: {
      integrationId: integration.id,
      integration,
      event: "github",
      payload,
      rawBody: "",
      headers,
      projectStore,
      orchestrator: orch,
      log: getLogger("test"),
    },
  };
}

describe("githubPullRequestWebhookHandler", () => {
  it("rejects requests missing X-GitHub-Event header", async () => {
    const { ctx, orch } = makeCtx(undefined, {});
    const r = await githubPullRequestWebhookHandler(ctx);
    expect(r.status).toBe(400);
    expect(orch.triggerFeedbackForChange).not.toHaveBeenCalled();
  });

  it("answers ping events with 200/pong", async () => {
    const { ctx } = makeCtx("ping", { zen: "Anything added dilutes everything else." });
    const r = await githubPullRequestWebhookHandler(ctx);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ pong: true });
  });

  it("ignores unknown GitHub events with 202", async () => {
    const { ctx, orch } = makeCtx("star", {});
    const r = await githubPullRequestWebhookHandler(ctx);
    expect(r.status).toBe(202);
    expect(orch.triggerFeedbackForChange).not.toHaveBeenCalled();
  });

  it("pull_request action=closed&merged=true → markChangeMerged", async () => {
    const { ctx, orch } = makeCtx("pull_request", {
      action: "closed",
      repository: { name: "hello-world" },
      pull_request: { number: 42, merged: true },
    });
    const r = await githubPullRequestWebhookHandler(ctx);
    expect(r.status).toBe(202);
    expect(orch.markChangeMerged).toHaveBeenCalledWith("gh-1", "hello-world#42");
    expect(orch.markChangeAbandoned).not.toHaveBeenCalled();
  });

  it("pull_request action=closed&merged=false → markChangeAbandoned", async () => {
    const { ctx, orch } = makeCtx("pull_request", {
      action: "closed",
      repository: { name: "hello-world" },
      pull_request: { number: 13, merged: false },
    });
    const r = await githubPullRequestWebhookHandler(ctx);
    expect(r.status).toBe(202);
    expect(orch.markChangeAbandoned).toHaveBeenCalledWith("gh-1", "hello-world#13");
    expect(orch.markChangeMerged).not.toHaveBeenCalled();
  });

  it("pull_request action=synchronize → triggerFeedbackForChange", async () => {
    const { ctx, orch } = makeCtx("pull_request", {
      action: "synchronize",
      repository: { name: "hello-world" },
      pull_request: { number: 7 },
    });
    const r = await githubPullRequestWebhookHandler(ctx);
    expect(r.status).toBe(202);
    expect(orch.triggerFeedbackForChange).toHaveBeenCalledWith("gh-1", "hello-world#7");
  });

  it("pull_request action=opened → triggerReviewForChange + triggerFeedbackForChange", async () => {
    const { ctx, orch } = makeCtx("pull_request", {
      action: "opened",
      repository: { name: "hello-world" },
      pull_request: { number: 100 },
    });
    const r = await githubPullRequestWebhookHandler(ctx);
    expect(r.status).toBe(202);
    expect(orch.triggerReviewForChange).toHaveBeenCalledWith("gh-1", "hello-world#100");
    expect(orch.triggerFeedbackForChange).toHaveBeenCalledWith("gh-1", "hello-world#100");
  });

  it("pull_request action=edited (non-review-trigger) → only triggerFeedbackForChange", async () => {
    const { ctx, orch } = makeCtx("pull_request", {
      action: "edited",
      repository: { name: "hello-world" },
      pull_request: { number: 101 },
    });
    const r = await githubPullRequestWebhookHandler(ctx);
    expect(r.status).toBe(202);
    expect(orch.triggerReviewForChange).not.toHaveBeenCalled();
    expect(orch.triggerFeedbackForChange).toHaveBeenCalledWith("gh-1", "hello-world#101");
  });

  it("pull_request action=ready_for_review → triggerReviewForChange", async () => {
    const { ctx, orch } = makeCtx("pull_request", {
      action: "ready_for_review",
      repository: { name: "hello-world" },
      pull_request: { number: 102 },
    });
    await githubPullRequestWebhookHandler(ctx);
    expect(orch.triggerReviewForChange).toHaveBeenCalledWith("gh-1", "hello-world#102");
  });

  it("review trigger error does not block feedback path", async () => {
    const { ctx, orch } = makeCtx("pull_request", {
      action: "opened",
      repository: { name: "hello-world" },
      pull_request: { number: 103 },
    });
    (orch.triggerReviewForChange as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    const r = await githubPullRequestWebhookHandler(ctx);
    expect(r.status).toBe(202);
    expect(orch.triggerFeedbackForChange).toHaveBeenCalledWith("gh-1", "hello-world#103");
  });

  it("pull_request_review (submitted) → triggerFeedbackForChange", async () => {
    const { ctx, orch } = makeCtx("pull_request_review", {
      action: "submitted",
      repository: { name: "hello-world" },
      pull_request: { number: 99 },
    });
    const r = await githubPullRequestWebhookHandler(ctx);
    expect(r.status).toBe(202);
    expect(orch.triggerFeedbackForChange).toHaveBeenCalledWith("gh-1", "hello-world#99");
  });

  it("pull_request_review_comment → triggerFeedbackForChange", async () => {
    const { ctx, orch } = makeCtx("pull_request_review_comment", {
      action: "created",
      repository: { name: "hello-world" },
      pull_request: { number: 100 },
    });
    const r = await githubPullRequestWebhookHandler(ctx);
    expect(r.status).toBe(202);
    expect(orch.triggerFeedbackForChange).toHaveBeenCalledWith("gh-1", "hello-world#100");
  });

  it("issue_comment on a PR → triggerFeedbackForChange", async () => {
    const { ctx, orch } = makeCtx("issue_comment", {
      action: "created",
      repository: { name: "hello-world" },
      issue: { number: 55, pull_request: { url: "..." } },
    });
    const r = await githubPullRequestWebhookHandler(ctx);
    expect(r.status).toBe(202);
    expect(orch.triggerFeedbackForChange).toHaveBeenCalledWith("gh-1", "hello-world#55");
  });

  it("issue_comment on a plain issue (no pull_request field) → ignored", async () => {
    const { ctx, orch } = makeCtx("issue_comment", {
      action: "created",
      issue: { number: 56 },
    });
    const r = await githubPullRequestWebhookHandler(ctx);
    expect(r.status).toBe(202);
    expect(orch.triggerFeedbackForChange).not.toHaveBeenCalled();
  });

  it("rejects pull_request payload missing pull_request object", async () => {
    const { ctx, orch } = makeCtx("pull_request", { action: "opened" });
    const r = await githubPullRequestWebhookHandler(ctx);
    expect(r.status).toBe(400);
    expect(orch.triggerFeedbackForChange).not.toHaveBeenCalled();
  });

  it("rejects pull_request payload missing number", async () => {
    const { ctx } = makeCtx("pull_request", { action: "opened", pull_request: {} });
    const r = await githubPullRequestWebhookHandler(ctx);
    expect(r.status).toBe(400);
  });
});
