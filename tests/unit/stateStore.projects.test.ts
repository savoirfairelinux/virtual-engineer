import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { SqliteStateStore, resolveAgentConfig } from "../../src/state/stateStore.js";
import {
  makeAgentId,
  makeProjectId,
  makeTaskId,
  makeTicketId,
  type AgentRecord,
  type ProjectRecord,
} from "../../src/interfaces.js";

function tempDbPath(): string {
  return join(tmpdir(), `ve-projects-${randomUUID()}.db`);
}

async function makeAgent(store: SqliteStateStore, overrides: Partial<Parameters<SqliteStateStore["createAgent"]>[0]> = {}) {
  return store.createAgent({
    name: "Default Coding Agent",
    type: "coding",
    modelConfigJson: JSON.stringify({ model: "gpt-4.1", apiKey: "tok" }),
    enabled: true,
    ...overrides,
  });
}

async function makeIntegration(store: SqliteStateStore, id: string, type: "redmine" | "gerrit" = "redmine") {
  await store.upsertIntegration({ id, type, name: id, configJson: "{}", enabled: true });
}

describe("SqliteStateStore — Phase 2: agents", () => {
  let store: SqliteStateStore;

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDbPath());
  });

  afterEach(() => {
    store.close();
  });

  it("creates and retrieves an agent", async () => {
    const a = await makeAgent(store);
    expect(a.name).toBe("Default Coding Agent");
    expect(a.type).toBe("coding");
    expect(a.enabled).toBe(true);
    expect(a.maxConcurrent).toBe(1);
    const fetched = await store.getAgentById(a.id);
    expect(fetched?.id).toBe(a.id);
  });

  it("listAgents filters by type and enabled", async () => {
    await makeAgent(store, { name: "C1", type: "coding", enabled: true });
    await makeAgent(store, { name: "C2", type: "coding", enabled: false });
    await makeAgent(store, { name: "R1", type: "review", enabled: true });
    expect((await store.listAgents()).length).toBe(3);
    expect((await store.listAgents({ type: "coding" })).length).toBe(2);
    expect((await store.listAgents({ enabled: true })).length).toBe(2);
    expect((await store.listAgents({ type: "review", enabled: true })).length).toBe(1);
  });

  it("updates and toggles agent enabled state", async () => {
    const a = await makeAgent(store, { enabled: false });
    const updated = await store.updateAgent(a.id, { name: "Renamed", maxConcurrent: 5 });
    expect(updated.name).toBe("Renamed");
    expect(updated.maxConcurrent).toBe(5);
    await store.setAgentEnabled(a.id, true);
    const after = await store.getAgentById(a.id);
    expect(after?.enabled).toBe(true);
  });

  it("deleteAgent throws if a project still references it", async () => {
    const a = await makeAgent(store);
    await store.createProject({ name: "P1", type: "coding", agentId: a.id });
    await expect(store.deleteAgent(a.id)).rejects.toThrow(/still referenced/);
  });

  it("deleteAgent succeeds when no project references it", async () => {
    const a = await makeAgent(store);
    await store.deleteAgent(a.id);
    expect(await store.getAgentById(a.id)).toBeNull();
  });
});

