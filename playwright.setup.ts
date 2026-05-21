import { chromium } from "@playwright/test";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function seedTestData() {
  // Wait for the server to be ready and database to be initialized
  let serverReady = false;
  let retries = 60;

  console.log("[Playwright Setup] Waiting for server to initialize database...");
  while (retries > 0 && !serverReady) {
    try {
      const browser = await chromium.launch();
      const page = await browser.newPage();
      const response = await page.goto("http://localhost:3100/admin", { waitUntil: "domcontentloaded", timeout: 5000 });
      await browser.close();
      if (response?.ok) {
        serverReady = true;
        console.log("[Playwright Setup] Server is ready");
      }
    } catch (error) {
      retries--;
      if (retries > 0) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  if (!serverReady) {
    throw new Error("[Playwright Setup] Server did not become ready");
  }

  // Now seed the test data
  try {
    const dbPath = path.join(__dirname, "data", "virtual-engineer.sqlite");
    const db = new Database(dbPath);

    // Check if test data already exists
    try {
      const existingTasks = db.prepare("SELECT COUNT(*) as count FROM tasks").get() as { count: number };
      if (existingTasks.count > 0) {
        console.log(`[Playwright Setup] Database already has ${existingTasks.count} tasks`);
        db.close();
        return;
      }
    } catch (error) {
      console.log("[Playwright Setup] Tasks table not yet created, waiting...");
      db.close();
      // Wait a bit more and try again
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return seedTestData();
    }

    console.log("[Playwright Setup] Seeding test data...");

    // Create test tasks
    const createTaskStmt = db.prepare(`
      INSERT INTO tasks (task_id, ticket_id, state, cycle_count, failure_reason, gerrit_change_id, current_patchset, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tasks = [
      {
        taskId: "task-e2e-001",
        ticketId: "CALC-42",
        state: "AGENT_RUNNING",
        cycleCount: 1,
        failureReason: null,
        gerritChangeId: "Ie2e001test001",
        currentPatchset: 1,
      },
      {
        taskId: "task-e2e-002",
        ticketId: "CALC-43",
        state: "IN_REVIEW",
        cycleCount: 2,
        failureReason: null,
        gerritChangeId: "Ie2e002test002",
        currentPatchset: 2,
      },
      {
        taskId: "task-e2e-003",
        ticketId: "CALC-44",
        state: "DONE",
        cycleCount: 1,
        failureReason: null,
        gerritChangeId: "Ie2e003test003",
        currentPatchset: 1,
      },
    ];

    const now = new Date();
    const transaction = db.transaction(() => {
      for (const task of tasks) {
        createTaskStmt.run(
          task.taskId,
          task.ticketId,
          task.state,
          task.cycleCount,
          task.failureReason,
          task.gerritChangeId,
          task.currentPatchset,
          now.toISOString(),
          now.toISOString()
        );
      }
    });

    transaction();
    console.log("[Playwright Setup] Created 3 test tasks");
    db.close();

  } catch (error) {
    console.error("[Playwright Setup] Error seeding data:", error);
    throw error;
  }
}

export default seedTestData;

