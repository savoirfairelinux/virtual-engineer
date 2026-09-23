/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditSection } from "../../../src/admin/ui/views/ConfigView/AuditSection.js";
import { api } from "../../../src/admin/ui/api.js";
import type { ApiAuditEntry, ApiAuditPage } from "../../../src/admin/ui/types.js";

vi.mock("../../../src/admin/ui/api.js", () => ({
  api: { get: vi.fn() },
}));

const getMock = vi.mocked(api.get);

function entry(overrides: Partial<ApiAuditEntry> = {}): ApiAuditEntry {
  return {
    id: 1,
    actorUserId: "u-1",
    actorName: "root",
    action: "integration.create",
    targetType: "integration",
    targetId: "int-1",
    details: { name: "GitLab", sourceIp: "127.0.0.1" },
    createdAt: "2026-09-23T10:00:00.000Z",
    ...overrides,
  };
}

function page(entries: ApiAuditEntry[], actions = [...new Set(entries.map((item) => item.action))].sort()): ApiAuditPage {
  return { entries, actions, total: entries.length, limit: 50, offset: 0 };
}

beforeEach(() => {
  getMock.mockReset();
  getMock.mockResolvedValue(page([]));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AuditSection actor badges", () => {
  it("renders a real username as a plain actor", async () => {
    getMock.mockResolvedValue(page([entry()]));
    render(<AuditSection />);
    await waitFor(() => expect(screen.getByText("root")).toBeTruthy());
    expect(screen.queryByText("UNAUTHENTICATED")).toBeNull();
    expect(screen.queryByText("SYSTEM")).toBeNull();
  });

  it("renders reserved actor names as real usernames when actorUserId is present", async () => {
    getMock.mockResolvedValue(page([
      entry({ id: 2, actorUserId: "u-unknown", actorName: "unknown" }),
      entry({ id: 3, actorUserId: "u-unauthenticated", actorName: "unauthenticated" }),
      entry({ id: 4, actorUserId: "u-bootstrap", actorName: "bootstrap" }),
    ]));
    render(<AuditSection />);
    await waitFor(() => {
      expect(screen.getByText("unknown")).toBeTruthy();
      expect(screen.getByText("unauthenticated")).toBeTruthy();
      expect(screen.getByText("bootstrap")).toBeTruthy();
    });
    expect(screen.queryByText("UNAUTHENTICATED")).toBeNull();
    expect(screen.queryByText("SYSTEM")).toBeNull();
  });

  it("renders an UNAUTHENTICATED badge for 'unauthenticated' actors", async () => {
    getMock.mockResolvedValue(page([entry({
      actorName: "unauthenticated",
      actorUserId: null,
      action: "auth.login_failed",
      details: { username: "root", sourceIp: "127.0.0.1" },
    })]));
    render(<AuditSection />);
    await waitFor(() => expect(screen.getByText("UNAUTHENTICATED")).toBeTruthy());
    expect(screen.queryByText("unauthenticated")).toBeNull();
  });

  it("renders an UNAUTHENTICATED badge for legacy 'unknown' actors", async () => {
    getMock.mockResolvedValue(page([entry({
      actorName: "unknown",
      actorUserId: null,
      action: "auth.login",
      details: { username: "root", sourceIp: "127.0.0.1" },
    })]));
    render(<AuditSection />);
    await waitFor(() => expect(screen.getByText("UNAUTHENTICATED")).toBeTruthy());
    expect(screen.queryByText("unknown")).toBeNull();
  });

  it("renders a SYSTEM badge for 'bootstrap' actors", async () => {
    getMock.mockResolvedValue(page([entry({
      actorName: "bootstrap",
      actorUserId: null,
      action: "auth.setup",
    })]));
    render(<AuditSection />);
    await waitFor(() => expect(screen.getByText("SYSTEM")).toBeTruthy());
    // The raw name is still visible for filtering context.
    expect(screen.queryByText("bootstrap")).toBeNull();
  });
});

