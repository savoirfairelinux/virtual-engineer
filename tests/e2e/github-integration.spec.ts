import { test, expect, type Route } from "@playwright/test";

/**
 * GitHub integration E2E — walks the admin dashboard to create a GitHub Issues
 * integration via a Personal Access Token, saves it, and verifies it appears as
 * an active integration.
 *
 * The test runs fully offline: every `/api/admin/integrations` and
 * `/api/admin/providers` call is stubbed so no real github.com request is made.
 * The integration form itself is rendered from the real `/api/admin/plugins`
 * descriptors served by `npm run dev`, exercising the actual GitHub descriptor
 * `requiredFields` (mode / authMode / token).
 */

interface StubIntegration {
  id: string;
  type: string;
  category: string;
  name: string;
  enabled: boolean;
  active: boolean;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

test.describe("GitHub integration flow", () => {
  let integrations: StubIntegration[];

  test.beforeEach(async ({ page }) => {
    integrations = [];

    const json = (route: Route, body: unknown, status = 200): Promise<void> =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    // Stub integrations list + creation so the flow never touches github.com.
    await page.route("**/api/admin/integrations", async (route) => {
      const method = route.request().method();
      if (method === "GET") return json(route, { integrations });
      if (method === "POST") {
        const payload = JSON.parse(route.request().postData() || "{}") as {
          type: string;
          name: string;
          config: Record<string, unknown>;
        };
        const now = new Date().toISOString();
        const created: StubIntegration = {
          id: "github-issue-" + (integrations.length + 1),
          type: payload.type,
          category: "ticketing",
          name: payload.name,
          enabled: true,
          active: true,
          config: { ...payload.config, token: "********" },
          createdAt: now,
          updatedAt: now,
        };
        integrations.push(created);
        return json(route, { integration: created }, 201);
      }
      return route.continue();
    });

    // Connection-test endpoint is short-circuited to success (offline).
    await page.route("**/api/admin/integrations/test", async (route) => {
      if (route.request().method() === "POST") {
        return json(route, { success: true, error: null });
      }
      return route.continue();
    });

    await page.goto("/admin");
    await page.waitForSelector(".app", { timeout: 10000 });
  });

  test("creates a GitHub Issues integration via PAT and shows it active", async ({ page }) => {
    // Open Configuration → Ticket Sources (ticketing category).
    await page.locator('[data-nav="configuration"]').click();
    await expect(page.locator('[data-role="configuration-shell"]')).toBeVisible();
    await page.locator('[data-config-section="tickets"]').click();

    // Open the Add Integration modal.
    await page.locator('button[data-role="add-integration"]').click();
    const modal = page.locator(".modal-overlay .modal");
    await expect(modal).toBeVisible();

    // Select the GitHub Issues descriptor.
    await modal.locator('[data-role="modal-type"]').selectOption("github-issue");
    await modal.locator('[data-role="modal-name"]').fill("GitHub Issues Prod");

    // Default mode is github.com (Base URL stays hidden). Choose PAT auth.
    await modal.locator('[data-select-field="authMode"]').selectOption("pat");

    // The PAT field is revealed by the dependsOn handler once authMode=pat.
    const tokenInput = modal.locator('[data-field="token"]');
    await expect(tokenInput).toBeVisible();
    await tokenInput.fill("ghp_exampletoken1234567890");

    // Save — POST is stubbed, the list refreshes from the stub.
    await modal.locator('[data-role="modal-save"]').click();

    // Modal closes and the new integration appears as active.
    await expect(page.locator(".modal-overlay")).toHaveCount(0);

    const row = page.locator('[data-select-integration-id]', { hasText: "GitHub Issues Prod" });
    await expect(row).toBeVisible({ timeout: 10000 });
    await expect(row).toContainText("github-issue");
    await expect(row.locator('.badge')).toContainText("active");
  });
});