describe("SqliteStateStore — Phase 2: projects", () => {
  let store: SqliteStateStore;

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDbPath());
  });

  afterEach(() => {
    store.close();
  });

  it("creates a project linked to an existing agent", async () => {
    const a = await makeAgent(store);
    const p = await store.createProject({
      name: "Coding-1",
      type: "coding",
      agentId: a.id,
      postCloneScript: "echo hi",
    });
    expect(p.agentId).toBe(a.id);
    expect(p.postCloneScript).toBe("echo hi");
    expect(p.enabled).toBe(true);
  });

  it("createProject throws when agent does not exist", async () => {
    await expect(
      store.createProject({ name: "Bad", type: "coding", agentId: makeAgentId("missing") })
    ).rejects.toThrow(/agent not found/);
  });

  it("deleteProject cascades child rows", async () => {
    const a = await makeAgent(store);
    const p = await store.createProject({ name: "P", type: "coding", agentId: a.id });
    await makeIntegration(store, "redmine-1", "redmine");
    await makeIntegration(store, "gerrit-1", "gerrit");
    await store.setProjectTicketSource(p.id, { integrationId: "redmine-1", ticketProjectKey: "PLAT" });
    await store.replaceProjectPushTargets(p.id, [
      { integrationId: "gerrit-1", repoKey: "main", cloneUrl: "ssh://x/main", targetBranch: "main", role: "primary", commitOrder: 1, localPath: "." },
    ]);
    await store.deleteProject(p.id);
    expect(await store.getProjectById(p.id)).toBeNull();
    expect(await store.getProjectTicketSource(p.id)).toBeNull();
    expect((await store.listProjectPushTargets(p.id)).length).toBe(0);
  });

  it("deleteProject abandons non-terminal tasks belonging to the project", async () => {
    const a = await makeAgent(store);
    const p = await store.createProject({ name: "P", type: "coding", agentId: a.id });
    const activeId = makeTaskId(randomUUID());
    const failedId = makeTaskId(randomUUID());
    await store.createTask(activeId, makeTicketId("100"));
    await store.createTask(failedId, makeTicketId("101"));
    await store.setTaskProjectId(activeId, p.id);
    await store.setTaskProjectId(failedId, p.id);
    await store.transition(failedId, "FAILED");

    await store.deleteProject(p.id);

    const active = await store.getTask(activeId);
    const failed = await store.getTask(failedId);
    expect(active?.state).toBe("ABANDONED");
    expect(active?.failureReason).toMatch(/project .* deleted/i);
    expect(failed?.state).toBe("FAILED");
    // project_id is cleared so it doesn't point at a deleted project.
    expect(active?.projectId ?? null).toBeNull();
    expect(failed?.projectId ?? null).toBeNull();
  });

  it("creates a project that adopts orphaned tasks from a previously deleted project with the same ticket source", async () => {
    const a = await makeAgent(store);
    await makeIntegration(store, "redmine-1", "redmine");

    // Project A: created, ticket source set, task created and bound.
    const oldProject = await store.createProject({ name: "Old", type: "coding", agentId: a.id });
    await store.setProjectTicketSource(oldProject.id, {
      integrationId: "redmine-1",
      ticketProjectKey: "PLAT",
    });
    const taskId = makeTaskId(randomUUID());
    await store.createTask(
      taskId,
      makeTicketId("42"),
      "title",
      "desc",
      "redmine",
      undefined,
      undefined,
      { integrationId: "redmine-1", ticketProjectKey: "PLAT" }
    );
    await store.setTaskProjectId(taskId, oldProject.id);

    // Delete project A: task is orphaned (project_id NULL) but ticket source preserved.
    await store.deleteProject(oldProject.id);
    const afterDelete = await store.getTask(taskId);
    expect(afterDelete?.projectId ?? null).toBeNull();
    expect(afterDelete?.state).toBe("ABANDONED");

    // Project B: created with the same ticket source. It should adopt the task.
    const newProject = await store.createProject({ name: "New", type: "coding", agentId: a.id });
    await store.setProjectTicketSource(newProject.id, {
      integrationId: "redmine-1",
      ticketProjectKey: "PLAT",
    });

    const adopted = await store.getTask(taskId);
    expect(adopted?.projectId).toBe(newProject.id);
  });

  it("deleteProject snapshots the ticket source onto tasks that lack one (backfill)", async () => {
    const a = await makeAgent(store);
    await makeIntegration(store, "redmine-1", "redmine");
    const p = await store.createProject({ name: "P", type: "coding", agentId: a.id });
    await store.setProjectTicketSource(p.id, {
      integrationId: "redmine-1",
      ticketProjectKey: "PLAT",
    });

    const taskId = makeTaskId(randomUUID());
    // Task created WITHOUT ticket-source snapshot (simulates legacy data).
    await store.createTask(taskId, makeTicketId("99"));
    await store.setTaskProjectId(taskId, p.id);

    await store.deleteProject(p.id);

    // A new project with the same ticket source should still be able to adopt it.
    const p2 = await store.createProject({ name: "P2", type: "coding", agentId: a.id });
    await store.setProjectTicketSource(p2.id, {
      integrationId: "redmine-1",
      ticketProjectKey: "PLAT",
    });

    const adopted = await store.getTask(taskId);
    expect(adopted?.projectId).toBe(p2.id);
  });

  it("setProjectEnabled toggles and listProjects filters work", async () => {
    const a = await makeAgent(store);
    const p1 = await store.createProject({ name: "A", type: "coding", agentId: a.id, enabled: true });
    await store.createProject({ name: "B", type: "review", agentId: a.id, enabled: false });
    expect((await store.listProjects({ type: "coding" })).length).toBe(1);
    expect((await store.listProjects({ enabled: false })).length).toBe(1);
    await store.setProjectEnabled(p1.id, false);
    expect((await store.listProjects({ enabled: true })).length).toBe(0);
  });
});

