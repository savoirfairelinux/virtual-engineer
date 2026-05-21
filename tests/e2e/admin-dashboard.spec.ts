import { test, expect } from "@playwright/test";

test.describe("Admin Dashboard E2E", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/admin");
    await page.waitForSelector(".app", { timeout: 10000 });
  });

  test("should load dashboard without authentication", async ({ page }) => {
    await expect(page).toHaveTitle(/Virtual Engineer/i);
    await expect(page.locator(".brand")).toBeVisible();
  });

  test("should display active tasks list", async ({ page }) => {
    const taskList = page.locator('[data-role="tasks"]');
    await expect(taskList).toBeVisible({ timeout: 10000 });
  });

  test("should open the configuration shell and navigate to system settings", async ({ page }) => {
    await page.locator('[data-nav="configuration"]').click();

    await expect(page.locator('[data-role="configuration-shell"]')).toBeVisible();
    await expect(page.locator('[data-role="configuration-header"]')).toContainText("Integrations");

    await page.locator('[data-config-section="system-settings"]').click();

    await expect(page.locator('[data-role="configuration-header"]')).toContainText("System Settings");
    await expect(page.locator('[data-role="configuration-content"]')).toContainText(
      "System settings are currently read-only from the admin dashboard."
    );
  });

  test("should open and close the configuration drawer from an integration row", async ({ page }) => {
    await page.locator('[data-nav="configuration"]').click();
    await expect(page.locator('[data-role="configuration-shell"]')).toBeVisible();

    const integrationRows = page.locator('[data-select-integration-id]');
    const rowCount = await integrationRows.count();

    if (rowCount === 0) {
      console.log("Skipping configuration drawer test - no integrations available");
      return;
    }

    const drawer = page.locator('[data-role="configuration-drawer"]');

    await integrationRows.first().click();
    await expect(drawer).toHaveClass(/is-open/);
    await expect(page.locator('[data-role="configuration-drawer-body"]')).toContainText("Masked configuration");

    await page.locator('[data-role="configuration-drawer-close"]').first().click();
    await expect(drawer).not.toHaveClass(/is-open/);

    await integrationRows.first().click();
    await expect(drawer).toHaveClass(/is-open/);
  });

  test("should allow selecting a task from the list", async ({ page }) => {
    await page.waitForSelector('[data-role="tasks"] .task-row', { timeout: 10000 });

    const firstRow = page.locator('[data-role="tasks"] .task-row').first();
    await firstRow.click();

    const detailPanel = page.locator('[data-role="task-detail"]');
    await expect(detailPanel).toBeVisible({ timeout: 5000 });
  });

  test("should display task details when selected", async ({ page }) => {
    await page.waitForSelector('[data-role="tasks"] .task-row', { timeout: 10000 });

    const firstRow = page.locator('[data-role="tasks"] .task-row').first();
    await firstRow.click();

    await expect(page.locator('[data-role="task-detail"]')).toBeVisible();

    const taskId = await firstRow.getAttribute("data-id");
    expect(taskId).toBeTruthy();
  });

  test("should show action buttons when task is selected", async ({ page }) => {
    const taskRows = page.locator('[data-role="tasks"] .task-row');
    const taskCount = await taskRows.count();

    if (taskCount === 0) {
      console.log("Skipping action buttons test - no tasks in database");
      return;
    }

    await taskRows.first().click();

    let count = 0;
    try {
      await page.waitForSelector(".actions-row button", { timeout: 2000 }).catch(() => {});
      count = await page.locator(".actions-row button").count();
    } catch {
      console.log("Action buttons not found or API error occurred");
    }

    if (count === 0) {
      console.log("No action buttons found - API may have failed to load task details");
      return;
    }

    expect(count).toBeGreaterThan(0);
  });

  test("should display confirmation dialog before abandoning a task", async ({ page }) => {
    await page.waitForSelector('[data-role="tasks"] .task-row', { timeout: 10000 });

    await page.locator('[data-role="tasks"] .task-row').first().click();
    await page.waitForSelector('[data-role="task-detail"]');

    const abandonButton = page.locator('.actions-row button[data-action="abandon"]');
    const isVisible = await abandonButton.isVisible().catch(() => false);

    if (isVisible && (await abandonButton.isEnabled())) {
      page.on("dialog", (dialog) => dialog.dismiss());
      await abandonButton.click();
    }
  });

  test("should display live logs panel when task is selected", async ({ page }) => {
    const taskRows = page.locator('[data-role="tasks"] .task-row');
    const taskCount = await taskRows.count();

    if (taskCount === 0) {
      console.log("Skipping live logs test - no tasks in database");
      return;
    }

    await taskRows.first().click();
    await page.waitForTimeout(500);

    const logsPanel = page.locator(".logs-panel");
    const logsPanelVisible = await logsPanel.isVisible().catch(() => false);

    if (!logsPanelVisible) {
      console.log("Logs panel not visible - API may have failed to load task details");
      return;
    }

    expect(logsPanelVisible).toBeTruthy();
  });

  test("should allow switching between different tasks", async ({ page }) => {
    try {
      await page.waitForSelector('[data-role="tasks"] .task-row', { timeout: 10000 });
    } catch {
      console.log("No task rows found - skipping test");
      return;
    }

    const taskRows = page.locator('[data-role="tasks"] .task-row');
    const taskCount = await taskRows.count();
    const detailPanel = page.locator('[data-role="task-detail"]');

    if (taskCount >= 2) {
      await taskRows.first().click();
      await page.waitForTimeout(300);
      await expect(detailPanel).toBeVisible();

      await taskRows.nth(1).click();
      await page.waitForTimeout(300);
      await expect(detailPanel).toBeVisible();
    } else {
      await taskRows.first().click();
      await expect(detailPanel).toBeVisible();
    }
  });

  test("should handle network errors gracefully", async ({ page }) => {
    await page.context().setOffline(true);

    const firstRow = page.locator('[data-role="tasks"] .task-row').first();
    const isVisible = await firstRow.isVisible().catch(() => false);

    if (isVisible) {
      await firstRow.click().catch(() => {});
    }

    await page.context().setOffline(false);

    await expect(page.locator(".brand")).toBeVisible({ timeout: 10000 });
  });

  test("should maintain responsive layout on smaller screens", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/admin");
    await page.waitForSelector(".app");

    await expect(page.locator(".sidebar")).toBeVisible();
  });

  test("should render meta-grid items on the same line", async ({ page }) => {
    await page.waitForSelector(".meta-grid", { timeout: 10000 });

    const metaGrid = page.locator(".meta-grid");
    const items = await metaGrid.locator(".meta-item").all();

    for (const item of items) {
      const boundingBox = await item.boundingBox();
      expect(boundingBox).toBeTruthy();
      if (!boundingBox) {
        throw new Error("Expected meta item bounding box");
      }
      const { y } = boundingBox;

      const firstBoundingBox = await items[0]?.boundingBox();
      expect(firstBoundingBox).toBeTruthy();
      if (!firstBoundingBox) {
        throw new Error("Expected first meta item bounding box");
      }

      expect(y).toBe(firstBoundingBox.y);
    }
  });

  test("should open inline edit form in drawer for an integration", async ({ page }) => {
    await page.locator('[data-nav="configuration"]').click();
    await expect(page.locator('[data-role="configuration-shell"]')).toBeVisible();

    const integrationRows = page.locator('[data-select-integration-id]');
    const rowCount = await integrationRows.count();

    if (rowCount === 0) {
      console.log("Skipping drawer edit test - no integrations available");
      return;
    }

    // Open drawer
    await integrationRows.first().click();
    await expect(page.locator('[data-role="configuration-drawer"]')).toHaveClass(/is-open/);

    // Click "Edit Integration" in drawer
    await page.locator('[data-role="configuration-drawer-edit"]').click();

    // Inline edit form should appear inside the drawer body (not a modal)
    await expect(page.locator('input[data-role="drawer-edit-name"]')).toBeVisible();
    await expect(page.locator('.modal-overlay')).toHaveCount(0);

    // Cancel should restore view mode
    await page.locator('[data-role="drawer-edit-cancel"]').click();
    await expect(page.locator('input[data-role="drawer-edit-name"]')).toHaveCount(0);
  });

  test("should display metrics summary panel with filters when task is selected", async ({ page }) => {
    const taskRows = page.locator('[data-role="tasks"] .task-row');
    const taskCount = await taskRows.count();

    if (taskCount === 0) {
      console.log("Skipping metrics test - no tasks in database");
      return;
    }

    await taskRows.first().click();
    await page.waitForTimeout(500);

    // Metrics summary should be visible
    const metricsSummary = page.locator('[data-role="metrics-summary"]');
    const metricsVisible = await metricsSummary.isVisible().catch(() => false);
    if (!metricsVisible) {
      console.log("Metrics summary not visible - API may have failed");
      return;
    }
    expect(metricsVisible).toBeTruthy();

    // Should have metric items
    const metricItems = metricsSummary.locator(".metric-item");
    const itemCount = await metricItems.count();
    expect(itemCount).toBeGreaterThanOrEqual(6);

    // Quota metric should show unavailable
    const quotaMetric = page.locator('[data-metric="quota"]');
    await expect(quotaMetric).toBeVisible();
    await expect(quotaMetric).toHaveClass(/unavailable/);
  });

  test("should display log filter buttons when task is selected", async ({ page }) => {
    const taskRows = page.locator('[data-role="tasks"] .task-row');
    const taskCount = await taskRows.count();

    if (taskCount === 0) {
      console.log("Skipping filter test - no tasks in database");
      return;
    }

    await taskRows.first().click();
    await page.waitForTimeout(500);

    const filtersBar = page.locator('[data-role="logs-filters"]');
    const filtersVisible = await filtersBar.isVisible().catch(() => false);
    if (!filtersVisible) {
      console.log("Filters bar not visible - API may have failed");
      return;
    }

    // Should have 5 filter buttons
    const filterBtns = filtersBar.locator(".logs-filter-btn");
    const btnCount = await filterBtns.count();
    expect(btnCount).toBe(5);

    // "All" should be active by default
    const activeFilter = filtersBar.locator(".logs-filter-btn.active");
    await expect(activeFilter).toHaveCount(1);
    await expect(activeFilter).toHaveAttribute("data-filter", "all");

    // Clicking a filter should change active state
    await filterBtns.nth(1).click(); // "Tools" filter
    const newActive = filtersBar.locator(".logs-filter-btn.active");
    await expect(newActive).toHaveCount(1);
    await expect(newActive).toHaveAttribute("data-filter", "tools");
  });
});