describe("AuditSection click-to-filter", () => {
  it("sets the actor filter when clicking an actor", async () => {
    getMock.mockResolvedValue(page([entry()]));
    render(<AuditSection />);
    await waitFor(() => expect(screen.getByText("root")).toBeTruthy());
    fireEvent.click(screen.getByText("root"));
    await waitFor(() => {
      expect(getMock).toHaveBeenLastCalledWith(expect.stringContaining("actor=root"));
    });
  });

  it("exposes actor and action filters as keyboard-accessible buttons", async () => {
    const user = userEvent.setup();
    getMock.mockResolvedValue(page([entry()]));
    render(<AuditSection />);

    const actorButton = await screen.findByRole("button", { name: "Filter by actor root" });
    const actionButton = screen.getByRole("button", { name: "Filter by action integration.create" });

    actorButton.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(getMock).toHaveBeenLastCalledWith(expect.stringContaining("actor=root"));
    });

    actionButton.focus();
    await user.keyboard(" ");
    await waitFor(() => {
      expect(getMock).toHaveBeenLastCalledWith(expect.stringContaining("action=integration.create"));
    });
  });

  it("offers existing actions in a select and filters by the selected action", async () => {
    const user = userEvent.setup();
    getMock.mockResolvedValue(page([
      entry(),
      entry({ id: 2, action: "user.create" }),
    ], ["integration.create", "user.create"]));
    render(<AuditSection />);

    const actionSelect = await screen.findByRole("combobox", { name: "Filter by action" });
    expect(await screen.findByRole("option", { name: "All actions" })).toBeTruthy();
    expect(await screen.findByRole("option", { name: "integration.create" })).toBeTruthy();
    expect(await screen.findByRole("option", { name: "user.create" })).toBeTruthy();
    expect(screen.queryByPlaceholderText(/Filter by action/)).toBeNull();

    await user.selectOptions(actionSelect, "user.create");
    await waitFor(() => {
      expect(getMock).toHaveBeenLastCalledWith(expect.stringContaining("action=user.create"));
    });
  });

  it("sets the action filter when clicking an action tag", async () => {
    getMock.mockResolvedValue(page([entry()]));
    render(<AuditSection />);
    const actionButton = await screen.findByRole("button", { name: "Filter by action integration.create" });
    fireEvent.click(actionButton);
    await waitFor(() => {
      expect(getMock).toHaveBeenLastCalledWith(expect.stringContaining("action=integration.create"));
    });
  });
});

describe("AuditSection details panel", () => {
  it("shows the target name in the row and the target id when expanded", async () => {
    getMock.mockResolvedValue(page([entry()]));
    render(<AuditSection />);

    await waitFor(() => expect(screen.getByText("integration · GitLab")).toBeTruthy());
    expect(screen.queryByText("integration · int-1")).toBeNull();

    fireEvent.click(screen.getByText("integration · GitLab"));
    await waitFor(() => {
      expect(screen.getByText("ID")).toBeTruthy();
      expect(screen.getByText("int-1")).toBeTruthy();
    });
  });

  it("keeps the target id expandable when no detail fields are present", async () => {
    getMock.mockResolvedValue(page([entry({ details: {} })]));
    render(<AuditSection />);

    const target = await screen.findByText("integration", { exact: true });
    fireEvent.click(target);
    await waitFor(() => {
      expect(screen.getByText("ID")).toBeTruthy();
      expect(screen.getByText("int-1")).toBeTruthy();
    });
  });

  it("renders a humanized labeled details table when expanded", async () => {
    getMock.mockResolvedValue(page([entry({
      details: { sourceIp: "10.0.0.1", username: "root", name: "GitLab" },
    })]));
    render(<AuditSection />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Filter by action integration.create" })).toBeTruthy());
    // Expand via the always-visible target cell (the action tag itself click-filters).
    fireEvent.click(screen.getByText("integration · GitLab"));
    await waitFor(() => {
      expect(screen.getByText("Source IP")).toBeTruthy();
      expect(screen.getByText("10.0.0.1")).toBeTruthy();
      expect(screen.getByText("Username")).toBeTruthy();
      expect(screen.getByText("Name")).toBeTruthy();
    });
  });

  it("keeps nested object values as inline mono JSON", async () => {
    getMock.mockResolvedValue(page([entry({
      details: { nested: { a: 1 }, list: [1, 2] },
    })]));
    render(<AuditSection />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Filter by action integration.create" })).toBeTruthy());
    fireEvent.click(screen.getByText("integration", { exact: true }));
    await waitFor(() => {
      expect(screen.getByText(/"a":1/)).toBeTruthy();
      expect(screen.getByText(/\[1,2\]/)).toBeTruthy();
    });
  });
});
