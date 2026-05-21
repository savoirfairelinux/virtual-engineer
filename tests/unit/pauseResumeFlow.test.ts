import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import type { TaskId } from "../../src/interfaces.js";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { rmSync } from "fs";
import { makeTaskId, makeTicketId } from "../../src/interfaces.js";

describe("Pause/Resume Workflow", () => {
  let stateStore: SqliteStateStore;
  let testTaskId: TaskId;
  let dbPath: string;

  beforeEach(async () => {
    // Use temporary database file for tests
    dbPath = join(tmpdir(), `ve-pause-resume-${randomUUID()}.db`);

    // Create stateStore instance with automatic schema initialization
    stateStore = await SqliteStateStore.create(dbPath);

    // Create a test task
    testTaskId = makeTaskId(randomUUID());
    const ticketId = makeTicketId("test-ticket-1");
    await stateStore.createTask(
      testTaskId,
      ticketId,
      "Test Ticket",
      "Test Description",
      "test"
    );
  });

  afterEach(async () => {
    stateStore.close();
    try {
      rmSync(dbPath, { force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("should return false when task has no pause action", async () => {
    const isPaused = await stateStore.isTaskPaused(testTaskId);
    expect(isPaused).toBe(false);
  });

  it("should return true after pauseTask is called", async () => {
    await stateStore.pauseTask(testTaskId);
    const isPaused = await stateStore.isTaskPaused(testTaskId);
    expect(isPaused).toBe(true);
  });

  it("should return false after resumeTask is called following pauseTask", async () => {
    await stateStore.pauseTask(testTaskId);
    const pausedBeforeResume = await stateStore.isTaskPaused(testTaskId);
    expect(pausedBeforeResume).toBe(true);

    await stateStore.resumeTask(testTaskId);
    const pausedAfterResume = await stateStore.isTaskPaused(testTaskId);
    expect(pausedAfterResume).toBe(false);
  });

  it("should handle multiple pause/resume cycles", async () => {
    // Pause 1
    await stateStore.pauseTask(testTaskId);
    expect(await stateStore.isTaskPaused(testTaskId)).toBe(true);

    // Resume 1
    await stateStore.resumeTask(testTaskId);
    expect(await stateStore.isTaskPaused(testTaskId)).toBe(false);

    // Pause 2
    await stateStore.pauseTask(testTaskId);
    expect(await stateStore.isTaskPaused(testTaskId)).toBe(true);

    // Resume 2
    await stateStore.resumeTask(testTaskId);
    expect(await stateStore.isTaskPaused(testTaskId)).toBe(false);
  });

  it("should return false for non-existent task", async () => {
    const isPaused = await stateStore.isTaskPaused("non-existent-task" as any);
    expect(isPaused).toBe(false);
  });
});
