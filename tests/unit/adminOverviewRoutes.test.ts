import { describe, it, expect, afterEach, vi } from "vitest";
import type { Server } from "node:http";
import { createAdminServer, type AdminServerDependencies } from "../../src/admin/adminServer.js";
import { makeTaskId, makeTicketId } from "../../src/interfaces.js";
import type { AgentCycle, Task, TaskState } from "../../src/interfaces.js";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { tempDatabasePath } from "./helpers/tempDatabase.js";

async function rest(server: Server | null, path: string): Promise<{ status: number; body: Record<string, unknown> | null }> {
  if (!server) throw new Error("Server not started");
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Server not bound");
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`);
  const text = await res.text();
  let parsed: Record<string, unknown> | null = null;
  if (text) {
    try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* leave null */ }
  }
  return { status: res.status, body: parsed };
}

const NOW = Date.now();

function makeTask(id: string, state: TaskState, updatedAt: Date): Task {
  return {
    taskId: makeTaskId(id),
    ticketId: makeTicketId(`ticket-${id}`),
    ticketSourceLabel: "redmine",
    ticketTitle: `Task ${id}`,
    ticketDescription: "",
    state,
    taskType: state.startsWith("REVIEW_") ? "code-review" : "code-gen",
    externalChangeId: null,
    currentPatchset: 0,
    reviewedPatchset: null,
    cycleCount: 0,
    createdAt: updatedAt,
    updatedAt,
    failureReason: null,
    ticketUrl: null,
    reviewUrl: null,
    displayId: null,
  };
}

function makeDeps(tasks: Task[]): AdminServerDependencies {
  return {
    stateStore: {
      getActiveTasks: vi.fn(async () => []),
      getAllTasks: vi.fn(async () => tasks),
      getTask: vi.fn(async () => null),
      getAgentCycles: vi.fn(async () => []),
      getAgentCycleEvents: vi.fn(async () => []),
      getStateTransitions: vi.fn(async () => []),
      pauseTask: vi.fn(async () => { throw new Error("not impl"); }),
      resumeTask: vi.fn(async () => { throw new Error("not impl"); }),
      retryTask: vi.fn(async () => { throw new Error("not impl"); }),
      abandonTask: vi.fn(async () => { throw new Error("not impl"); }),
      deleteTask: vi.fn(async () => {}),
      getChangesForTask: vi.fn(async () => []),
      getChangesForTasks: vi.fn(async () => []),
      deleteTaskGroup: vi.fn(async () => {}),
      getCostSummary: vi.fn(async () => ({ totalUsd: 0, totalAiCredits: 0, totalPremiumRequests: 0, totalRuns: 0, totalTokens: { input: 0, output: 0, cached: 0, cacheWrite: 0 }, totalRunsWithTokens: 0, perProject: [], sinceEpochSeconds: null })),
      getModelUsageSummary: vi.fn(async () => ({ byModel: [], perProject: [], totalRuns: 0, totalUsd: 0, totalTokens: { input: 0, output: 0, cached: 0, cacheWrite: 0 }, sinceEpochSeconds: null })),
    },
    allowUnauthenticatedAdmin: true,
    config: {
      nodeEnv: "test",
      logLevel: "error",
      maxAgentCycles: 3,
      maxRetryAttempts: 5,
      pollingIntervalMs: 30000,
      agentTimeoutMs: 3600000,
    },
    polling: { isRunning: () => false, getIntervals: () => ({ intervalMs: 30000 }) },
    providers: [],
  };
}

describe("Admin API — Overview route stats bucketing", () => {
  let server: Server | null = null;

  async function start(tasks: Task[]): Promise<void> {
    server = createAdminServer(makeDeps(tasks));
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  }

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server?.close((err) => err ? reject(err) : resolve()));
      server = null;
    }
  });

  it("counts a DETECTED task as active (previously fell into no bucket)", async () => {
    await start([makeTask("t1", "DETECTED", new Date(NOW))]);
    const r = await rest(server, "/api/admin/overview");
    expect(r.status).toBe(200);
    expect((r.body?.["stats"] as Record<string, unknown>)["activeTasks"]).toBe(1);
  });

  it("counts a recently-updated ABANDONED task as abandoned, not as a failure needing attention", async () => {
    await start([makeTask("t1", "ABANDONED", new Date(NOW))]);
    const r = await rest(server, "/api/admin/overview");
    expect(r.status).toBe(200);
    const stats = r.body?.["stats"] as Record<string, unknown>;
    expect(stats["failedLast7d"]).toBe(0);
    expect(stats["abandonedLast7d"]).toBe(1);
  });

  it("buckets one representative state per remaining category", async () => {
    await start([
      makeTask("gen", "AGENT_RUNNING", new Date(NOW)),
      makeTask("watch", "IN_REVIEW", new Date(NOW)),
      makeTask("done", "MERGED", new Date(NOW)),
      makeTask("fail", "FAILED", new Date(NOW)),
    ]);
    const r = await rest(server, "/api/admin/overview");
    expect(r.status).toBe(200);
    const stats = r.body?.["stats"] as Record<string, unknown>;
    expect(stats["activeTasks"]).toBe(1);
    expect(stats["watchingTasks"]).toBe(1);
    expect(stats["completedLast7d"]).toBe(1);
    expect(stats["failedLast7d"]).toBe(1);
  });

  it("splits active work into running and queued, counting a pending review as queued rather than watching", async () => {
    await start([
      makeTask("gen", "AGENT_RUNNING", new Date(NOW)),
      makeTask("detected", "DETECTED", new Date(NOW)),
      makeTask("pending-review", "REVIEW_PENDING", new Date(NOW)),
      makeTask("watch", "REVIEW_WATCHING", new Date(NOW)),
    ]);
    const stats = (await rest(server, "/api/admin/overview")).body?.["stats"] as Record<string, unknown>;
    expect(stats).toMatchObject({ activeTasks: 3, runningTasks: 1, queuedTasks: 2, watchingTasks: 1 });
  });

  it("excludes done/failed tasks updated more than 7 days ago from the 7-day counters", async () => {
    const eightDaysAgo = new Date(NOW - 8 * 24 * 60 * 60 * 1000);
    await start([
      makeTask("old-done", "DONE", eightDaysAgo),
      makeTask("old-fail", "FAILED", eightDaysAgo),
    ]);
    const r = await rest(server, "/api/admin/overview");
    expect(r.status).toBe(200);
    const stats = r.body?.["stats"] as Record<string, unknown>;
    expect(stats["completedLast7d"]).toBe(0);
    expect(stats["failedLast7d"]).toBe(0);
  });

  it("does not count a failed attempt superseded by a newer task for the same ticket", async () => {
    const failed = { ...makeTask("old-attempt", "FAILED", new Date(NOW - 60_000)), ticketId: makeTicketId("shared") };
    const retried = { ...makeTask("new-attempt", "DONE", new Date(NOW)), ticketId: makeTicketId("shared") };
    await start([failed, retried]);
    const stats = (await rest(server, "/api/admin/overview")).body?.["stats"] as Record<string, unknown>;
    expect(stats["failedLast7d"]).toBe(0);
    expect(stats["completedLast7d"]).toBe(1);
  });

  it("windows outcomes by when the task entered its terminal state, not by later updated_at bumps", async () => {
    const eightDaysAgo = new Date(NOW - 8 * 24 * 60 * 60 * 1000);
    const deps = makeDeps([makeTask("old-fail", "FAILED", new Date(NOW))]);
    deps.stateStore.getCurrentStateEnteredAt = vi.fn(async () => new Map([[makeTaskId("old-fail"), eightDaysAgo]]));
    server = createAdminServer(deps);
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const stats = (await rest(server, "/api/admin/overview")).body?.["stats"] as Record<string, unknown>;
    expect(stats["failedLast7d"]).toBe(0);
  });
});

describe("Admin API — Review votes period filter", () => {
  let server: Server | null = null;
  const DAY = 24 * 60 * 60 * 1000;

  function cycle(taskId: string, score: number, createdAt: Date): AgentCycle {
    return {
      id: 1,
      taskId: makeTaskId(taskId),
      cycleNumber: 1,
      result: { metadata: { score } } as unknown as AgentCycle["result"],
      validationResult: null,
      createdAt,
    };
  }

  async function start(): Promise<void> {
    const tasks = [
      makeTask("r-today", "REVIEW_DONE", new Date(NOW - 60 * 60 * 1000)),
      makeTask("r-3d", "REVIEW_DONE", new Date(NOW - 3 * DAY)),
      makeTask("r-20d", "REVIEW_DONE", new Date(NOW - 20 * DAY)),
      makeTask("r-90d", "REVIEW_DONE", new Date(NOW - 90 * DAY)),
    ];
    const cycles: Record<string, AgentCycle[]> = {
      "r-today": [cycle("r-today", 2, new Date(NOW - 60 * 60 * 1000))],
      "r-3d": [cycle("r-3d", 1, new Date(NOW - 3 * DAY))],
      "r-20d": [cycle("r-20d", -1, new Date(NOW - 20 * DAY))],
      "r-90d": [cycle("r-90d", -2, new Date(NOW - 90 * DAY))],
    };
    const deps = makeDeps(tasks);
    deps.stateStore.getAgentCycles = vi.fn(async (id) => cycles[id] ?? []);
    server = createAdminServer(deps);
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  }

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server?.close((err) => err ? reject(err) : resolve()));
      server = null;
    }
  });

  it.each([
    ["?days=1", { plus2: 1, plus1: 0, minus1: 0, minus2: 0 }],
    ["?days=7", { plus2: 1, plus1: 1, minus1: 0, minus2: 0 }],
    ["?days=30", { plus2: 1, plus1: 1, minus1: 1, minus2: 0 }],
    ["", { plus2: 1, plus1: 1, minus1: 1, minus2: 1 }],
  ])("counts votes within %s", async (query, expected) => {
    await start();
    const r = await rest(server, `/api/admin/review-votes${query}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual(expected);
  });

  it("uses the aggregate store for readable review tasks instead of loading each cycle", async () => {
    const tasks = [
      makeTask("review", "REVIEW_DONE", new Date(NOW)),
      makeTask("coding", "DONE", new Date(NOW)),
    ];
    const deps = makeDeps(tasks);
    const aggregate = vi.fn(async () => ({ plus2: 2, plus1: 0, minus1: 0, minus2: 0 }));
    deps.stateStore.getReviewVoteCounts = aggregate;
    server = createAdminServer(deps);
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const r = await rest(server, "/api/admin/review-votes?days=1");
    expect(r.body).toEqual({ plus2: 2, plus1: 0, minus1: 0, minus2: 0 });
    expect(aggregate).toHaveBeenCalledWith([makeTaskId("review")], expect.any(Date));
    expect(deps.stateStore.getAgentCycles).not.toHaveBeenCalled();
  });
});

