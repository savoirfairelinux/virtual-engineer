/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditExportSection } from "../../../src/admin/ui/views/ConfigView/AuditExportSection.js";
import { api } from "../../../src/admin/ui/api.js";

vi.mock("../../../src/admin/ui/api.js", () => ({
  api: { get: vi.fn(), download: vi.fn() },
}));

const getMock = vi.mocked(api.get);
const downloadMock = vi.mocked(api.download);

beforeEach(() => {
  getMock.mockResolvedValue({
    actions: ["integration.create", "user.update"],
    actors: ["alice", "bob"],
    targetTypes: ["integration", "user"],
    integrations: [{ id: "int-1", name: "GitLab" }],
  });
  downloadMock.mockResolvedValue(new Blob(["id,action\n1,integration.create\n"], { type: "text/csv" }));
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:csv");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AuditExportSection", () => {
  it("loads selectable filter options and downloads a filtered CSV", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    render(<AuditExportSection onBack={onBack} />);

    const actor = await screen.findByRole("combobox", { name: "Filter by user" });
    await user.selectOptions(actor, "alice");
    await user.selectOptions(screen.getByRole("combobox", { name: "Filter by action" }), "integration.create");
    await user.selectOptions(screen.getByRole("combobox", { name: "Filter by integration" }), "int-1");
    await user.selectOptions(screen.getByRole("combobox", { name: "Filter by target type" }), "integration");
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2026-09-23" } });

    await user.click(screen.getByRole("button", { name: "Download CSV" }));
    await waitFor(() => {
      expect(downloadMock).toHaveBeenCalledWith(expect.stringContaining("actor=alice"));
      expect(downloadMock).toHaveBeenCalledWith(expect.stringContaining("action=integration.create"));
      expect(downloadMock).toHaveBeenCalledWith(expect.stringContaining("integration=int-1"));
      expect(downloadMock).toHaveBeenCalledWith(expect.stringContaining("targetType=integration"));
      expect(downloadMock).toHaveBeenCalledWith(expect.stringContaining("from=2026-09-01"));
      expect(downloadMock).toHaveBeenCalledWith(expect.stringContaining("to=2026-09-23"));
    });
  });

  it("returns to the audit list", async () => {
    const onBack = vi.fn();
    render(<AuditExportSection onBack={onBack} />);
    await screen.findByRole("button", { name: "Download CSV" });
    fireEvent.click(screen.getByRole("button", { name: "Back to audit" }));
    expect(onBack).toHaveBeenCalledOnce();
  });
});