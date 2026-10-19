/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentUserProvider } from "../../../src/admin/ui/authContext.js";
import type { ApiCostSummary, ApiModelUsageSummary, ApiOverview } from "../../../src/admin/ui/types.js";

const apiGet = vi.hoisted(() => vi.fn());

vi.mock("../../../src/admin/ui/api.js", () => ({
  api: { get: apiGet },
}));

import { OverviewView } from "../../../src/admin/ui/views/OverviewView.js";

const tokens = { input: 0, output: 0, cached: 0, cacheWrite: 0 };

const costSummary: ApiCostSummary = {
  totalUsd: 0.15,
  totalAiCredits: 15,
  totalPremiumRequests: 0,
  totalRuns: 2,
  totalTokens: tokens,
  totalRunsWithTokens: 0,
  perProject: [
    {
      projectId: "p1",
      projectName: "PLATFORM",
      workflowBucket: "done",
      usd: 0.1,
      aiCredits: 10,
      premiumRequests: 0,
      runCount: 1,
      tokens,
      runCountWithTokens: 0,
    },
    {
      projectId: "p1",
      projectName: "PLATFORM",
      workflowBucket: "failed",
      usd: 0.05,
      aiCredits: 5,
      premiumRequests: 0,
      runCount: 1,
      tokens,
      runCountWithTokens: 0,
    },
  ],
  sinceEpochSeconds: null,
};

const modelUsageSummary: ApiModelUsageSummary = {
  byModel: [
    {
      modelId: "claude-sonnet",
      workflowBucket: "done",
      runCount: 1,
      usd: 0.1,
      tokens,
      runCountWithTokens: 0,
    },
    {
      modelId: "gpt-5",
      workflowBucket: "failed",
      runCount: 1,
      usd: 0.05,
      tokens,
      runCountWithTokens: 0,
    },
  ],
  perProject: [
    {
      projectId: "p1",
      projectName: "PLATFORM",
      workflowBucket: "done",
      models: [
        {
          modelId: "claude-sonnet",
          workflowBucket: "done",
          runCount: 1,
          usd: 0.1,
          tokens,
          runCountWithTokens: 0,
        },
      ],
    },
    {
      projectId: "p1",
      projectName: "PLATFORM",
      workflowBucket: "failed",
      models: [
        {
          modelId: "gpt-5",
          workflowBucket: "failed",
          runCount: 1,
          usd: 0.05,
          tokens,
          runCountWithTokens: 0,
        },
      ],
    },
  ],
  totalRuns: 2,
  totalUsd: 0.15,
  totalTokens: tokens,
  sinceEpochSeconds: null,
};

