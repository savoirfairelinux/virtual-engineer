import { describe, it, expect, vi } from "vitest";
import { gitlabIssueWebhookHandler } from "../../src/webhooks/handlers/gitlab-issue.js";
import type { WebhookContext, WebhookCapableOrchestrator, ProjectLookupStore } from "../../src/webhooks/webhookServer.js";
import type { Integration, ProjectRecord, ProjectId, AgentId } from "../../src/interfaces.js";
import { getLogger } from "../../src/logger.js";

const integration: Integration = {
  id: "gl-1",
  type: "gitlab-issue",
  name: "G",
  configJson: JSON.stringify({ webhookSecret: "x", baseUrl: "https://gitlab/", projectId: "1", token: "t" }),
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const project: ProjectRecord = {
  id: "p-1" as ProjectId,
  name: "Sample",
  type: "coding",
  agentId: "a-1" as AgentId,
  agentOverrideJson: null,
  postCloneScript: "",
  homeCacheSeed: "",
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeCtx(overrides: { event?: string; payload?: unknown; project?: ProjectRecord | null } = {}): {
  ctx: WebhookContext;
  orchestrator: WebhookCapableOrchestrator;
  projectStore: ProjectLookupStore;
} {
  const orchestrator: WebhookCapableOrchestrator = {
    startTaskForProject: vi.fn(async () => {}),
    triggerFeedbackForChange: vi.fn(async () => {}),
    markChangeMerged: vi.fn(async () => {}),
    markChangeAbandoned: vi.fn(async () => {}),
  };
  const projectStore: ProjectLookupStore = {
    findProjectByTicketSource: vi.fn(async () => ("project" in overrides ? overrides.project ?? null : project)),
  };
  return {
    ctx: {
      integrationId: integration.id,
      integration,
      event: overrides.event ?? "issue",
      payload: overrides.payload ?? {
        object_kind: "issue",
        project: { path_with_namespace: "group/proj", id: 42 },
        object_attributes: { iid: 7, title: "T", description: "D", url: "https://gitlab/group/proj/-/issues/7", action: "open" },
      },
      rawBody: "",
      headers: {},
      projectStore,
      orchestrator,
      log: getLogger("test"),
    },
    orchestrator,
    projectStore,
  };
}

describe("gitlabIssueWebhookHandler", () => {
  it("routes Issue Hook to startTaskForProject with project resolved by path_with_namespace", async () => {
    const { ctx, orchestrator, projectStore } = makeCtx();
    const result = await gitlabIssueWebhookHandler(ctx);
    expect(result.status).toBe(202);
    expect(projectStore.findProjectByTicketSource).toHaveBeenCalledWith("gl-1", "group/proj");
    const [ticket, proj, label] = (orchestrator.startTaskForProject as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(ticket).toMatchObject({ id: "7", subject: "T", description: "D", webUrl: "https://gitlab/group/proj/-/issues/7" });
    expect(proj).toBe(project);
    expect(label).toBe("gitlab-issue");
  });

  it("ignores when no project is configured", async () => {
    const { ctx, orchestrator } = makeCtx({ project: null });
    const r = await gitlabIssueWebhookHandler(ctx);
    expect(r.status).toBe(202);
    expect((r.body as { ignored: boolean }).ignored).toBe(true);
    expect(orchestrator.startTaskForProject).not.toHaveBeenCalled();
  });

  it("returns 400 when missing object_attributes", async () => {
    const { ctx } = makeCtx({ payload: { project: { path_with_namespace: "x" } } });
    const r = await gitlabIssueWebhookHandler(ctx);
    expect(r.status).toBe(400);
  });

  it("returns 400 when missing project.path_with_namespace", async () => {
    const { ctx } = makeCtx({ payload: { object_attributes: { iid: 1 } } });
    const r = await gitlabIssueWebhookHandler(ctx);
    expect(r.status).toBe(400);
  });

  it("ignores unknown event", async () => {
    const { ctx } = makeCtx({ event: "merge_request" });
    const r = await gitlabIssueWebhookHandler(ctx);
    expect(r.status).toBe(202);
    expect((r.body as { ignored: boolean }).ignored).toBe(true);
  });
});
