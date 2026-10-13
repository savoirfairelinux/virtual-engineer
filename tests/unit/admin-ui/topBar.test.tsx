/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TopBar } from "../../../src/admin/ui/shell/TopBar.js";

describe("TopBar issue reporting", () => {
  it.each(["overview", "tasks", "config"] as const)("links to the GitHub bug report form from %s", (view) => {
    render(
      <TopBar
        view={view}
        setView={() => undefined}
        theme="dark"
        toggleTheme={() => undefined}
        user={{ id: "user-1", username: "admin", role: "admin" }}
        canViewConfig
        onChangePassword={() => undefined}
        onStartTutorial={() => undefined}
        onLogout={() => undefined}
        taskCount={0}
        activeCount={0}
        projectCount={0}
        pollingRunning={false}
      />,
    );

    const report = screen.getByRole("link", { name: "Report an issue" });
    expect(report.getAttribute("href")).toBe("https://github.com/savoirfairelinux/virtual-engineer/issues/new?template=bug_report.yml");
    expect(report.getAttribute("target")).toBe("_blank");
    expect(report.getAttribute("rel")?.split(/\s+/)).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
    expect(report.getAttribute("title")).toBe("Report an issue");
    expect(report.classList.contains("iconbtn")).toBe(true);
    expect(report.nextElementSibling).toBe(screen.getByTitle("Toggle theme"));
  });

  it.each([
    ["viewer", { id: "viewer-1", username: "viewer", role: "viewer" }],
    ["operator", { id: "operator-1", username: "operator", role: "operator" }],
    ["bootstrap", { id: null, username: "admin", role: "admin" }],
    ["no user", null],
  ] as const)("keeps reporting keyboard-accessible for %s without configuration access", async (_label, currentUser) => {
    const user = userEvent.setup();
    render(
      <TopBar
        view="tasks"
        setView={() => undefined}
        theme="light"
        toggleTheme={() => undefined}
        user={currentUser}
        canViewConfig={false}
        onChangePassword={() => undefined}
        onStartTutorial={() => undefined}
        onLogout={() => undefined}
        taskCount={0}
        activeCount={0}
        projectCount={0}
        pollingRunning={false}
      />,
    );

    screen.getByTitle("Toggle theme").focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Report an issue" }));
  });
});

describe("TopBar tutorial launcher", () => {
  it("places an accessible tutorial button between password and logout", async () => {
    const user = userEvent.setup();
    const onStartTutorial = vi.fn();

    render(
      <TopBar
        view="overview"
        setView={() => undefined}
        theme="dark"
        toggleTheme={() => undefined}
        user={{ id: "user-1", username: "admin", role: "admin" }}
        canViewConfig
        onChangePassword={() => undefined}
        onStartTutorial={onStartTutorial}
        onLogout={() => undefined}
        taskCount={0}
        activeCount={0}
        projectCount={0}
        pollingRunning={false}
      />,
    );

    const changePassword = screen.getByTitle("Change password");
    const tutorial = screen.getByRole("button", { name: "Start tutorial" });
    const logout = screen.getByRole("button", { name: "Sign out" });

    expect(tutorial.getAttribute("data-tour")).toBe("tutorial-launcher");
    expect(changePassword.nextElementSibling).toBe(tutorial);
    expect(tutorial.nextElementSibling).toBe(logout);

    await user.click(tutorial);
    expect(onStartTutorial).toHaveBeenCalledOnce();
  });

  it("shows task, active, and project counters without integrations", () => {
    const { container } = render(
      <TopBar
        view="overview"
        setView={() => undefined}
        theme="dark"
        toggleTheme={() => undefined}
        user={{ id: "user-1", username: "admin", role: "admin" }}
        canViewConfig
        onChangePassword={() => undefined}
        onStartTutorial={() => undefined}
        onLogout={() => undefined}
        taskCount={7}
        activeCount={2}
        projectCount={3}
        pollingRunning={false}
      />,
    );

    const text = container.textContent ?? "";
    expect(text).toContain("7 tasks");
    expect(text).toContain("2 active");
    expect(text).toContain("3 projects");
    expect(text).not.toContain("integrations");
  });

  it("shows the running version with build details in a tooltip", () => {
    render(
      <TopBar
        view="overview"
        setView={() => undefined}
        theme="dark"
        toggleTheme={() => undefined}
        user={{ id: "user-1", username: "admin", role: "admin" }}
        canViewConfig
        onChangePassword={() => undefined}
        onStartTutorial={() => undefined}
        onLogout={() => undefined}
        taskCount={0}
        activeCount={0}
        projectCount={0}
        pollingRunning={false}
        buildInfo={{ version: "1.2.3", gitSha: "abc1234", buildDate: "2026-10-08T12:00:00Z" }}
      />,
    );

    const badge = screen.getByText("v1.2.3");
    expect(badge.getAttribute("title")).toBe("Version 1.2.3 · commit abc1234 · built 2026-10-08T12:00:00Z");
  });

  it("omits the version badge until build info is loaded", () => {
    const { container } = render(
      <TopBar
        view="overview"
        setView={() => undefined}
        theme="dark"
        toggleTheme={() => undefined}
        user={{ id: "user-1", username: "admin", role: "admin" }}
        canViewConfig
        onChangePassword={() => undefined}
        onStartTutorial={() => undefined}
        onLogout={() => undefined}
        taskCount={0}
        activeCount={0}
        projectCount={0}
        pollingRunning={false}
      />,
    );

    expect(container.textContent ?? "").not.toMatch(/\bv\d+\.\d+/);
  });
});
