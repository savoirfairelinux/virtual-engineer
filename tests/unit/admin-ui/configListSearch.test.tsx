/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CurrentUserProvider, makeCan } from "../../../src/admin/ui/authContext.js";
import { api } from "../../../src/admin/ui/api.js";
import { ConfigView, type ConfigViewData } from "../../../src/admin/ui/views/ConfigView/index.js";
import type { ApiIntegration, ApiMe, ApiPrompt, ApiUser } from "../../../src/admin/ui/types.js";

const admin: ApiMe = {
  id: "admin-1",
  username: "admin",
  role: "admin",
  capabilities: { superuser: true, grants: {} },
};

const ts = "2026-01-01T00:00:00.000Z";

const integrations: ApiIntegration[] = [
  { id: "int-gh", provider: "github", name: "Main GitHub", enabled: true, capabilities: [], domainCapabilities: ["issue_tracking"] },
  { id: "int-gl", provider: "gitlab", name: "Internal GitLab", enabled: false, capabilities: [], domainCapabilities: ["code_review"] },
];

const prompts: ApiPrompt[] = [
  { id: "sys", label: "System one", content: "system text", promptType: "system", updatedAt: ts },
  { id: "ins", label: "Instructions one", content: "instructions text", promptType: "instructions", updatedAt: ts },
];

const baseProps: ConfigViewData = {
  integrations,
  plugins: [],
  agents: [],
  projects: [],
  prompts,
  oauthApps: [],
  config: null,
  status: null,
  onRefresh: vi.fn(),
};

function renderConfig(hash: string) {
  window.history.replaceState({}, "", hash);
  return render(
    <CurrentUserProvider value={{ user: admin, isAdmin: true, canOperate: true, can: makeCan(admin) }}>
      <ConfigView {...baseProps} />
    </CurrentUserProvider>,
  );
}

function rowNames(prefix: string): string[] {
  return screen.getAllByRole("button", { name: new RegExp(`^${prefix} `) })
    .map((row) => row.getAttribute("aria-label") ?? "");
}

describe("Configuration list search and filters", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("narrows integrations by search and keeps the search across a detail round-trip", async () => {
    vi.spyOn(api, "get").mockResolvedValue({});
    const { container } = renderConfig("#config/integrations");

    fireEvent.change(screen.getByRole("searchbox", { name: "Search integrations" }), { target: { value: "gitlab" } });
    expect(rowNames("Open integration")).toEqual(["Open integration Internal GitLab"]);
    expect(screen.getByText("1 of 2")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open integration Internal GitLab" }));
    await waitFor(() => expect(container.querySelector(".config-back")).not.toBeNull());
    fireEvent.click(container.querySelector(".config-back")!);

    await waitFor(() => expect(screen.getByRole("searchbox", { name: "Search integrations" })).toHaveProperty("value", "gitlab"));
    expect(rowNames("Open integration")).toEqual(["Open integration Internal GitLab"]);
  });

  it("filters integrations by status and clears back to the full list", () => {
    vi.spyOn(api, "get").mockResolvedValue({});
    renderConfig("#config/integrations");

    fireEvent.change(screen.getByRole("combobox", { name: "Status" }), { target: { value: "enabled" } });
    expect(rowNames("Open integration")).toEqual(["Open integration Main GitHub"]);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search integrations" }), { target: { value: "nothing-matches" } });
    expect(screen.getByText("No integrations match the current search or filters.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(rowNames("Open integration")).toHaveLength(2);
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveProperty("value", "all");
  });

  it("filters prompts by type and searches prompt content", () => {
    renderConfig("#config/prompts");

    fireEvent.change(screen.getByRole("combobox", { name: "Type" }), { target: { value: "system" } });
    expect(rowNames("Open prompt")).toEqual(["Open prompt System one"]);

    fireEvent.change(screen.getByRole("combobox", { name: "Type" }), { target: { value: "all" } });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search prompts" }), { target: { value: "instructions text" } });
    expect(rowNames("Open prompt")).toEqual(["Open prompt Instructions one"]);
  });

  it("sorts prompts by label", () => {
    renderConfig("#config/prompts");

    fireEvent.change(screen.getByRole("combobox", { name: "Sort prompts" }), { target: { value: "name-asc" } });
    expect(rowNames("Open prompt")).toEqual(["Open prompt Instructions one", "Open prompt System one"]);
  });

  it("loads up to the backend maximum of users and filters them by role", async () => {
    const users: ApiUser[] = [
      { id: "u1", username: "alice", role: "admin", enabled: true, createdAt: ts, updatedAt: ts },
      { id: "u2", username: "bob", role: "viewer", enabled: true, createdAt: ts, updatedAt: ts },
    ];
    const get = vi.spyOn(api, "get").mockResolvedValue({ users, total: 250 });
    renderConfig("#config/users");

    await waitFor(() => expect(rowNames("Open user")).toHaveLength(2));
    expect(get).toHaveBeenCalledWith("/api/admin/users?limit=200");
    expect(screen.getByText(/Showing the first 2 of 250 users/)).toBeTruthy();

    const toolbar = screen.getByRole("search", { name: "Filter users" });
    fireEvent.change(within(toolbar).getByRole("combobox", { name: "Role" }), { target: { value: "viewer" } });
    expect(rowNames("Open user")).toEqual(["Open user bob"]);
  });
});
