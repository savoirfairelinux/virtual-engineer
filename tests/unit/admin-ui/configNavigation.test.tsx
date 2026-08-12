/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentUserProvider, makeCan } from "../../../src/admin/ui/authContext.js";
import { api } from "../../../src/admin/ui/api.js";
import { ConfigView } from "../../../src/admin/ui/views/ConfigView/index.js";
import type { ApiMe } from "../../../src/admin/ui/types.js";

const admin: ApiMe = {
  id: "admin-1",
  username: "admin",
  role: "admin",
  capabilities: { superuser: true, grants: {} },
};

describe("Configuration navigation guard", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "#config/system");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers dirty System settings with the parent navigation guard", async () => {
    const guardRef: { current: (() => boolean) | null } = { current: null };
    const { unmount } = render(
      <CurrentUserProvider value={{
        user: admin,
        isAdmin: true,
        canOperate: true,
        can: makeCan(admin),
      }}>
        <ConfigView
          integrations={[]}
          plugins={[]}
          agents={[]}
          projects={[]}
          prompts={[]}
          oauthApps={[]}
          config={{
            nodeEnv: "test",
            logLevel: "silent",
            pollingIntervalMs: 30000,
            maxAgentCycles: 3,
            maxRetryAttempts: 5,
            agentTimeoutMs: 3600000,
            ticketCloseMaxRetries: 5,
            ticketCloseRetryMinTimeoutMs: 5000,
          }}
          status={null}
          onRefresh={vi.fn()}
          onNavigationGuardChange={(nextGuard) => { guardRef.current = nextGuard; }}
        />
      </CurrentUserProvider>,
    );

    const pollingInput = screen.getAllByRole("spinbutton")[0];
    expect(pollingInput).toBeDefined();
    fireEvent.change(pollingInput!, { target: { value: "45" } });

    await waitFor(() => expect(guardRef.current).not.toBeNull());
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    expect(guardRef.current?.()).toBe(false);
    expect(confirm).toHaveBeenCalledWith("Discard unsaved changes?");
    expect(window.location.hash).toBe("#config/system");

    confirm.mockReturnValue(true);
    expect(guardRef.current?.()).toBe(true);

    unmount();
    expect(guardRef.current).toBeNull();
  });

  it("handles direct hash navigation between Configuration sections", async () => {
    render(
      <CurrentUserProvider value={{
        user: admin,
        isAdmin: true,
        canOperate: true,
        can: makeCan(admin),
      }}>
        <ConfigView
          integrations={[]}
          plugins={[]}
          agents={[]}
          projects={[]}
          prompts={[]}
          oauthApps={[]}
          config={null}
          status={null}
          onRefresh={vi.fn()}
        />
      </CurrentUserProvider>,
    );

    window.location.hash = "#config/projects";
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    await screen.findByRole("heading", { name: "Projects" });
  });

  it("organizes sections into fixed navigation groups", () => {
    window.history.replaceState({}, "", "#config/projects");
    render(
      <CurrentUserProvider value={{
        user: admin,
        isAdmin: true,
        canOperate: true,
        can: makeCan(admin),
      }}>
        <ConfigView
          integrations={[]}
          plugins={[]}
          agents={[]}
          projects={[]}
          prompts={[]}
          oauthApps={[]}
          config={null}
          status={null}
          onRefresh={vi.fn()}
        />
      </CurrentUserProvider>,
    );

    const navigation = screen.getByRole("complementary", { name: "Configuration sections" });
    expect(within(navigation).getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
      "Automation & execution",
      "Integrations & connectivity",
      "Execution governance",
      "Access & accountability",
    ]);
    expect(within(navigation).getByRole("button", { name: /Projects/, current: "page" })).toBeDefined();
  });

  it("restores the current hash when direct dirty navigation is rejected", async () => {
    render(
      <CurrentUserProvider value={{
        user: admin,
        isAdmin: true,
        canOperate: true,
        can: makeCan(admin),
      }}>
        <ConfigView
          integrations={[]}
          plugins={[]}
          agents={[]}
          projects={[]}
          prompts={[]}
          oauthApps={[]}
          config={{
            nodeEnv: "test",
            logLevel: "silent",
            pollingIntervalMs: 30000,
            maxAgentCycles: 3,
            maxRetryAttempts: 5,
            agentTimeoutMs: 3600000,
            ticketCloseMaxRetries: 5,
            ticketCloseRetryMinTimeoutMs: 5000,
          }}
          status={null}
          onRefresh={vi.fn()}
        />
      </CurrentUserProvider>,
    );

    fireEvent.change(screen.getAllByRole("spinbutton")[0]!, { target: { value: "45" } });
    vi.spyOn(window, "confirm").mockReturnValue(false);
    window.location.hash = "#config/projects";
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    await waitFor(() => expect(window.location.hash).toBe("#config/system"));
    expect(screen.getByRole("heading", { name: "System settings" })).toBeDefined();
  });

  it("marks System settings clean immediately after a successful save", async () => {
    const guardRef: { current: (() => boolean) | null } = { current: null };
    const onRefresh = vi.fn();
    vi.spyOn(api, "put").mockResolvedValue(undefined);
    render(
      <CurrentUserProvider value={{
        user: admin,
        isAdmin: true,
        canOperate: true,
        can: makeCan(admin),
      }}>
        <ConfigView
          integrations={[]}
          plugins={[]}
          agents={[]}
          projects={[]}
          prompts={[]}
          oauthApps={[]}
          config={{
            nodeEnv: "test",
            logLevel: "silent",
            pollingIntervalMs: 30000,
            maxAgentCycles: 3,
            maxRetryAttempts: 5,
            agentTimeoutMs: 3600000,
            ticketCloseMaxRetries: 5,
            ticketCloseRetryMinTimeoutMs: 5000,
          }}
          status={null}
          onRefresh={onRefresh}
          onNavigationGuardChange={(nextGuard) => { guardRef.current = nextGuard; }}
        />
      </CurrentUserProvider>,
    );

    fireEvent.change(screen.getAllByRole("spinbutton")[0]!, { target: { value: "45" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await screen.findByText("Settings saved.");
    const confirm = vi.spyOn(window, "confirm");
    expect(guardRef.current?.()).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("saves the agent timeout in milliseconds", async () => {
    const put = vi.spyOn(api, "put").mockResolvedValue(undefined);
    render(
      <CurrentUserProvider value={{
        user: admin,
        isAdmin: true,
        canOperate: true,
        can: makeCan(admin),
      }}>
        <ConfigView
          integrations={[]}
          plugins={[]}
          agents={[]}
          projects={[]}
          prompts={[]}
          oauthApps={[]}
          config={{
            nodeEnv: "test",
            logLevel: "silent",
            pollingIntervalMs: 30000,
            maxAgentCycles: 3,
            maxRetryAttempts: 5,
            agentTimeoutMs: 3600000,
            ticketCloseMaxRetries: 5,
            ticketCloseRetryMinTimeoutMs: 5000,
          }}
          status={null}
          onRefresh={vi.fn()}
        />
      </CurrentUserProvider>,
    );

    fireEvent.change(screen.getByLabelText("Agent timeout (minutes)"), { target: { value: "15" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(put).toHaveBeenCalledWith("/api/admin/settings", { agentTimeoutMs: 900000 }));
  });

  it("marks a non-minute timeout as changed before normalizing it", async () => {
    const put = vi.spyOn(api, "put").mockResolvedValue(undefined);
    render(
      <CurrentUserProvider value={{
        user: admin,
        isAdmin: true,
        canOperate: true,
        can: makeCan(admin),
      }}>
        <ConfigView
          integrations={[]}
          plugins={[]}
          agents={[]}
          projects={[]}
          prompts={[]}
          oauthApps={[]}
          config={{
            nodeEnv: "test",
            logLevel: "silent",
            pollingIntervalMs: 30000,
            maxAgentCycles: 3,
            maxRetryAttempts: 5,
            agentTimeoutMs: 900001,
            ticketCloseMaxRetries: 5,
            ticketCloseRetryMinTimeoutMs: 5000,
          }}
          status={null}
          onRefresh={vi.fn()}
        />
      </CurrentUserProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(put).toHaveBeenCalledWith("/api/admin/settings", { agentTimeoutMs: 900000 }));
  });

  it("marks provider selection dirty but ignores provider search text", () => {
    window.history.replaceState({}, "", "#config/integrations/new");
    const guardRef: { current: (() => boolean) | null } = { current: null };
    render(
      <CurrentUserProvider value={{
        user: admin,
        isAdmin: true,
        canOperate: true,
        can: makeCan(admin),
      }}>
        <ConfigView
          integrations={[]}
          plugins={[{
            provider: "github",
            name: "GitHub",
            capabilities: [],
            domainCapabilities: ["issue_tracking"],
            requiredFields: [],
            agentConfigFields: [],
          }]}
          agents={[]}
          projects={[]}
          prompts={[]}
          oauthApps={[]}
          config={null}
          status={null}
          onRefresh={vi.fn()}
          onNavigationGuardChange={(nextGuard) => { guardRef.current = nextGuard; }}
        />
      </CurrentUserProvider>,
    );

    fireEvent.input(screen.getByRole("searchbox", { name: "Search integrations" }), { target: { value: "git" } });
    const confirm = vi.spyOn(window, "confirm");
    expect(guardRef.current?.()).toBe(true);
    expect(confirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /GitHub/ }));
    confirm.mockReturnValue(false);
    expect(guardRef.current?.()).toBe(false);
    expect(confirm).toHaveBeenCalledWith("Discard unsaved changes?");
  });

  it("does not swallow navigation after a canceled history traversal", async () => {
    const go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    render(
      <CurrentUserProvider value={{
        user: admin,
        isAdmin: true,
        canOperate: true,
        can: makeCan(admin),
      }}>
        <ConfigView
          integrations={[]}
          plugins={[]}
          agents={[]}
          projects={[]}
          prompts={[]}
          oauthApps={[]}
          config={{
            nodeEnv: "test",
            logLevel: "silent",
            pollingIntervalMs: 30000,
            maxAgentCycles: 3,
            maxRetryAttempts: 5,
            agentTimeoutMs: 3600000,
            ticketCloseMaxRetries: 5,
            ticketCloseRetryMinTimeoutMs: 5000,
          }}
          status={null}
          onRefresh={vi.fn()}
        />
      </CurrentUserProvider>,
    );

    fireEvent.change(screen.getAllByRole("spinbutton")[0]!, { target: { value: "45" } });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    window.history.replaceState({ veConfigIndex: -1 }, "", "#config/projects");
    window.dispatchEvent(new PopStateEvent("popstate", { state: { veConfigIndex: -1 } }));

    expect(go).toHaveBeenCalledWith(1);
    window.history.replaceState({ veConfigIndex: 0 }, "", "#config/system");
    window.dispatchEvent(new PopStateEvent("popstate", { state: { veConfigIndex: 0 } }));

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: /Projects/ }));
    await screen.findByRole("heading", { name: "Projects" });
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});