describe("SqliteStateStore — Phase 2: project ticket source", () => {
  let store: SqliteStateStore;

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDbPath());
  });

  afterEach(() => {
    store.close();
  });

  it("globally unique on (integrationId, ticketProjectKey)", async () => {
    const a = await makeAgent(store);
    const p1 = await store.createProject({ name: "P1", type: "coding", agentId: a.id });
    const p2 = await store.createProject({ name: "P2", type: "coding", agentId: a.id });
    await makeIntegration(store, "redmine-1");
    await store.setProjectTicketSource(p1.id, { integrationId: "redmine-1", ticketProjectKey: "PLAT" });
    await expect(
      store.setProjectTicketSource(p2.id, { integrationId: "redmine-1", ticketProjectKey: "PLAT" })
    ).rejects.toThrow(/already claimed/);
  });

  it("same project may update its own ticket source freely", async () => {
    const a = await makeAgent(store);
    const p = await store.createProject({ name: "P", type: "coding", agentId: a.id });
    await makeIntegration(store, "redmine-1");
    await store.setProjectTicketSource(p.id, { integrationId: "redmine-1", ticketProjectKey: "PLAT" });
    const updated = await store.setProjectTicketSource(p.id, { integrationId: "redmine-1", ticketProjectKey: "OTHER" });
    expect(updated.ticketProjectKey).toBe("OTHER");
    const fetched = await store.getProjectTicketSource(p.id);
    expect(fetched?.ticketProjectKey).toBe("OTHER");
  });

  it("findProjectByTicketSource returns the right project", async () => {
    const a = await makeAgent(store);
    const p = await store.createProject({ name: "P", type: "coding", agentId: a.id });
    await makeIntegration(store, "redmine-1");
    await store.setProjectTicketSource(p.id, { integrationId: "redmine-1", ticketProjectKey: "PLAT" });
    const found = await store.findProjectByTicketSource("redmine-1", "PLAT");
    expect(found?.id).toBe(p.id);
    expect(await store.findProjectByTicketSource("redmine-1", "NOPE")).toBeNull();
  });
});