describe("Admin API - General View CSV export", () => {
  let server: Server | null = null;
  let store: SqliteStateStore | null = null;

  function metricRow(csv: string, section: string, scope: string, metric: string): string | undefined {
    return csv.split("\r\n").find((row) => row.startsWith(`"${section}","${scope}",`) && row.includes(`,"${metric}",`));
  }

  async function start(deps: AdminServerDependencies): Promise<string> {
    server = createAdminServer(deps);
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Server not bound");
    return `http://127.0.0.1:${address.port}/api/admin/overview/export.csv`;
  }

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
      server = null;
    }
    store?.close();
    store = null;
    vi.restoreAllMocks();
  });

  it("downloads an empty report with snapshot and period rows, but no runtime or provider data", async () => {
    const url = await start(makeDeps([]));
    const response = await fetch(`${url}?days=7`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="general-view-analytics-7d.csv"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    const csv = await response.text();
    expect(csv.startsWith('"section","scope","period","generated_at_utc","window_start_utc","window_end_utc"')).toBe(true);
    expect(csv).toContain('"task_summary","instance","current"');
    expect(csv).toContain('"review_votes","instance","7d"');
    expect(csv).toContain('"ai_cost","instance","7d"');
    expect(csv).toContain('"model_usage","instance","7d"');
    expect(csv.split("\r\n").filter((row) => row.startsWith('"throughput","bin"'))).toHaveLength(14);
    expect(csv).not.toContain('"runtime"');
    expect(csv).not.toContain('"providers"');
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it.each([1, 7, 30, null])("uses one reference timestamp for period %s", async (days) => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const deps = makeDeps([makeTask("review", "REVIEW_DONE", new Date(NOW))]);
    const votes = vi.fn(async () => ({ plus2: 1, plus1: 0, minus1: 0, minus2: 0 }));
    deps.stateStore.getReviewVoteCounts = votes;
    const url = await start(deps);
    const response = await fetch(days === null ? url : `${url}?days=${days}`);
    expect(response.status).toBe(200);
    const since = days === null ? undefined : new Date(NOW - days * 86_400_000);
    expect(deps.stateStore.getCostSummary).toHaveBeenCalledWith(since ? { since } : undefined);
    expect(deps.stateStore.getModelUsageSummary).toHaveBeenCalledWith(since ? { since } : undefined);
    expect(votes).toHaveBeenCalledWith([makeTaskId("review")], since);
    expect(await response.text()).toContain(new Date(NOW).toISOString());
  });

  it.each(["", "0", "-1", "2", "1.5", "NaN", "Infinity", "all", "7&days=30"])("rejects invalid days=%s before reading analytics", async (days) => {
    const deps = makeDeps([]);
    const url = await start(deps);
    const response = await fetch(`${url}?days=${days}`);
    expect(response.status).toBe(400);
    expect(deps.stateStore.getAllTasks).not.toHaveBeenCalled();
    expect(deps.stateStore.getCostSummary).not.toHaveBeenCalled();
  });

  it.each([
    "from=2026-10-01", "to=2026-10-02", "from=2026-02-30&to=2026-03-01",
    "from=2026-10-03&to=2026-10-01", "days=7&from=2026-10-01&to=2026-10-02",
    "from=2026-10-01&from=2026-10-02&to=2026-10-03", "projectId=",
  ])("rejects invalid export filters %s before analytics reads", async (query) => {
    const deps = makeDeps([]);
    const url = await start(deps);
    expect((await fetch(`${url}?${query}`)).status).toBe(400);
    expect(deps.stateStore.getCostSummary).not.toHaveBeenCalled();
  });

  it("applies custom dates and selected projects to all export sections", async () => {
    store = await SqliteStateStore.create(tempDatabasePath("ve-export-filters"));
    const agent = await store.createAgent({ name: "Filters", type: "coding", modelConfigJson: "{}",
      systemPromptId: "system_generic_code", instructionsPromptId: "instructions_generic_code", enabled: true });
    const projects = await Promise.all(["Selected", "Also selected", "Excluded"].map((name) =>
      store!.createProject({ name, type: "coding", agentId: agent.id })));
    const [selected, alsoSelected, excluded] = projects;
    if (!selected || !alsoSelected || !excluded) throw new Error("Missing fixture projects");
    const since = new Date("2026-10-01T00:00:00Z");
    const before = new Date("2026-10-03T00:00:00Z");
    const deps = makeDeps([
      { ...makeTask("active", "AGENT_RUNNING", new Date("2026-01-01Z")), projectId: selected.id },
      { ...makeTask("at-start", "DONE", since), projectId: selected.id },
      { ...makeTask("at-end", "DONE", before), projectId: selected.id },
      { ...makeTask("review", "REVIEW_DONE", new Date("2026-10-05Z")), projectId: alsoSelected.id },
      { ...makeTask("hidden", "DONE", since), projectId: excluded.id },
    ]);
    deps.projectStore = store;
    const aggregate = vi.fn(async () => ({ plus2: 1, plus1: 0, minus1: 0, minus2: 0 }));
    deps.stateStore.getReviewVoteCounts = aggregate;
    const url = await start(deps);
    const response = await fetch(`${url}?from=2026-10-01&to=2026-10-02&projectId=${selected.id}&projectId=${alsoSelected.id}`);
    expect(response.status).toBe(200);
    expect(deps.stateStore.getCostSummary).toHaveBeenCalledWith({ since, before, projectIds: [selected.id, alsoSelected.id] });
    expect(deps.stateStore.getModelUsageSummary).toHaveBeenCalledWith({ since, before, projectIds: [selected.id, alsoSelected.id] });
    expect(aggregate).toHaveBeenCalledWith([makeTaskId("review")], since, { before, inclusiveSince: true });
    const csv = await response.text();
    expect(metricRow(csv, "task_summary", "selected_projects", "completed")).toContain(',"1","tasks",""');
    expect(metricRow(csv, "task_summary", "selected_projects", "active")).toContain(',"1","tasks",""');
    expect(metricRow(csv, "task_distribution", "selected_projects", "total")).toContain(',"4","tasks",""');
    expect(metricRow(csv, "throughput", "selected_projects", "updated_tasks")).toContain(',"1","tasks",""');
    expect(csv).toContain('"custom"');
    expect(csv).toContain('"2026-10-01T00:00:00.000Z","2026-10-03T00:00:00.000Z"');
    expect(response.headers.get("content-disposition")).toContain("2026-10-01_2026-10-02.csv");
    expect((await fetch(`${url}?projectId=unknown`)).status).toBe(400);
  });

  it("returns JSON rather than a partial attachment if an aggregate fails", async () => {
    const deps = makeDeps([]);
    vi.mocked(deps.stateStore.getCostSummary).mockRejectedValue(new Error("database unavailable"));
    const url = await start(deps);
    const response = await fetch(url);
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.has("content-disposition")).toBe(false);
    expect(await response.json()).toEqual({ error: "Failed to export analytics" });
  });

  it.each([1, 7, 30, null])("counts updated tasks over period %s and keeps workload current", async (days) => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const cutoff = NOW - (days ?? 100) * 86_400_000;
    const deps = makeDeps([
      makeTask("old-active", "AGENT_RUNNING", new Date(cutoff - 1)),
      makeTask("old-watching", "REVIEW_WATCHING", new Date(cutoff - 1)),
      makeTask("before", "DONE", new Date(cutoff - 1)),
      makeTask("boundary", "MERGED", new Date(cutoff)),
      makeTask("after", "REVIEW_DONE", new Date(cutoff + 1)),
      makeTask("now", "ABANDONED", new Date(NOW)),
      makeTask("future", "FAILED", new Date(NOW + 1)),
    ]);
    const url = await start(deps);
    const response = await fetch(days === null ? url : `${url}?days=${days}`);
    expect(response.status).toBe(200);
    const csv = await response.text();
    expect(metricRow(csv, "task_summary", "instance", "active")).toContain(',"1","tasks",""');
    expect(metricRow(csv, "task_summary", "instance", "watching")).toContain(',"1","tasks",""');
    expect(metricRow(csv, "task_summary", "instance", "completed")).toContain(`,"${days === null ? 3 : 1}","tasks",""`);
    expect(metricRow(csv, "task_summary", "instance", "failed")).toContain(',"0","tasks",""');
    expect(metricRow(csv, "task_summary", "instance", "abandoned")).toContain(',"1","tasks",""');
    expect(metricRow(csv, "task_distribution", "category", "abandoned")).toContain(',"1","tasks",""');
    const bins = csv.split("\r\n").filter((row) => row.startsWith('"throughput","bin",'));
    expect(bins).toHaveLength(14);
    const total = bins.reduce((count, row) => count + Number(row.split('","').at(-3)), 0);
    expect(total).toBe(days === null ? 6 : 3);
    expect(metricRow(csv, "throughput", "instance", "updated_tasks")).toContain(`,"${total}","tasks",""`);
    if (days !== null) {
      expect(bins[0]).toContain(new Date(cutoff).toISOString());
      expect(bins.at(-1)).toContain(new Date(NOW).toISOString());
    }
  });

  it("assigns exact exported millisecond boundaries to the following throughput bin", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const startTime = NOW - 86_400_000;
    const tasks = Array.from({ length: 15 }, (_value, index) =>
      makeTask(`edge-${index}`, "DONE", new Date(startTime + Math.floor(index * 86_400_000 / 14))));
    const url = await start(makeDeps(tasks));
    const csv = await (await fetch(`${url}?days=1`)).text();
    const bins = csv.split("\r\n").filter((row) => row.startsWith('"throughput","bin",'));
    expect(bins.map((row) => Number(row.split('\",\"').at(-3)))).toEqual([
      1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2,
    ]);
  });

  it("handles empty all-time throughput and all tasks updated at the same instant", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const deps = makeDeps([]);
    const url = await start(deps);
    const empty = await (await fetch(url)).text();
    expect(empty).not.toContain('"throughput","bin"');
    vi.mocked(deps.stateStore.getAllTasks).mockResolvedValue([makeTask("instant", "DONE", new Date(NOW))]);
    const instant = await (await fetch(url)).text();
    expect(instant.split("\r\n").filter((row) => row.startsWith('"throughput","bin"'))).toHaveLength(14);
    expect(metricRow(instant, "throughput", "instance", "updated_tasks")).toContain(',"1","tasks",""');
  });

  it("exports raw costs and token coverage while excluding failed models from model totals", async () => {
    const deps = makeDeps([]);
    const tokens = { input: 10, output: 20, cached: 30, cacheWrite: 40 };
    const zeroTokens = { input: 0, output: 0, cached: 0, cacheWrite: 0 };
    const failed = { modelId: "discarded", workflowBucket: "failed" as const, runCount: 9, usd: 2, tokens, runCountWithTokens: 9 };
    const measured = { modelId: "model-a", workflowBucket: "done" as const, runCount: 2, usd: 0.123456789, tokens, runCountWithTokens: 1 };
    const unreported = { modelId: null, workflowBucket: "active" as const, runCount: 1, usd: 0, tokens: zeroTokens, runCountWithTokens: 0 };
    vi.mocked(deps.stateStore.getCostSummary).mockResolvedValue({
      totalUsd: 2.123456789, totalAiCredits: 10, totalPremiumRequests: 4, totalRuns: 12,
      totalTokens: tokens, totalRunsWithTokens: 10, sinceEpochSeconds: null,
      perProject: [{ projectId: null, projectName: null, workflowBucket: "failed", usd: 2,
        aiCredits: 10, premiumRequests: 4, runCount: 9, tokens, runCountWithTokens: 9 }],
    });
    vi.mocked(deps.stateStore.getModelUsageSummary).mockResolvedValue({
      byModel: [failed, measured, unreported],
      perProject: [
        { projectId: "gone", projectName: "Discarded project", workflowBucket: "failed", models: [failed] },
        { projectId: null, projectName: null, workflowBucket: "done", models: [measured] },
      ],
      totalRuns: 12, totalUsd: 2.123456789, totalTokens: tokens, sinceEpochSeconds: null,
    });
    const url = await start(deps);
    const csv = await (await fetch(url)).text();
    expect(metricRow(csv, "ai_cost", "instance", "usd")).toContain(',"2.123456789","USD",""');
    expect(metricRow(csv, "ai_cost", "project", "usd")).toContain(',"failed","","usd","2"');
    expect(metricRow(csv, "model_usage", "instance", "runs")).toContain(',"3","count",""');
    expect(metricRow(csv, "model_usage", "instance", "usd")).toContain(',"0.123456789","USD",""');
    expect(metricRow(csv, "model_usage", "model", "processed_tokens")).toContain(',"100","tokens","partial"');
    expect(csv).toContain(',"active","","input_tokens","","tokens","unreported"');
    expect(csv).not.toContain("discarded");
    expect(csv).not.toContain("Discarded project");
    expect(csv).toContain('"project_model"');
    expect(csv).toContain('"run_percentage","66.66666666666666","percent"');
  });

  it.each(["=SUM(A1)", " +cmd", "\t-cmd", "@cmd", 'Café, "quoted"\nteam'])("quotes and neutralizes project names: %s", async (projectName) => {
    const deps = makeDeps([]);
    const summary = await deps.stateStore.getCostSummary();
    vi.mocked(deps.stateStore.getCostSummary).mockResolvedValue({ ...summary, perProject: [{
      projectId: "project", projectName, workflowBucket: "done", usd: 0, aiCredits: 0,
      premiumRequests: 0, runCount: 1, tokens: summary.totalTokens, runCountWithTokens: 1,
    }] });
    const url = await start(deps);
    const csv = await (await fetch(url)).text();
    const safeName = /^[\s]*[=+\-@]/.test(projectName) ? `'${projectName}` : projectName;
    expect(csv).toContain(`"project","${safeName.replaceAll('"', '""')}"`);
    expect(metricRow(csv, "ai_cost", "project", "input_tokens")).toContain(',"0","tokens","reported"');
  });

  it.each(["operator", "viewer"])("denies %s with explicit and group grants before reading analytics", async (role) => {
    store = await SqliteStateStore.create(tempDatabasePath("ve-overview-export-auth"));
    const deps = makeDeps([]);
    deps.stateStore = store;
    deps.allowUnauthenticatedAdmin = false;
    const url = await start(deps);
    const origin = new URL(url).origin;
    const setup = await fetch(`${origin}/api/admin/auth/setup`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "Str0ng-Pass-1x" }),
    });
    expect(setup.status).toBe(201);
    const admin = await setup.json() as { token: string };
    const created = await fetch(`${origin}/api/admin/users`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({ username: "export-user", password: "Str0ng-Pass-1x", role }),
    });
    expect(created.status).toBe(201);
    const login = await fetch(`${origin}/api/admin/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "export-user", password: "Str0ng-Pass-1x" }),
    });
    expect(login.status).toBe(200);
    const user = await login.json() as { token: string; user: { id: string } };
    const policy = await store.createPolicy({ name: "Export readers" });
    await store.setPolicyRules(policy.id, [{ permission: "overview.read", resourceId: null }]);
    await store.createBinding({ policyId: policy.id, principalType: "user", principalId: user.user.id });
    const group = await store.createGroup({ name: "Export group" });
    await store.addUserToGroup(group.id, user.user.id);
    await store.createBinding({ policyId: policy.id, principalType: "group", principalId: group.id });
    const taskRead = vi.spyOn(store, "getAllTasks");
    const costRead = vi.spyOn(store, "getCostSummary");
    const modelRead = vi.spyOn(store, "getModelUsageSummary");
    expect((await fetch(url)).status).toBe(401);
    const denied = await fetch(url, { headers: { authorization: `Bearer ${user.token}` } });
    expect(denied.status).toBe(403);
    expect(taskRead).not.toHaveBeenCalled();
    expect(costRead).not.toHaveBeenCalled();
    expect(modelRead).not.toHaveBeenCalled();
    const allowed = await fetch(url, { headers: { authorization: `Bearer ${admin.token}` } });
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toContain('"ai_cost"');
  });

  it("denies export before first-user setup", async () => {
    store = await SqliteStateStore.create(tempDatabasePath("ve-overview-export-bootstrap"));
    const deps = makeDeps([]);
    deps.stateStore = store;
    deps.allowUnauthenticatedAdmin = false;
    deps.config.nodeEnv = "production";
    const url = await start(deps);
    const reads = vi.spyOn(store, "getAllTasks");
    expect((await fetch(url)).status).toBe(401);
    expect(reads).not.toHaveBeenCalled();
  });
});
