/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../../src/admin/ui/api.js";
import { BackupsSection } from "../../../src/admin/ui/views/ConfigView/BackupsSection.js";

vi.mock("../../../src/admin/ui/api.js", () => ({
  api: {
    get: vi.fn(),
    put: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
    download: vi.fn(),
  },
}));

const settings = { enabled: true, intervalDays: 2, timeOfDay: "03:00", retentionCount: 7 };
const backup = {
  filename: "ve-backup-20260924T030000000Z-a1b2c3d4.tar.gz",
  createdAt: "2026-09-24T03:00:00.000Z",
  sizeBytes: 2048,
};

const getMock = vi.mocked(api.get);
const putMock = vi.mocked(api.put);
const postMock = vi.mocked(api.post);
const deleteMock = vi.mocked(api.delete);
const downloadMock = vi.mocked(api.download);

beforeEach(() => {
  vi.clearAllMocks();
  getMock
    .mockResolvedValueOnce({ settings })
    .mockResolvedValueOnce({ backups: [backup], nextBackupAt: "2026-09-26T03:00:00.000Z" })
    .mockResolvedValue({ backups: [backup], nextBackupAt: "2026-09-26T03:00:00.000Z" });
  putMock.mockResolvedValue({ settings });
  postMock.mockResolvedValue({ backup });
  deleteMock.mockResolvedValue(undefined);
  downloadMock.mockResolvedValue(new Blob(["archive"]));
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:backup");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("BackupsSection", () => {
  it("loads the schedule and archive list, including off-machine restore guidance", async () => {
    render(<BackupsSection onDirtyChange={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Backups" })).toBeDefined();
    expect((await screen.findByRole("checkbox", { name: "Enable scheduled backups" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Interval (days)") as HTMLInputElement).value).toBe("2");
    expect(screen.getByText(backup.filename)).toBeDefined();
    expect(screen.getByText(/copy backup archives off this machine/i)).toBeDefined();
    expect(screen.getByText(/stop the existing instance before restoring/i)).toBeDefined();
  });

  it("preserves loaded schedule settings when archive inventory loading fails", async () => {
    getMock
      .mockReset()
      .mockResolvedValueOnce({ settings })
      .mockRejectedValueOnce(new Error("Archive inventory unavailable"))
      .mockRejectedValueOnce(new Error("Archive inventory unavailable"));
    render(<BackupsSection onDirtyChange={vi.fn()} />);

    expect((await screen.findByRole("alert")).textContent).toContain("Archive inventory unavailable");
    expect((screen.getByLabelText("Interval (days)") as HTMLInputElement).value).toBe("2");
    fireEvent.change(screen.getByLabelText("Interval (days)"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));

    await waitFor(() => expect(putMock).toHaveBeenCalledWith("/api/admin/backups/settings", {
      enabled: true,
      intervalDays: 4,
      timeOfDay: "03:00",
      retentionCount: 7,
    }));
    expect((await screen.findByRole("status")).textContent).toContain("Backup schedule saved.");
  });

  it("registers unsaved schedule changes with the configuration navigation guard", async () => {
    const onDirtyChange = vi.fn();
    render(<BackupsSection onDirtyChange={onDirtyChange} />);
    await screen.findByText(backup.filename);

    fireEvent.change(screen.getByLabelText("Interval (days)"), { target: { value: "4" } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
  });

  it("saves schedule edits and can create, download, and delete an archive", async () => {
    render(<BackupsSection onDirtyChange={vi.fn()} />);
    await screen.findByText(backup.filename);

    fireEvent.change(screen.getByLabelText("Interval (days)"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));
    await waitFor(() => expect(putMock).toHaveBeenCalledWith("/api/admin/backups/settings", {
      enabled: true,
      intervalDays: 4,
      timeOfDay: "03:00",
      retentionCount: 7,
    }));

    fireEvent.click(screen.getByRole("button", { name: "Run backup now" }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/admin/backups"));

    const token = "d".repeat(64);
    postMock.mockResolvedValueOnce({ token });
    const clickedUrls: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clickedUrls.push(this.getAttribute("href") ?? "");
    });
    fireEvent.click(screen.getByRole("button", { name: /download/i }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith(
      `/api/admin/backups/${encodeURIComponent(backup.filename)}/download-token`,
    ));
    await waitFor(() => expect(clickedUrls).toContain(
      `/api/admin/backups/${encodeURIComponent(backup.filename)}/download?t=${token}`,
    ));
    expect(downloadMock).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();

    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith(
      `/api/admin/backups/${encodeURIComponent(backup.filename)}`,
    ));
  });
});