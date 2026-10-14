/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentUserProvider, makeCan } from "../../../src/admin/ui/authContext.js";
import { ExportsSection } from "../../../src/admin/ui/views/ConfigView/ExportsSection.js";
import type { ConfigRoute } from "../../../src/admin/ui/views/ConfigView/configRouting.js";
import type { ApiMe, ApiProject } from "../../../src/admin/ui/types.js";
import { api } from "../../../src/admin/ui/api.js";

vi.mock("../../../src/admin/ui/api.js", () => ({ api: { get: vi.fn(), download: vi.fn() } }));
const downloadMock = vi.mocked(api.download);
const projects: ApiProject[] = ["Backend", "Mobile", "Platform"].map((name) => ({
  id: name.toLowerCase(), name, type: "coding", enabled: true, agentId: null,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
}));

function view(role: "admin" | "operator" | "viewer" | null = "admin", onNavigate = vi.fn(), mode: "list" | "analytics" = "analytics") {
  const user: ApiMe | null = role === null ? null : {
    id: `user-${role}`, username: role, role,
    capabilities: { superuser: role === "admin", grants: { "audit.read": "*", "overview.read": "*" } },
  };
  return <CurrentUserProvider value={{ user, isAdmin: role === "admin", canOperate: role !== "viewer" && role !== null, can: makeCan(user) }}>
    <ExportsSection route={{ section: "exports", mode }} onNavigate={onNavigate} projects={projects} />
  </CurrentUserProvider>;
}