describe("SqliteStateStore — Phase 2: project push targets", () => {
  let store: SqliteStateStore;

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDbPath());
  });

  afterEach(() => {
    store.close();
  });

  it("listProjectPushTargets returns rows ordered by commitOrder", async () => {
    const a = await makeAgent(store);
    const p = await store.createProject({ name: "P", type: "coding", agentId: a.id });
    await makeIntegration(store, "g1", "gerrit");
    await store.replaceProjectPushTargets(p.id, [
      { integrationId: "g1", repoKey: "core", cloneUrl: "ssh://x/core", targetBranch: "main", role: "submodule", commitOrder: 2, localPath: "libs/core" },
      { integrationId: "g1", repoKey: "main", cloneUrl: "ssh://x/main", targetBranch: "main", role: "primary", commitOrder: 1, localPath: "." },
    ]);
    const targets = await store.listProjectPushTargets(p.id);
    expect(targets.map((t) => t.repoKey)).toEqual(["main", "core"]);
  });

  it("replaceProjectPushTargets is atomic — rolls back on commit_order conflict", async () => {
    const a = await makeAgent(store);
    const p = await store.createProject({ name: "P", type: "coding", agentId: a.id });
    await makeIntegration(store, "g1", "gerrit");
    await store.replaceProjectPushTargets(p.id, [
      { integrationId: "g1", repoKey: "main", cloneUrl: "ssh://x/main", targetBranch: "main", role: "primary", commitOrder: 1, localPath: "." },
    ]);
    await expect(
      store.replaceProjectPushTargets(p.id, [
        { integrationId: "g1", repoKey: "a", cloneUrl: "u", targetBranch: "main", role: "primary", commitOrder: 1, localPath: "." },
        { integrationId: "g1", repoKey: "b", cloneUrl: "u", targetBranch: "main", role: "submodule", commitOrder: 1, localPath: "libs/b" },
      ])
    ).rejects.toThrow();
    // Original row preserved due to rollback.
    const after = await store.listProjectPushTargets(p.id);
    expect(after.map((t) => t.repoKey)).toEqual(["main"]);
  });

  it("removeProjectPushTarget removes a single row", async () => {
    const a = await makeAgent(store);
    const p = await store.createProject({ name: "P", type: "coding", agentId: a.id });
    await makeIntegration(store, "g1", "gerrit");
    const t = await store.addProjectPushTarget(p.id, {
      integrationId: "g1", repoKey: "main", cloneUrl: "u", targetBranch: "main", role: "primary", commitOrder: 1, localPath: ".",
    });
    await store.removeProjectPushTarget(t.id);
    expect((await store.listProjectPushTargets(p.id)).length).toBe(0);
  });
});

describe("SqliteStateStore — Phase 2: project review config", () => {
  let store: SqliteStateStore;

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDbPath());
  });

  afterEach(() => {
    store.close();
  });

  it("setProjectReviewConfig + getProjectReviewConfig round-trips integration + repos", async () => {
    const a = await makeAgent(store, { type: "review" });
    const p = await store.createProject({ name: "R", type: "review", agentId: a.id, enabled: true });
    await makeIntegration(store, "g1", "gerrit");
    await store.setProjectReviewConfig(p.id, "g1", ["repo/a", "repo/b"]);
    const rc = await store.getProjectReviewConfig(p.id);
    expect(rc).not.toBeNull();
    expect(rc!.integrationId).toBe("g1");
    expect(rc!.repos).toEqual(expect.arrayContaining(["repo/a", "repo/b"]));
  });

  it("multiple projects can share the same (integrationId, repoKey)", async () => {
    const a = await makeAgent(store, { type: "review" });
    const p1 = await store.createProject({ name: "R1", type: "review", agentId: a.id, enabled: true });
    const p2 = await store.createProject({ name: "R2", type: "review", agentId: a.id, enabled: true });
    await makeIntegration(store, "g1", "gerrit");
    await store.setProjectReviewConfig(p1.id, "g1", ["my/repo"]);
    await store.setProjectReviewConfig(p2.id, "g1", ["my/repo"]);
    const found = await store.findProjectsByReviewTarget("g1", "my/repo");
    expect(found.map((p) => p.id)).toEqual(expect.arrayContaining([p1.id, p2.id]));
  });

  it("findProjectsByReviewTarget returns only projects covering this repoKey", async () => {
    const a = await makeAgent(store, { type: "review" });
    const p = await store.createProject({ name: "R", type: "review", agentId: a.id, enabled: true });
    await makeIntegration(store, "g1", "gerrit");
    await store.setProjectReviewConfig(p.id, "g1", ["my/repo"]);
    const found = await store.findProjectsByReviewTarget("g1", "my/repo");
    expect(found.length).toBe(1);
    expect(found[0]!.id).toBe(p.id);
    const notFound = await store.findProjectsByReviewTarget("g1", "other/repo");
    expect(notFound.length).toBe(0);
  });

  it("findProjectsByReviewTarget excludes disabled projects", async () => {
    const a = await makeAgent(store, { type: "review" });
    const p = await store.createProject({ name: "R", type: "review", agentId: a.id, enabled: false });
    await makeIntegration(store, "g1", "gerrit");
    await store.setProjectReviewConfig(p.id, "g1", ["my/repo"]);
    const found = await store.findProjectsByReviewTarget("g1", "my/repo");
    expect(found.length).toBe(0);
  });
});

