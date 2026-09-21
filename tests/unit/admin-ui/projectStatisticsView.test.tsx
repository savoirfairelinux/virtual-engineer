/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../../src/admin/ui/api.js";
import { CurrentUserProvider, makeCan } from "../../../src/admin/ui/authContext.js";
import { ConfigPageSurface } from "../../../src/admin/ui/views/ConfigView/ConfigPageSurface.js";
import { ProjectStatisticsView } from "../../../src/admin/ui/views/ConfigView/ProjectStatisticsView.js";
import type { ApiMe, ApiProject, ApiProjectStatistics } from "../../../src/admin/ui/types.js";

const admin: ApiMe = {
  id: "admin-1",
  username: "admin",
  role: "admin",
  capabilities: { superuser: true, grants: {} },
};

const project: ApiProject = {
  id: "project-1",
  name: "Payments automation",
  type: "coding",
  enabled: true,
  agentId: "agent-1",
  ownerUserId: "admin-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const statistics: ApiProjectStatistics = {
  projectId: project.id,
  sinceEpochSeconds: 1_700_000_000,
  current: {
    taskCount: 4,
    byState: {
      DETECTED: 1,
      CONTEXT_BUILDING: 0,
      AGENT_RUNNING: 1,
      IN_REVIEW: 0,
      FEEDBACK_PROCESSING: 0,
      RETRY_CYCLE: 0,
      MERGED: 0,
      CLOSING: 0,
      DONE: 2,
      FAILED: 0,
      ABANDONED: 0,
      REVIEW_PENDING: 0,
      REVIEW_RUNNING: 0,
      REVIEW_COMMENTING: 0,
      REVIEW_WATCHING: 0,
      REVIEW_DONE: 0,
      REVIEW_FAILED: 0,
    },
    byBucket: { active: 2, watching: 0, done: 2, failed: 0 },
  },
  period: {
    tasksCreated: 3,
    terminalTasks: 2,
    terminalByState: {
      DETECTED: 0,
      CONTEXT_BUILDING: 0,
      AGENT_RUNNING: 0,
      IN_REVIEW: 0,
      FEEDBACK_PROCESSING: 0,
      RETRY_CYCLE: 0,
      MERGED: 0,
      CLOSING: 0,
      DONE: 2,
      FAILED: 0,
      ABANDONED: 0,
      REVIEW_PENDING: 0,
      REVIEW_RUNNING: 0,
      REVIEW_COMMENTING: 0,
      REVIEW_WATCHING: 0,
      REVIEW_DONE: 0,
      REVIEW_FAILED: 0,
    },
    terminalByBucket: { active: 0, watching: 0, done: 2, failed: 0 },
  },
  execution: {
    cycles: 5,
    tasksWithCycles: 3,
    retryTasks: 1,
    averageCyclesPerTask: 1.67,
    validation: { samples: 4, passed: 3, failed: 1, skipped: 0 },
  },
  cost: {
    totalUsd: 0.42,
    totalAiCredits: 42,
    totalPremiumRequests: 3,
    totalRuns: 5,
    totalTokens: { input: 1000, output: 400, cached: 200, cacheWrite: 50 },
    totalRunsWithTokens: 5,
    byBucket: [{ workflowBucket: "done", usd: 0.42, aiCredits: 42, premiumRequests: 3, runCount: 5, tokens: { input: 1000, output: 400, cached: 200, cacheWrite: 50 }, runCountWithTokens: 5 }],
  },
  models: [{ modelId: "gpt-5", workflowBucket: "done", runCount: 5, usd: 0.42, tokens: { input: 1000, output: 400, cached: 200, cacheWrite: 50 }, runCountWithTokens: 5 }],
  timing: { samples: 2, averageSeconds: 180, medianSeconds: 150 },
  liveConcurrency: { active: 1 },
};

function renderView() {
  return render(
    <CurrentUserProvider value={{ user: admin, isAdmin: true, canOperate: true, can: makeCan(admin) }}>
      <ConfigPageSurface>
        <ProjectStatisticsView project={project} onBack={vi.fn()} />
      </ConfigPageSurface>
    </CurrentUserProvider>,
  );
}

describe("ProjectStatisticsView", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads on opening, shows project metrics, and changes period on demand", async () => {
    const get = vi.spyOn(api, "get").mockResolvedValue(statistics);
    renderView();

    expect(get).toHaveBeenCalledWith("/api/admin/projects/project-1/statistics?days=30");
    await screen.findByText("Payments automation");
    expect(screen.getByText("4", { selector: ".project-stat-value" })).toBeDefined();
    expect(screen.getByText("$0.42", { selector: ".project-stat-value" })).toBeDefined();
    expect(screen.getByText("1 live")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "All time" }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith("/api/admin/projects/project-1/statistics"));
  });

  it("renders a clear error when the project statistics request fails", async () => {
    vi.spyOn(api, "get").mockRejectedValue(new Error("Forbidden"));
    renderView();

    expect(await screen.findByText("Failed to load project statistics.")).toBeDefined();
    expect(screen.getByText("Forbidden")).toBeDefined();
  });

  it("keeps empty periods and unmeasured values distinct from live zeroes", async () => {
    const emptyPeriod: ApiProjectStatistics = {
      ...statistics,
      period: {
        ...statistics.period,
        tasksCreated: 0,
        terminalTasks: 0,
        terminalByBucket: { active: 0, watching: 0, done: 0, failed: 0 },
      },
      execution: {
        ...statistics.execution,
        cycles: 0,
        tasksWithCycles: 0,
        retryTasks: 0,
        averageCyclesPerTask: null,
        validation: { samples: 0, passed: 0, failed: 0, skipped: 0 },
      },
      cost: {
        ...statistics.cost,
        totalRuns: 0,
        totalRunsWithTokens: 0,
        totalTokens: { input: 0, output: 0, cached: 0, cacheWrite: 0 },
        byBucket: [],
      },
      models: [],
      timing: { samples: 0, averageSeconds: null, medianSeconds: null },
      liveConcurrency: null,
    };
    vi.spyOn(api, "get").mockResolvedValue(emptyPeriod);
    renderView();

    expect(await screen.findByText("No activity in this period")).toBeDefined();
    expect(screen.getByText("No token usage reported")).toBeDefined();
    expect(screen.getByText("unavailable")).toBeDefined();
    expect(screen.getAllByText("—").length).toBeGreaterThan(1);
  });
});
