/** @vitest-environment jsdom */
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiCostSummary, ApiModelUsageSummary } from "../../../src/admin/ui/types.js";

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
      modelId: "claude-sonnet",
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
          modelId: "claude-sonnet",
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
      expect(screen.getByTitle("claude-sonnet · Failed · 1 runs")).toBeTruthy();
    });

    expect(screen.getAllByText("Done")).toHaveLength(3);
    expect(screen.getAllByText("Failed")).toHaveLength(3);
  });
});