describe("SqliteStateStore — Phase 2: integration discovery + concurrency", () => {
  let store: SqliteStateStore;

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDbPath());
  });

  afterEach(() => {
    store.close();
  });

  it("setIntegrationDiscoveredResources round-trips JSON and timestamp", async () => {
    await makeIntegration(store, "redmine-1");
    const before = await store.getIntegrationDiscoveredResources("redmine-1");
    expect(before).toEqual({ json: null, at: null });

    const payload = JSON.stringify({ ticketProjects: [{ id: 1, name: "Plat" }] });
    await store.setIntegrationDiscoveredResources("redmine-1", payload);
    const after = await store.getIntegrationDiscoveredResources("redmine-1");
    expect(after.json).toBe(payload);
    expect(after.at).toBeInstanceOf(Date);
  });

  it("clearIntegrationDiscoveredResources resets snapshot to null", async () => {
    await makeIntegration(store, "redmine-1");
    await store.setIntegrationDiscoveredResources("redmine-1", JSON.stringify({ ticketProjects: [] }));
    expect((await store.getIntegrationDiscoveredResources("redmine-1")).json).not.toBeNull();

    await store.clearIntegrationDiscoveredResources("redmine-1");

    expect(await store.getIntegrationDiscoveredResources("redmine-1")).toEqual({ json: null, at: null });
  });

  it("getGlobalConcurrencyLimit defaults to null", async () => {
    expect(await store.getGlobalConcurrencyLimit()).toBeNull();
  });

  it("setGlobalConcurrencyLimit upserts the singleton", async () => {
    await store.setGlobalConcurrencyLimit(8);
    expect(await store.getGlobalConcurrencyLimit()).toBe(8);
    await store.setGlobalConcurrencyLimit(null);
    expect(await store.getGlobalConcurrencyLimit()).toBeNull();
    await store.setGlobalConcurrencyLimit(3);
    expect(await store.getGlobalConcurrencyLimit()).toBe(3);
  });
});