beforeEach(() => {
  downloadMock.mockReset();
  downloadMock.mockResolvedValue(new Blob(["analytics"], { type: "text/csv" }));
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:analytics");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Configuration exports", () => {
  it("places Back before the title and uses the full available form width", () => {
    render(view());
    const back = screen.getByRole("button", { name: "Back" });
    const heading = screen.getByRole("heading", { name: "Export analytics" });
    expect(back.classList.contains("config-back")).toBe(true);
    expect(back.parentElement?.classList.contains("config-entity-head")).toBe(true);
    expect(back.parentElement?.classList.contains("export-page-head")).toBe(true);
    expect(back.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const form = screen.getByRole("combobox", { name: "Period" }).closest("form");
    expect(form?.style.maxWidth).toBe("");
    expect(form?.style.width).toBe("100%");
    expect(form?.classList.contains("card")).toBe(true);
    expect(form?.classList.contains("export-filter-panel")).toBe(true);
    expect(screen.getByRole("button", { name: "Download CSV" }).parentElement?.style.borderTop).toBe("");
  });
  it("lists analytics and audit exports for admins and navigates to their pages", () => {
    const onNavigate = vi.fn<(route: ConfigRoute) => void>();
    render(view("admin", onNavigate, "list"));
    const list = screen.getByRole("region", { name: "Available exports" });
    expect(list.style.maxWidth).toBe("");
    expect(list.style.width).toBe("100%");
    fireEvent.click(screen.getByRole("button", { name: "Export analytics" }));
    expect(onNavigate).toHaveBeenCalledWith({ section: "exports", mode: "analytics" });
    fireEvent.click(screen.getByRole("button", { name: "Export audit trail" }));
    expect(onNavigate).toHaveBeenCalledWith({ section: "exports", mode: "audit" });
  });

  it.each(["operator", "viewer", null] as const)("denies analytics forms to %s despite policy grants", (role) => {
    render(view(role));
    expect(screen.queryByRole("combobox", { name: "Period" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Export analytics" })).toBeNull();
    if (role !== null) expect(screen.getByRole("button", { name: "Export audit trail" })).toBeDefined();
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it.each([
    ["1", "?days=1", "24h"], ["7", "?days=7", "7d"],
    ["30", "?days=30", "30d"], ["all", "", "all"],
  ])("downloads period %s on a full page without a modal", async (period, query, suffix) => {
    render(view());
    const select = screen.getByRole("combobox", { name: "Period" });
    expect((select as HTMLSelectElement).value).toBe("7");
    fireEvent.change(select, { target: { value: period } });
    let filename = "";
    vi.mocked(HTMLAnchorElement.prototype.click).mockImplementation(function (this: HTMLAnchorElement) { filename = this.download; });
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    await waitFor(() => expect(downloadMock).toHaveBeenCalledWith(`/api/admin/overview/export.csv${query}`, { signal: expect.any(AbortSignal) }));
    expect((await screen.findByRole("status")).textContent).toBe("CSV download started.");
    expect(filename).toBe(`general-view-analytics-${suffix}.csv`);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:analytics");
    expect(document.querySelector('a[download]')).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("exports exact UTC dates and multiple selected projects", async () => {
    render(view());
    fireEvent.change(screen.getByRole("combobox", { name: "Period" }), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("Start date (UTC)"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText("End date (UTC)"), { target: { value: "2026-10-02" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "All projects" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Backend (backend)" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search projects" }), { target: { value: "plat" } });
    expect(screen.queryByRole("checkbox", { name: "Mobile (mobile)" })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Platform (platform)" }));
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    await screen.findByRole("status");
    const path = downloadMock.mock.calls[0]?.[0];
    const query = new URL(path ?? "", "http://localhost").searchParams;
    expect(query.get("from")).toBe("2026-10-01");
    expect(query.get("to")).toBe("2026-10-02");
    expect(query.getAll("projectId")).toEqual(["backend", "platform"]);
    expect(query.has("days")).toBe(false);
  });

  it("rejects an empty project selection without downloading", () => {
    render(view());
    fireEvent.click(screen.getByRole("checkbox", { name: "All projects" }));
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(screen.getByRole("alert").textContent).toContain("Select at least one project");
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it.each([["", ""], ["2026-10-03", "2026-10-01"]])("rejects invalid custom dates %s to %s", (from, to) => {
    render(view());
    fireEvent.change(screen.getByRole("combobox", { name: "Period" }), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("Start date (UTC)"), { target: { value: from } });
    fireEvent.change(screen.getByLabelText("End date (UTC)"), { target: { value: to } });
    const form = screen.getByRole("combobox", { name: "Period" }).closest("form");
    if (!form) throw new Error("Missing form");
    fireEvent.submit(form);
    expect(screen.getByRole("alert")).toBeDefined();
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it("blocks duplicates, shows errors, and permits retry", async () => {
    let rejectDownload: ((reason: Error) => void) | undefined;
    downloadMock.mockImplementationOnce(() => new Promise<Blob>((_resolve, reject) => { rejectDownload = reject; }));
    render(view());
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect((screen.getByRole("button", { name: "Downloading..." }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("combobox", { name: "Period" }) as HTMLSelectElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Downloading..." }));
    expect(downloadMock).toHaveBeenCalledTimes(1);
    await act(async () => rejectDownload?.(new Error("Export denied")));
    expect(screen.getByRole("alert").textContent).toBe("Export denied");
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    await screen.findByRole("status");
    expect(downloadMock).toHaveBeenCalledTimes(2);
  });

  it.each(["cancel", "unmount", "role change"])("aborts on %s and suppresses late downloads", async (action) => {
    let resolveDownload: ((value: Blob) => void) | undefined;
    downloadMock.mockImplementation(() => new Promise<Blob>((resolve) => { resolveDownload = resolve; }));
    const rendered = render(view());
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    const options = downloadMock.mock.calls[0]?.[1] as { signal: AbortSignal };
    if (action === "cancel") fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    else if (action === "unmount") rendered.unmount();
    else rendered.rerender(view("viewer"));
    expect(options.signal.aborted).toBe(true);
    await act(async () => resolveDownload?.(new Blob(["late report"])));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("provides a keyboard-accessible return to the exports page", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(view("admin", onNavigate));
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(onNavigate).toHaveBeenCalledWith({ section: "exports", mode: "list" });
  });
});