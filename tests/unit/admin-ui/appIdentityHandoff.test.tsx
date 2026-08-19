/** @vitest-environment jsdom */
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiMe } from "../../../src/admin/ui/types.js";

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  getMe: vi.fn(),
}));

vi.mock("../../../src/admin/ui/api.js", () => ({
  ApiError: class ApiError extends Error {
    constructor(public readonly status: number, message: string) {
      super(message);
    }
  },
  api: { get: apiMocks.get },
  clearStoredToken: vi.fn(),
  connectSse: vi.fn(() => vi.fn()),
  fetchSetupStatus: vi.fn(async () => ({ needsSetup: false })),
  getMe: apiMocks.getMe,
  getStoredToken: vi.fn(() => "session-token"),
  logout: vi.fn(async () => undefined),
  onUnauthorized: vi.fn(),
}));

vi.mock("../../../src/admin/ui/shell/TopBar.js", () => ({
  TopBar: ({ taskCount, user }: { taskCount: number; user: ApiMe | null }) => (
    <div data-testid="app-state" data-user={user?.username ?? "loading"}>
      {taskCount}
    </div>
  ),
}));
vi.mock("../../../src/admin/ui/shell/AuthScreen.js", () => ({ AuthScreen: () => null }));
vi.mock("../../../src/admin/ui/shell/ChangePasswordModal.js", () => ({ ChangePasswordModal: () => null }));
vi.mock("../../../src/admin/ui/views/OverviewView.js", () => ({ OverviewView: () => null }));
vi.mock("../../../src/admin/ui/views/TasksView/index.js", () => ({ TasksView: () => null }));
vi.mock("../../../src/admin/ui/views/ConfigView/index.js", () => ({ ConfigView: () => null }));

import { App, shouldEnableConfigWorkflow } from "../../../src/admin/ui/App.js";

describe("App identity loading", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path === "/api/admin/tasks") {
        return {
          tasks: [{
            taskId: "task-1",
            taskType: "code-gen",
            ticketId: "T-1",
            ticketSourceLabel: "github:test",
            ticketTitle: "Visible task",
            ticketDescription: "",
            state: "DETECTED",
            gerritChangeId: null,
            currentPatchset: 0,
            reviewedPatchset: null,
            cycleCount: 0,
            failureReason: null,
            ticketUrl: null,
            reviewUrl: null,
            displayId: "T-1",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }],
        };
      }
      if (path === "/api/admin/status") return { polling: { running: true, intervalMs: 30000 } };
      if (path === "/api/admin/config") return { config: {} };
      if (path === "/api/admin/overview") return null;
      throw new Error(`Unexpected path: ${path}`);
    });
  });

  it("keeps task data when the initial identity resolves without configuration access", async () => {
    let resolveIdentity: ((user: ApiMe) => void) | undefined;
    apiMocks.getMe.mockImplementation(() => new Promise<ApiMe>((resolve) => {
      resolveIdentity = resolve;
    }));
    render(<App />);

    await waitFor(() => expect(screen.getByTestId("app-state").textContent).toBe("1"));

    resolveIdentity?.({
      id: "task-reader",
      username: "task-reader",
      role: "viewer",
      capabilities: { superuser: false, grants: { "task.read": "*" } },
    });

    await waitFor(() => {
      const state = screen.getByTestId("app-state");
      expect(state.getAttribute("data-user")).toBe("task-reader");
      expect(state.textContent).toBe("1");
    });
  });

  it("keeps the Configuration workflow active across its setup sections", () => {
    expect(shouldEnableConfigWorkflow("overview", false, null)).toBe(true);
    expect(shouldEnableConfigWorkflow("integrations", true, null)).toBe(true);
    expect(shouldEnableConfigWorkflow("agents", true, null)).toBe(true);
    expect(shouldEnableConfigWorkflow("projects", true, null)).toBe(true);
    expect(shouldEnableConfigWorkflow("integrations", false, "config-workflow")).toBe(true);
    expect(shouldEnableConfigWorkflow("integrations", false, null)).toBe(false);
  });
});