describe("resolveAgentConfig — partial-merge semantics", () => {
  function buildAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
    return {
      id: makeAgentId("a1"),
      name: "A",
      type: "coding",
      modelConfigJson: JSON.stringify({ model: "gpt-4.1", apiKey: "agent-tok", customFlag: true }),
      integrationId: null,
      systemPromptId: "system",
      instructionsPromptId: "instructions",
      feedbackInstructionsPromptId: null,
      maxConcurrent: 1,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  function buildProject(agentOverrideJson: string | null): ProjectRecord {
    return {
      id: makeProjectId("p1"),
      name: "P",
      type: "coding",
      agentId: makeAgentId("a1"),
      agentOverrideJson,
      postCloneScript: "",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  it("empty override yields agent values", () => {
    const r = resolveAgentConfig(buildAgent(), buildProject(null));
    expect(r.model).toBe("gpt-4.1");
    expect(r.apiKey).toBe("agent-tok");
    expect(r.systemPromptId).toBe("system");
    expect(r.instructionsPromptId).toBe("instructions");
    expect(r.extra["customFlag"]).toBe(true);
  });

  it("override of model only changes model; prompts inherit", () => {
    const r = resolveAgentConfig(buildAgent(), buildProject(JSON.stringify({ model: "claude-3" })));
    expect(r.model).toBe("claude-3");
    expect(r.apiKey).toBe("agent-tok");
    expect(r.systemPromptId).toBe("system");
  });

  it("explicit null in override is treated as 'inherit' (no clear)", () => {
    const r = resolveAgentConfig(
      buildAgent(),
      buildProject(JSON.stringify({ apiKey: null, systemPromptId: null }))
    );
    expect(r.apiKey).toBe("agent-tok");
    expect(r.systemPromptId).toBe("system");
  });

  it("override may set systemPromptId / instructionsPromptId", () => {
    const r = resolveAgentConfig(
      buildAgent(),
      buildProject(JSON.stringify({ systemPromptId: "custom-sys", instructionsPromptId: "custom-ins" }))
    );
    expect(r.systemPromptId).toBe("custom-sys");
    expect(r.instructionsPromptId).toBe("custom-ins");
  });

  it("preserves apiKey overrides from project config", () => {
    const r = resolveAgentConfig(
      buildAgent({
        modelConfigJson: JSON.stringify({
          model: "gpt-4.1",
          apiKey: "agent-key",
          customFlag: true,
        }),
      }),
      buildProject(JSON.stringify({ apiKey: "project-key" }))
    );
    expect(r.apiKey).toBe("project-key");
    expect(r.extra["customFlag"]).toBe(true);
  });

  it("malformed override JSON falls back to agent values", () => {
    const r = resolveAgentConfig(buildAgent(), buildProject("not json"));
    expect(r.model).toBe("gpt-4.1");
    expect(r.apiKey).toBe("agent-tok");
  });

  it("passes reasoningEffort through to extra (validation is a Copilot concern)", () => {
    const r = resolveAgentConfig(
      buildAgent({ modelConfigJson: JSON.stringify({ model: "o3", reasoningEffort: "high" }) }),
      buildProject(null),
    );
    expect(r.extra["reasoningEffort"]).toBe("high");
  });

  it("passes unrecognised reasoningEffort values through to extra unchanged", () => {
    const r = resolveAgentConfig(
      buildAgent({ modelConfigJson: JSON.stringify({ model: "o3", reasoningEffort: "ultra" }) }),
      buildProject(null),
    );
    expect(r.extra["reasoningEffort"]).toBe("ultra");
  });

  it("project override can set reasoningEffort in extra", () => {
    const r = resolveAgentConfig(
      buildAgent({ modelConfigJson: JSON.stringify({ model: "o3", reasoningEffort: "low" }) }),
      buildProject(JSON.stringify({ reasoningEffort: "xhigh" })),
    );
    expect(r.extra["reasoningEffort"]).toBe("xhigh");
  });
});

describe("getProjectForTask helper", () => {
  let store: SqliteStateStore;

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDbPath());
  });

  afterEach(() => {
    store.close();
  });

  it("returns null when task has no projectId", async () => {
    const task = { taskId: "t" as never, projectId: null } as never;
    expect(await store.getProjectForTask(task)).toBeNull();
  });

  it("returns the linked project when projectId is set", async () => {
    const a = await makeAgent(store);
    const p = await store.createProject({ name: "P", type: "coding", agentId: a.id });
    const task = { taskId: "t" as never, projectId: p.id } as never;
    const fetched = await store.getProjectForTask(task);
    expect(fetched?.id).toBe(p.id);
  });
});

