/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiMe } from "../../../src/admin/ui/types.js";

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  getMe: vi.fn(),
}));

vi.mock("../../../src/admin/ui/api.js", () => ({
  ApiError: class ApiError extends Error {
    constructor(public readonly status: number, message: string) {
      super(message);
    }
  },
  api: { get: apiMocks.get, post: apiMocks.post },
  clearStoredToken: vi.fn(),
  connectSse: vi.fn(() => vi.fn()),
  fetchSetupStatus: vi.fn(async () => ({ needsSetup: false })),
  getMe: apiMocks.getMe,
  getStoredToken: vi.fn(() => "session-token"),
  logout: vi.fn(async () => undefined),
  onUnauthorized: vi.fn(),
}));

vi.mock("../../../src/admin/ui/shell/TopBar.js", () => ({
  TopBar: ({ taskCount, user, setView, onLogout }: {
    taskCount: number;
    user: ApiMe | null;
    setView: (view: "overview" | "tasks" | "config") => void;
    onLogout: () => void;
  }) => (
    <>
      <div data-testid="app-state" data-user={user?.username ?? "loading"}>{taskCount}</div>
      <button onClick={() => setView("tasks")}>Tasks</button>
      <button onClick={onLogout}>Sign out</button>
    </>
  ),
}));
vi.mock("../../../src/admin/ui/shell/AuthScreen.js", () => ({
  AuthScreen: () => <div data-testid="auth-screen" />,
}));
vi.mock("../../../src/admin/ui/shell/ChangePasswordModal.js", () => ({ ChangePasswordModal: () => null }));
vi.mock("../../../src/admin/ui/views/OverviewView.js", () => ({ OverviewView: () => null }));
vi.mock("../../../src/admin/ui/views/TasksView/index.js", () => ({
  TasksView: () => <div data-testid="tasks-view" />,
}));
vi.mock("../../../src/admin/ui/views/ConfigView/index.js", () => ({ ConfigView: () => null }));

import { App, shouldEnableConfigWorkflow } from "../../../src/admin/ui/App.js";
import { SecuritySecretsOnboarding } from "../../../src/admin/ui/shell/BackupKeyringOnboarding.js";

describe("App identity loading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      if (path === "/api/admin/security/secrets-onboarding") return { pending: false };
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
    expect(apiMocks.get).not.toHaveBeenCalledWith("/api/admin/security/secrets-onboarding");
  });

  it("checks for setup secrets only after a superuser identity loads", async () => {
    apiMocks.getMe.mockResolvedValue({
      id: "admin-1",
      username: "root",
      role: "admin",
      capabilities: { superuser: true, grants: {} },
    });

    render(<App />);

    await waitFor(() => expect(screen.getByTestId("app-state").getAttribute("data-user")).toBe("root"));
    await waitFor(() => expect(apiMocks.get).toHaveBeenCalledWith("/api/admin/security/secrets-onboarding"));
  });

  it("requires an explicit reveal and copies both setup secrets before acknowledgement", async () => {
    const keyring = {
      format: "virtual-engineer-backup-keyring" as const,
      version: 1 as const,
      activeKeyId: "key-20260928-test",
      keys: { "key-20260928-test": "a".repeat(64) },
    };
    const adminAuthSecret = "c".repeat(64);
    apiMocks.get.mockResolvedValueOnce({ pending: true });
    apiMocks.post
      .mockResolvedValueOnce({ pending: true, secrets: { adminAuthSecret, backupKeyring: keyring } })
      .mockResolvedValueOnce(undefined);
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<SecuritySecretsOnboarding />);

    const dialog = await screen.findByRole("dialog", { name: "Save your Virtual Engineer setup secrets" });
    expect(dialog.textContent).not.toContain(adminAuthSecret);
    expect(screen.queryByLabelText("ADMIN_AUTH_SECRET")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Reveal setup secrets" }));
    const adminSecretField = await screen.findByLabelText("ADMIN_AUTH_SECRET") as HTMLTextAreaElement;
    const keyringField = screen.getByLabelText("Backup keyring JSON") as HTMLTextAreaElement;
    expect(adminSecretField.value).toBe(adminAuthSecret);
    expect(keyringField.value).toContain("a".repeat(64));

    const acknowledge = screen.getByRole("button", { name: "I've saved both secrets securely" }) as HTMLButtonElement;
    expect(acknowledge.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Copy ADMIN_AUTH_SECRET" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy keyring JSON" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(acknowledge.disabled).toBe(false);

    fireEvent.click(acknowledge);
    await waitFor(() => expect(apiMocks.post).toHaveBeenNthCalledWith(
      1,
      "/api/admin/security/secrets-onboarding/reveal",
    ));
    expect(apiMocks.post).toHaveBeenNthCalledWith(
      2,
      "/api/admin/security/secrets-onboarding/acknowledge",
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Save your Virtual Engineer setup secrets" })).toBeNull());
  });

  it("allows manual copying of both values when clipboard access is unavailable", async () => {
    const keyring = {
      format: "virtual-engineer-backup-keyring" as const,
      version: 1 as const,
      activeKeyId: "key-20260928-test",
      keys: { "key-20260928-test": "a".repeat(64) },
    };
    apiMocks.get.mockResolvedValueOnce({ pending: true });
    apiMocks.post.mockResolvedValueOnce({
      pending: true,
      secrets: { adminAuthSecret: "c".repeat(64), backupKeyring: keyring },
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => { throw new Error("clipboard denied"); }) },
    });

    render(<SecuritySecretsOnboarding />);

    fireEvent.click(await screen.findByRole("button", { name: "Reveal setup secrets" }));
    const acknowledge = await screen.findByRole("button", { name: "I've saved both secrets securely" }) as HTMLButtonElement;
    const adminSecretField = await screen.findByLabelText("ADMIN_AUTH_SECRET");
    const keyringField = screen.getByLabelText("Backup keyring JSON");
    fireEvent.click(screen.getByRole("button", { name: "Copy ADMIN_AUTH_SECRET" }));
    await screen.findByText("Clipboard access failed. Select and copy the ADMIN_AUTH_SECRET text or try copying again.");
    fireEvent.click(screen.getByRole("button", { name: "Copy keyring JSON" }));
    await screen.findByText("Clipboard access failed. Select and copy the keyring text or download the file instead.");
    expect(acknowledge.disabled).toBe(true);

    fireEvent.copy(adminSecretField);
    fireEvent.copy(keyringField);
    expect(acknowledge.disabled).toBe(false);
  });

  it.each(["operator", "viewer"] as const)("allows %s task navigation when a denied config route has no mounted guard", async (role) => {
    window.history.replaceState({}, "", "#config");
    apiMocks.getMe.mockResolvedValue({
      id: `${role}-1`,
      username: role,
      role,
    });
    render(<App />);

    await waitFor(() => expect(screen.getByTestId("app-state").getAttribute("data-user")).toBe(role));
    expect(apiMocks.get).not.toHaveBeenCalledWith("/api/admin/security/secrets-onboarding");
    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));

    expect(await screen.findByTestId("tasks-view")).toBeTruthy();
  });

  it.each(["operator", "viewer"] as const)("allows %s logout when a denied config route has no mounted guard", async (role) => {
    window.history.replaceState({}, "", "#config");
    apiMocks.getMe.mockResolvedValue({
      id: `${role}-1`,
      username: role,
      role,
    });
    render(<App />);

    await waitFor(() => expect(screen.getByTestId("app-state").getAttribute("data-user")).toBe(role));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByTestId("auth-screen")).toBeTruthy();
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