describe("Overview outcome cost dimensions", () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiGet.mockImplementation(async (path: string) => {
      if (path.includes("cost-summary")) return costSummary;
      if (path.includes("model-usage")) return modelUsageSummary;
      throw new Error(`Unexpected API path: ${path}`);
    });
  });

  it("keeps the General View free of export actions even for admins", async () => {
    render(<CurrentUserProvider value={{ user: null, isAdmin: true, canOperate: true, can: () => true }}>
      <OverviewView overview={null} tasks={[]} providers={[]} activeIntegrationCount={0}
        pollingIntervalMs={30000} onNavigate={() => undefined} />
    </CurrentUserProvider>);
    await screen.findByText("instance total");
    expect(screen.queryByRole("button", { name: /Export/ })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  describe("Overview review vote periods", () => {
    const overview: ApiOverview = {
      stats: { activeTasks: 0, watchingTasks: 0, completedLast7d: 0, failedLast7d: 0, abandonedLast7d: 0, activeProviders: 0 },
      throughput: [],
      reviewVotes: { plus2: 7, plus1: 0, minus1: 0, minus2: 0 },
      runtime: {
        environment: "test", version: "1", uptime: "1m", dbSize: "1 KB",
        maxCycles: 1, maxRetries: 1, pollingInterval: "30s", logLevel: "error",
      },
    };

    it("maps each period to the endpoint, ignores stale responses, and shows errors", async () => {
      let resolveOld: ((votes: ApiOverview["reviewVotes"]) => void) | undefined;
      let resolveCurrent: ((votes: ApiOverview["reviewVotes"]) => void) | undefined;
      apiGet.mockReset();
      apiGet.mockImplementation((path: string) => {
        if (path.includes("cost-summary")) return Promise.resolve(costSummary);
        if (path.includes("model-usage")) return Promise.resolve(modelUsageSummary);
        if (path === "/api/admin/review-votes?days=1") {
          return new Promise<ApiOverview["reviewVotes"]>((resolve) => { resolveOld = resolve; });
        }
        if (path === "/api/admin/review-votes?days=30") {
          return new Promise<ApiOverview["reviewVotes"]>((resolve) => { resolveCurrent = resolve; });
        }
        if (path === "/api/admin/review-votes") return Promise.reject(new Error("offline"));
        throw new Error(`Unexpected API path: ${path}`);
      });
      render(<OverviewView
        overview={overview} tasks={[]} providers={[]} activeIntegrationCount={0}
        pollingIntervalMs={30000} onNavigate={() => undefined}
      />);
      const card = within(screen.getByText("Review votes").closest(".card")!);
      const plus2Count = () => card.getByText("+2").parentElement?.lastElementChild?.textContent;

      expect(plus2Count()).toBe("7");
      fireEvent.click(card.getByRole("button", { name: "24h" }));
      expect(card.getByText("Loading…")).toBeTruthy();
      fireEvent.click(card.getByRole("button", { name: "30d" }));
      await act(async () => resolveOld?.({ plus2: 100, plus1: 0, minus1: 0, minus2: 0 }));
      expect(card.getByText("Loading…")).toBeTruthy();
      await act(async () => resolveCurrent?.({ plus2: 30, plus1: 0, minus1: 0, minus2: 0 }));
      expect(plus2Count()).toBe("30");
      fireEvent.click(card.getByRole("button", { name: "All" }));
      expect(await card.findByText("Failed to load review votes.")).toBeTruthy();
      fireEvent.click(card.getByRole("button", { name: "7d" }));
      expect(plus2Count()).toBe("7");
      expect(apiGet).toHaveBeenCalledWith("/api/admin/review-votes?days=1");
      expect(apiGet).toHaveBeenCalledWith("/api/admin/review-votes?days=30");
      expect(apiGet).toHaveBeenCalledWith("/api/admin/review-votes");
      expect(apiGet).not.toHaveBeenCalledWith("/api/admin/review-votes?days=7");
    });
  });

  it("renders separate done and failed rows for the same project and model", async () => {
    render(
      <OverviewView
        overview={null}
        tasks={[]}
        providers={[]}
        activeIntegrationCount={0}
        pollingIntervalMs={30000}
        onNavigate={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTitle("claude-sonnet · Done · 1 runs")).toBeTruthy();
      expect(screen.queryByTitle("gpt-5 · Failed · 1 runs")).toBeNull();
    });

    expect(screen.getAllByText("Done")).toHaveLength(3);
    expect(screen.getAllByText("Failed")).toHaveLength(1);
  });

  it("opens the selected activity and does not mislabel unavailable totals", async () => {
    const onNavigate = vi.fn();
    render(
      <OverviewView
        overview={null}
        tasks={[{
          taskId: "active-1", taskType: "code-gen", ticketId: "T-1",
          ticketSourceLabel: "github", ticketTitle: "Target task", ticketDescription: "",
          state: "AGENT_RUNNING", gerritChangeId: null, currentPatchset: 0,
          reviewedPatchset: null, cycleCount: 0, failureReason: null,
          ticketUrl: null, reviewUrl: null, displayId: null,
          createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
        }]}
        providers={[]}
        activeIntegrationCount={null}
        canViewConfig={false}
        pollingIntervalMs={30000}
        onNavigate={onNavigate}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Target task/ }));
    expect(onNavigate).toHaveBeenCalledWith("tasks", "active-1");
    expect(screen.queryByText("0 active integrations")).toBeNull();
    expect(screen.queryByRole("button", { name: /Manage/ })).toBeNull();
    expect(screen.queryByText("Completed · 7d")?.closest(".card")?.textContent).toContain("—");
    expect(screen.queryByText("Failed · 7d")?.closest(".card")?.textContent).toContain("—");
  });

  it("does not show figures from the previous cost or model period", async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === "/api/admin/cost-summary?days=1" || path === "/api/admin/model-usage?days=1") {
        return new Promise(() => undefined);
      }
      if (path.includes("cost-summary")) return Promise.resolve(costSummary);
      if (path.includes("model-usage")) return Promise.resolve(modelUsageSummary);
      throw new Error(`Unexpected path: ${path}`);
    });
    render(
      <OverviewView
        overview={null} tasks={[]} providers={[]} activeIntegrationCount={0}
        pollingIntervalMs={30000} onNavigate={() => undefined}
      />,
    );
    const costCard = within(screen.getByText("AI cost").closest(".card")!);
    const modelCard = within(screen.getByText("Model usage").closest(".card")!);
    await waitFor(() => expect(costCard.getByText("instance total")).toBeTruthy());
    await waitFor(() => expect(modelCard.getByTitle("claude-sonnet · Done · 1 runs")).toBeTruthy());

    fireEvent.click(costCard.getByRole("button", { name: "24h" }));
    fireEvent.click(modelCard.getByRole("button", { name: "24h" }));

    expect(costCard.getByText("Loading…")).toBeTruthy();
    expect(modelCard.getByText("Loading…")).toBeTruthy();
    expect(costCard.queryByText("instance total")).toBeNull();
    expect(modelCard.queryByTitle("claude-sonnet · Done · 1 runs")).toBeNull();
  });

  describe("Overview failure surfaces", () => {
    it("excludes abandoned tasks from the failed stat and opens failed tasks on click", async () => {
      const onOpenFailedTasks = vi.fn();
      const overview: ApiOverview = {
        stats: { activeTasks: 0, watchingTasks: 0, completedLast7d: 0, failedLast7d: 2, abandonedLast7d: 3, activeProviders: 0 },
        throughput: [],
        reviewVotes: { plus2: 0, plus1: 0, minus1: 0, minus2: 0 },
        runtime: { environment: "test", version: "1", uptime: "1m", dbSize: "1 KB", maxCycles: 1, maxRetries: 1, pollingInterval: "30s", logLevel: "error" },
      };
      render(<OverviewView overview={overview} tasks={[]} providers={[]} activeIntegrationCount={0}
        pollingIntervalMs={30000} onNavigate={() => undefined} onOpenFailedTasks={onOpenFailedTasks} />);
      await screen.findByText("instance total");
      const stat = screen.getByRole("button", { name: /Failed/ });
      expect(stat.textContent).toContain("excl. 3 abandoned");
      fireEvent.keyDown(stat, { key: "Enter" });
      fireEvent.click(stat);
      expect(onOpenFailedTasks).toHaveBeenCalledTimes(2);
    });
  });
});