describe("SqliteStateStore — retryTask re-attaches orphaned tasks", () => {
  let store: SqliteStateStore;

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDbPath());
  });

  afterEach(() => {
    store.close();
  });

  it("re-attaches an orphaned task to the project that now owns its ticket source", async () => {
    const a = await makeAgent(store);
    await makeIntegration(store, "redmine-1", "redmine");

    const newProject = await store.createProject({ name: "New", type: "coding", agentId: a.id });
    await store.setProjectTicketSource(newProject.id, {
      integrationId: "redmine-1",
      ticketProjectKey: "PLAT",
    });

    const taskId = makeTaskId(randomUUID());
    await store.createTask(
      taskId,
      makeTicketId("42"),
      "title",
      "desc",
      "redmine",
      undefined,
      undefined,
      { integrationId: "redmine-1", ticketProjectKey: "PLAT" }
    );
    await store.transition(taskId, "CONTEXT_BUILDING");
    await store.transition(taskId, "AGENT_RUNNING");
    await store.transition(taskId, "FAILED");

    const beforeRetry = await store.getTask(taskId);
    expect(beforeRetry?.projectId ?? null).toBeNull();

    const retried = await store.retryTask(taskId);

    expect(retried.projectId).toBe(newProject.id);
    expect(retried.state).toBe("DETECTED");
  });

  it("leaves projectId null when no current project matches the task's ticket source", async () => {
    await makeIntegration(store, "redmine-1", "redmine");

    const taskId = makeTaskId(randomUUID());
    await store.createTask(
      taskId,
      makeTicketId("43"),
      "title",
      "desc",
      "redmine",
      undefined,
      undefined,
      { integrationId: "redmine-1", ticketProjectKey: "PLAT" }
    );
    await store.transition(taskId, "CONTEXT_BUILDING");
    await store.transition(taskId, "AGENT_RUNNING");
    await store.transition(taskId, "FAILED");

    const retried = await store.retryTask(taskId);

    expect(retried.projectId).toBeNull();
    expect(retried.state).toBe("DETECTED");
  });

  it("does not change projectId when the task is already attached to a project", async () => {
    const a = await makeAgent(store);
    await makeIntegration(store, "redmine-1", "redmine");

    const project = await store.createProject({ name: "P", type: "coding", agentId: a.id });
    await store.setProjectTicketSource(project.id, {
      integrationId: "redmine-1",
      ticketProjectKey: "PLAT",
    });

    const taskId = makeTaskId(randomUUID());
    await store.createTask(
      taskId,
      makeTicketId("44"),
      "title",
      "desc",
      "redmine",
      undefined,
      undefined,
      { integrationId: "redmine-1", ticketProjectKey: "PLAT" }
    );
    await store.setTaskProjectId(taskId, project.id);
    await store.transition(taskId, "CONTEXT_BUILDING");
    await store.transition(taskId, "AGENT_RUNNING");
    await store.transition(taskId, "FAILED");

    const retried = await store.retryTask(taskId);

    expect(retried.projectId).toBe(project.id);
    expect(retried.state).toBe("DETECTED");
  });

  it("leaves projectId null when the task has no ticket source snapshot", async () => {
    const taskId = makeTaskId(randomUUID());
    await store.createTask(taskId, makeTicketId("45"), "title", "desc", "redmine");
    await store.transition(taskId, "CONTEXT_BUILDING");
    await store.transition(taskId, "AGENT_RUNNING");
    await store.transition(taskId, "FAILED");

    const retried = await store.retryTask(taskId);

    expect(retried.projectId).toBeNull();
    expect(retried.state).toBe("DETECTED");
  });

  it("re-attaches a task whose projectId points to a deleted (ghost) project", async () => {
    const a = await makeAgent(store);
    await makeIntegration(store, "redmine-1", "redmine");

    const project = await store.createProject({ name: "Live", type: "coding", agentId: a.id });
    await store.setProjectTicketSource(project.id, {
      integrationId: "redmine-1",
      ticketProjectKey: "PLAT",
    });

    const taskId = makeTaskId(randomUUID());
    await store.createTask(
      taskId,
      makeTicketId("46"),
      "title",
      "desc",
      "redmine",
      undefined,
      undefined,
      { integrationId: "redmine-1", ticketProjectKey: "PLAT" }
    );
    await store.transition(taskId, "CONTEXT_BUILDING");
    await store.transition(taskId, "AGENT_RUNNING");
    await store.transition(taskId, "FAILED");

    const ghostProjectId = makeProjectId(randomUUID());
    (store as unknown as { raw: { prepare(q: string): { run(...args: unknown[]): unknown } } }).raw
      .prepare("UPDATE tasks SET project_id = ? WHERE task_id = ?")
      .run(ghostProjectId, taskId);

    const retried = await store.retryTask(taskId);

    expect(retried.projectId).toBe(project.id);
    expect(retried.state).toBe("DETECTED");
  });

  it("falls back to ticketSourceLabel when snapshot is missing and a unique integration match exists", async () => {
    const a = await makeAgent(store);
    await makeIntegration(store, "redmine-1", "redmine");

    const project = await store.createProject({ name: "Live", type: "coding", agentId: a.id });
    await store.setProjectTicketSource(project.id, {
      integrationId: "redmine-1",
      ticketProjectKey: "PLAT",
    });

    const taskId = makeTaskId(randomUUID());
    await store.createTask(taskId, makeTicketId("47"), "title", "desc", "redmine:redmine-1");
    await store.transition(taskId, "CONTEXT_BUILDING");
    await store.transition(taskId, "AGENT_RUNNING");
    await store.transition(taskId, "FAILED");

    const retried = await store.retryTask(taskId);

    expect(retried.projectId).toBe(project.id);
    expect(retried.state).toBe("DETECTED");
  });

  it("backfills the ticket source snapshot when adopting via label fallback", async () => {
    const a = await makeAgent(store);
    await makeIntegration(store, "redmine-1", "redmine");

    const project = await store.createProject({ name: "Live", type: "coding", agentId: a.id });
    await store.setProjectTicketSource(project.id, {
      integrationId: "redmine-1",
      ticketProjectKey: "PLAT",
    });

    const taskId = makeTaskId(randomUUID());
    await store.createTask(taskId, makeTicketId("48"), "title", "desc", "redmine:redmine-1");
    await store.transition(taskId, "CONTEXT_BUILDING");
    await store.transition(taskId, "AGENT_RUNNING");
    await store.transition(taskId, "FAILED");

    await store.retryTask(taskId);

    const row = (store as unknown as { raw: { prepare(q: string): { get(...args: unknown[]): unknown } } }).raw
      .prepare("SELECT ticket_source_integration_id AS i, ticket_source_project_key AS k FROM tasks WHERE task_id = ?")
      .get(taskId) as { i: string | null; k: string | null };
    expect(row.i).toBe("redmine-1");
    expect(row.k).toBe("PLAT");
  });

  it("does not adopt when ticketSourceLabel resolves to an integration with multiple ticket sources", async () => {
    const a = await makeAgent(store);
    await makeIntegration(store, "redmine-1", "redmine");

    const projectA = await store.createProject({ name: "A", type: "coding", agentId: a.id });
    await store.setProjectTicketSource(projectA.id, {
      integrationId: "redmine-1",
      ticketProjectKey: "PLAT",
    });
    const projectB = await store.createProject({ name: "B", type: "coding", agentId: a.id });
    await store.setProjectTicketSource(projectB.id, {
      integrationId: "redmine-1",
      ticketProjectKey: "OTHER",
    });

    const taskId = makeTaskId(randomUUID());
    await store.createTask(taskId, makeTicketId("49"), "title", "desc", "redmine:redmine-1");
    await store.transition(taskId, "CONTEXT_BUILDING");
    await store.transition(taskId, "AGENT_RUNNING");
    await store.transition(taskId, "FAILED");

    const retried = await store.retryTask(taskId);

    expect(retried.projectId).toBeNull();
    expect(retried.state).toBe("DETECTED");
  });
});
