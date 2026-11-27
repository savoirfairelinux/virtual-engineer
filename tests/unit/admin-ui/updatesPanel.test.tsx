/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdatesPanel } from "../../../src/admin/ui/views/ConfigView/UpdatesPanel.js";
import { api } from "../../../src/admin/ui/api.js";
import type { ApiSystemUpdate } from "../../../src/admin/ui/types.js";

vi.mock("../../../src/admin/ui/api.js", () => ({
  api: { get: vi.fn(), post: vi.fn() },
}));

const getMock = vi.mocked(api.get);
const postMock = vi.mocked(api.post);

function overview(overrides: Partial<ApiSystemUpdate> = {}): ApiSystemUpdate {
  return {
    current: { version: "0.3.0", gitSha: "abc1234" },
    latest: { version: "0.4.0", url: "https://github.com/savoirfairelinux/virtual-engineer/releases/tag/v0.4.0" },
    latestError: null,
    checkedAt: 0,
    updateAvailable: true,
    updaterInstalled: true,
    request: null,
    status: null,
    inProgress: false,
    ...overrides,
  };
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("UpdatesPanel", () => {
  it("shows the running and latest versions and starts a confirmed update", async () => {
    getMock.mockResolvedValue(overview());
    postMock.mockResolvedValue(overview({ inProgress: true, request: { version: "0.4.0", requestedBy: "admin", requestedAt: 1 } }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<UpdatesPanel canWrite />);

    expect(await screen.findByText("v0.3.0 · abc1234")).toBeTruthy();
    expect(screen.getByRole("link", { name: "v0.4.0" }).getAttribute("href")).toContain("/releases/tag/v0.4.0");
    fireEvent.click(screen.getByRole("button", { name: "Update to v0.4.0" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/admin/system/update", { version: "0.4.0" }));
    expect(confirm.mock.calls[0]?.[0]).toMatch(/Running agent cycles finish first/);
    expect(await screen.findByText(/requested; waiting for the host updater/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Update to v0.4.0" })).toBeNull();
  });

  it("does nothing when the update is not confirmed", async () => {
    getMock.mockResolvedValue(overview());
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<UpdatesPanel canWrite />);

    fireEvent.click(await screen.findByRole("button", { name: "Update to v0.4.0" }));

    expect(postMock).not.toHaveBeenCalled();
  });

  it("explains how to install the host updater instead of offering the button", async () => {
    getMock.mockResolvedValue(overview({ updaterInstalled: false }));
    render(<UpdatesPanel canWrite />);

    expect(await screen.findByText("./scripts/update.sh --install-service")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Update to/ })).toBeNull();
  });

  it("hides the update action from read-only users", async () => {
    getMock.mockResolvedValue(overview());
    render(<UpdatesPanel canWrite={false} />);

    await screen.findByText("v0.3.0 · abc1234");
    expect(screen.queryByRole("button", { name: /Update to/ })).toBeNull();
  });

  it("follows an update through the restart and offers a reload once the version changes", async () => {
    getMock
      .mockResolvedValueOnce(overview({
        inProgress: true,
        status: { state: "draining", from: "0.3.0", to: "0.4.0", message: "Waiting for running agent cycles to finish.", updatedAt: 1 },
      }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(overview({
        current: { version: "0.4.0", gitSha: "def5678" },
        updateAvailable: false,
        status: { state: "succeeded", from: "0.3.0", to: "0.4.0", message: "Updated from 0.3.0 to 0.4.0.", updatedAt: 2 },
      }));
    render(<UpdatesPanel canWrite pollIntervalMs={10} />);

    expect(await screen.findByText("Waiting for running agent cycles")).toBeTruthy();
    expect(await screen.findByText("The orchestrator is restarting…")).toBeTruthy();
    expect(await screen.findByText(/Updated to v0\.4\.0\. Reload/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  });

  it("reports a rolled-back update", async () => {
    getMock.mockResolvedValue(overview({
      status: { state: "rolled_back", from: "0.3.0", to: "0.4.0", message: "v0.4.0 did not become healthy. Restored 0.3.0.", updatedAt: 1 },
    }));
    render(<UpdatesPanel canWrite />);

    expect(await screen.findByText("Update rolled back")).toBeTruthy();
    expect(screen.getByText(/did not become healthy/)).toBeTruthy();
  });
});
