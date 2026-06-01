import { describe, it, expect, vi } from "vitest";
import { redmineWebhookHandler } from "../../src/webhooks/handlers/redmine.js";
import type { WebhookContext, WebhookCapableOrchestrator, ProjectLookupStore } from "../../src/webhooks/webhookServer.js";
import type { Integration, ProjectRecord, ProjectId, AgentId } from "../../src/interfaces.js";
import { getLogger } from "../../src/logger.js";

const integration: Integration = {
  id: "redmine-1",
  type: "redmine",
  name: "R",
  configJson: JSON.stringify({ webhookSecret: "x", baseUrl: "http://r/", apiKey: "k", virtualEngineerUserLogin: "ve" }),
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
  cacheVolumeName: null,
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
      event: overrides.event ?? "issue.created",
      payload: overrides.payload ?? {
        issue: { id: 42, subject: "S", description: "D", project: { identifier: "my-proj" } },
        url: "http://r/issues/42",
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

describe("redmineWebhookHandler", () => {
  it("routes issue.created to startTaskForProject for the resolved project", async () => {
    const { ctx, orchestrator, projectStore } = makeCtx();
    const result = await redmineWebhookHandler(ctx);
    expect(result.status).toBe(202);
    expect(projectStore.findProjectByTicketSource).toHaveBeenCalledWith("redmine-1", "my-proj");
    expect(orchestrator.startTaskForProject).toHaveBeenCalledTimes(1);
    const [ticket, proj, label] = (orchestrator.startTaskForProject as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(ticket).toMatchObject({ id: "42", subject: "S", description: "D", webUrl: "http://r/issues/42" });
    expect(proj).toBe(project);
    expect(label).toBe("redmine");
  });

  it("routes issue.updated identically", async () => {
    const { ctx, orchestrator } = makeCtx({ event: "issue.updated" });
    const r = await redmineWebhookHandler(ctx);
    expect(r.status).toBe(202);
    expect(orchestrator.startTaskForProject).toHaveBeenCalled();
  });

  it("returns 202 ignored when no project is configured for the ticket source", async () => {
    const { ctx, orchestrator } = makeCtx({ project: null });
    const r = await redmineWebhookHandler(ctx);
    expect(r.status).toBe(202);
    expect((r.body as { ignored: boolean }).ignored).toBe(true);
    expect(orchestrator.startTaskForProject).not.toHaveBeenCalled();
  });

  it("returns 400 when payload missing 'issue'", async () => {
    const { ctx } = makeCtx({ payload: { foo: 1 } });
    const r = await redmineWebhookHandler(ctx);
    expect(r.status).toBe(400);
  });

  it("returns 400 when payload missing project identifier", async () => {
    const { ctx } = makeCtx({ payload: { issue: { id: 1 } } });
    const r = await redmineWebhookHandler(ctx);
    expect(r.status).toBe(400);
  });

  it("returns 202 ignored for unknown event", async () => {
    const { ctx, orchestrator } = makeCtx({ event: "ping" });
    const r = await redmineWebhookHandler(ctx);
    expect(r.status).toBe(202);
    expect((r.body as { ignored: boolean }).ignored).toBe(true);
    expect(orchestrator.startTaskForProject).not.toHaveBeenCalled();
  });
});
