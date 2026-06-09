/**
 * Admin Dashboard — Configuration tab behaviour.
 *
 * The old tests exercised the vanilla-JS implementation. Now that the
 * Configuration view is a React component (src/admin/ui/views/ConfigView/),
 * these behaviour tests have moved to E2E (Playwright).
 *
 * This file keeps a minimal smoke test to verify the HTML shell is still
 * served (the React app mounts into it at runtime).
 */
import { describe, expect, it } from "vitest";
import { renderAdminDashboardHtml } from "../../src/admin/dashboard.js";

describe("Admin Dashboard - Configuration Shell", () => {
  it("serves a React shell that includes the bootstrap config", () => {
    const html = renderAdminDashboardHtml();
    expect(html).toContain("__VE_ADMIN_BOOTSTRAP__");
    expect(html).toContain('<div id="root">');
  });
});
