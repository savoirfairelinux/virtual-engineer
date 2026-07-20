import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { InvalidTransitionError } from "../../src/state/stateMachine.js";
import { makeTaskId, makeTicketId, makeExternalChangeId, makeProjectId } from "../../src/interfaces.js";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

function tempDbPath(): string {
  return join(tmpdir(), `ve-test-${randomUUID()}.db`);
}

describe("SqliteStateStore", () => {
  let store: SqliteStateStore;

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDbPath());
  });

  afterEach(() => {
    store.close();
  });

  describe("createTask", () => {
    it("creates a task in DETECTED state", async () => {
      const taskId = makeTaskId(randomUUID());
      const ticketId = makeTicketId("123");
      const task = await store.createTask(taskId, ticketId, "Human title", "Human description", "jira");

      expect(task.taskId).toBe(taskId);
      expect(task.ticketId).toBe(ticketId);
      expect(task.ticketSourceLabel).toBe("jira");
      expect(task.ticketTitle).toBe("Human title");
      expect(task.ticketDescription).toBe("Human description");
      expect(task.state).toBe("DETECTED");
      expect(task.cycleCount).toBe(0);
      expect(task.externalChangeId).toBeNull();
    });

    it("defaults ticket snapshot fields to empty strings when omitted", async () => {
      const taskId = makeTaskId(randomUUID());
      const ticketId = makeTicketId("123-empty");

      const task = await store.createTask(taskId, ticketId);

      expect(task.ticketSourceLabel).toBe("redmine");
      expect(task.ticketTitle).toBe("");
      expect(task.ticketDescription).toBe("");
    });

    it("can retrieve a created task by taskId", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("456"));
      const fetched = await store.getTask(taskId);
      expect(fetched?.taskId).toBe(taskId);
    });

    it("can retrieve a task by ticketId", async () => {
      const taskId = makeTaskId(randomUUID());
      const ticketId = makeTicketId("789");
      await store.createTask(taskId, ticketId);
      const fetched = await store.getTaskByTicketId(ticketId);
      expect(fetched?.taskId).toBe(taskId);
    });

    it("returns null for unknown taskId", async () => {
      const result = await store.getTask(makeTaskId("nonexistent"));
      expect(result).toBeNull();
    });

    it("returns the existing active task when a concurrent duplicate create occurs", async () => {
      const ticketId = makeTicketId("concurrent-1");
      const firstTaskId = makeTaskId(randomUUID());
      const secondTaskId = makeTaskId(randomUUID());

      const first = await store.createTask(firstTaskId, ticketId);
      const second = await store.createTask(secondTaskId, ticketId);

      expect(second.taskId).toBe(first.taskId);
      expect(second.ticketId).toBe(ticketId);
    });

    it("throws when the inserted task cannot be read back", async () => {
      const taskId = makeTaskId(randomUUID());
      // After the store refactor, createTask uses an internal closure getTask,
      // not the facade's store.getTask. Mock at the db layer instead.
      const db = (store as unknown as {
        db: { query: { tasks: { findFirst: (opts: unknown) => Promise<unknown> } } };
      }).db;
      const originalFindFirst = db.query.tasks.findFirst.bind(db.query.tasks);
      let firstRead = true;
      db.query.tasks.findFirst = async (opts: unknown) => {
        if (firstRead) {
          firstRead = false;
          return undefined;
        }
        return originalFindFirst(opts);
      };

      try {
        await expect(store.createTask(taskId, makeTicketId("missing-readback"))).rejects.toThrow(
          `Failed to create task ${taskId}`
        );
      } finally {
        db.query.tasks.findFirst = originalFindFirst;
      }
    });

    it("rethrows insert errors when there is no recoverable active task", async () => {
      const insertError = new Error("insert failed");
      const db = (store as unknown as {
        db: { insert: (table: unknown) => { values: (value: unknown) => Promise<void> } };
      }).db;
      const originalInsert = db.insert.bind(db);

      db.insert = () => ({
        values: async () => {
          throw insertError;
        },
      });

      await expect(store.createTask(makeTaskId(randomUUID()), makeTicketId("rethrow-1"))).rejects.toBe(insertError);

      db.insert = originalInsert;
    });

    it("rethrows non-unique insert errors even when an active task exists", async () => {
      // A genuine insert failure (disk full, NOT NULL/FK, corruption) must NOT
      // be masked as a "reuse" of an unrelated active task: only the unique
      // active-ticket index conflict (code SQLITE_CONSTRAINT_UNIQUE) recovers.
      const ticketId = makeTicketId("non-unique-1");
      await store.createTask(makeTaskId(randomUUID()), ticketId);

      const insertError = new Error("disk full");
      const db = (store as unknown as {
        db: { insert: (table: unknown) => { values: (value: unknown) => Promise<void> } };
      }).db;
      const originalInsert = db.insert.bind(db);
      db.insert = () => ({
        values: async () => {
          throw insertError;
        },
      });

      try {
        await expect(store.createTask(makeTaskId(randomUUID()), ticketId)).rejects.toBe(insertError);
      } finally {
        db.insert = originalInsert;
      }
    });

    it("reuses the active task when a newer terminal task exists for the ticket", async () => {
      const ticketId = makeTicketId("1993");
      const activeTaskId = makeTaskId(randomUUID());
      await store.createTask(activeTaskId, ticketId);

      // The partial unique index permits multiple terminal rows alongside one
      // active row. Insert a newer FAILED task directly so that the newest task
      // by createdAt is terminal while an older task is still active.
      const raw = (store as unknown as {
        raw: { prepare(sql: string): { run(...args: unknown[]): unknown } };
      }).raw;
      const laterSeconds = Math.floor(Date.now() / 1000) + 100;
      raw
        .prepare(
          `INSERT INTO tasks (task_id, ticket_id, state, created_at, updated_at)
           VALUES (?, ?, 'FAILED', ?, ?)`
        )
        .run(randomUUID(), ticketId, laterSeconds, laterSeconds);

      // A fresh create violates the active-ticket unique index; recovery must
      // return the active task instead of surfacing the constraint error.
      const result = await store.createTask(makeTaskId(randomUUID()), ticketId);
      expect(result.taskId).toBe(activeTaskId);
      expect(result.state).toBe("DETECTED");
    });

    it("allows the same bare ticket id to be active under two different projects", async () => {
      // Two projects bound to different repos under one integration may have
      // tickets that share a number. Active-task identity is (project_id,
      // ticket_id), so each project gets its own active task with no false reuse.
      const ticketId = makeTicketId("5");
      const p1 = makeProjectId("proj-a");
      const p2 = makeProjectId("proj-b");
      const t1 = makeTaskId(randomUUID());
      const t2 = makeTaskId(randomUUID());

      const first = await store.createTask(
        t1,
        ticketId,
        "A",
        "",
        "redmine:int-1",
        undefined,
        undefined,
        undefined,
        p1
      );
      const second = await store.createTask(
        t2,
        ticketId,
        "B",
        "",
        "redmine:int-1",
        undefined,
        undefined,
        undefined,
        p2
      );

      expect(first.taskId).toBe(t1);
      expect(second.taskId).toBe(t2);
      expect(second.taskId).not.toBe(first.taskId);
      expect(first.projectId).toBe(p1);
      expect(second.projectId).toBe(p2);

      // Project-scoped lookups resolve to the correct task, not the other's.
      const a = await store.getActiveTaskByTicketId(ticketId, p1);
      const b = await store.getActiveTaskByTicketId(ticketId, p2);
      expect(a?.taskId).toBe(t1);
      expect(b?.taskId).toBe(t2);
    });

    it("still rejects a second active task for the same (project, ticket)", async () => {
      // Within a single project the partial unique index must continue to permit
      // only one active task per ticket; a duplicate create recovers it.
      const ticketId = makeTicketId("7");
      const projectId = makeProjectId("proj-c");
      const first = await store.createTask(
        makeTaskId(randomUUID()),
        ticketId,
        "C",
        "",
        "redmine:int-1",
        undefined,
        undefined,
        undefined,
        projectId
      );
      const second = await store.createTask(
        makeTaskId(randomUUID()),
        ticketId,
        "C",
        "",
        "redmine:int-1",
        undefined,
        undefined,
        undefined,
        projectId
      );
      expect(second.taskId).toBe(first.taskId);
    });

  });

  describe("transition", () => {
    it("transitions DETECTED → CONTEXT_BUILDING", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("1"));
      const updated = await store.transition(taskId, "CONTEXT_BUILDING");
      expect(updated.state).toBe("CONTEXT_BUILDING");
    });

    it("is idempotent — same transition returns current task without error", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("2"));
      await store.transition(taskId, "CONTEXT_BUILDING");
      // Second call with same target state should not throw
      const result = await store.transition(taskId, "CONTEXT_BUILDING");
      expect(result.state).toBe("CONTEXT_BUILDING");
    });

    it("throws InvalidTransitionError for invalid transition", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("3"));
      await expect(store.transition(taskId, "DONE")).rejects.toThrow(InvalidTransitionError);
    });

    it("notifies onTaskTransition listeners after a successful transition", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("3b"));
      const seen: string[] = [];
      store.onTaskTransition((task) => seen.push(task.state));
      await store.transition(taskId, "CONTEXT_BUILDING");
      expect(seen).toEqual(["CONTEXT_BUILDING"]);
    });

    it("does not propagate a listener error to the caller of transition", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("3c"));
      store.onTaskTransition(() => {
        throw new Error("listener boom");
      });
      const updated = await store.transition(taskId, "CONTEXT_BUILDING");
      expect(updated.state).toBe("CONTEXT_BUILDING");
    });

    it("notifies onTaskTransition listeners from retryTask and abandonTask, not just transition()", async () => {
      const retriedId = makeTaskId(randomUUID());
      await store.createTask(retriedId, makeTicketId("3d"));
      const retrySeen: string[] = [];
      store.onTaskTransition((task) => retrySeen.push(task.state));
      await store.retryTask(retriedId);
      expect(retrySeen.length).toBe(1);

      const abandonedId = makeTaskId(randomUUID());
      await store.createTask(abandonedId, makeTicketId("3e"));
      const abandonSeen: string[] = [];
      store.onTaskTransition((task) => abandonSeen.push(task.state));
      await store.abandonTask(abandonedId);
      expect(abandonSeen).toEqual(["ABANDONED"]);
    });

    it("does not notify onTaskTransition listeners for pause/resume (same-state metadata rows)", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("3f"));
      const seen: string[] = [];
      store.onTaskTransition((task) => seen.push(task.state));
      await store.pauseTask(taskId);
      await store.resumeTask(taskId);
      expect(seen).toEqual([]);
    });

    it("persists transition history", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("4"));
      await store.transition(taskId, "CONTEXT_BUILDING");
      await store.transition(taskId, "AGENT_RUNNING");
      // Task should now be in AGENT_RUNNING
      const task = await store.getTask(taskId);
      expect(task?.state).toBe("AGENT_RUNNING");
    });

    it("returns transitions ordered by creation", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("4b"));
      await store.transition(taskId, "CONTEXT_BUILDING", { reason: "build context" });
      await store.transition(taskId, "AGENT_RUNNING", { cycle: 1 });

      const transitions = await store.getStateTransitions(taskId);

      expect(transitions).toHaveLength(2);
      expect(transitions[0]?.fromState).toBe("DETECTED");
      expect(transitions[0]?.toState).toBe("CONTEXT_BUILDING");
      expect(transitions[0]?.metadata).toEqual({ reason: "build context" });
      expect(transitions[1]?.fromState).toBe("CONTEXT_BUILDING");
      expect(transitions[1]?.toState).toBe("AGENT_RUNNING");
      expect(transitions[1]?.metadata).toEqual({ cycle: 1 });
    });

    it("throws for unknown task", async () => {
      await expect(
        store.transition(makeTaskId("ghost"), "CONTEXT_BUILDING")
      ).rejects.toThrow(/not found/);
    });
  });

  describe("getActiveTasks", () => {
    it("returns only non-terminal tasks", async () => {
      const id1 = makeTaskId(randomUUID());
      const id2 = makeTaskId(randomUUID());
      const id3 = makeTaskId(randomUUID());

      await store.createTask(id1, makeTicketId("a"));
      await store.createTask(id2, makeTicketId("b"));
      await store.createTask(id3, makeTicketId("c"));

      // Move id2 to DONE
      await store.transition(id2, "CONTEXT_BUILDING");
      await store.transition(id2, "AGENT_RUNNING");
      await store.transition(id2, "IN_REVIEW");
      await store.transition(id2, "MERGED");
      await store.transition(id2, "CLOSING");
      await store.transition(id2, "DONE");

      // Move id3 to FAILED
      await store.transition(id3, "FAILED");

      const active = await store.getActiveTasks();
      const activeIds = active.map((t) => t.taskId);
      expect(activeIds).toContain(id1);
      expect(activeIds).not.toContain(id2);
      expect(activeIds).not.toContain(id3);
    });

    it("excludes all terminal states including review states", async () => {
      const idActive = makeTaskId(randomUUID());
      const idAbandoned = makeTaskId(randomUUID());
      const idReviewDone = makeTaskId(randomUUID());
      const idReviewFailed = makeTaskId(randomUUID());

      await store.createTask(idActive, makeTicketId("act"));
      await store.createTask(idAbandoned, makeTicketId("abn"));

      await store.createReviewTask({
        taskId: idReviewDone,
        ticketId: makeTicketId("rd"),
        subject: "review done",
        changeId: makeExternalChangeId("I1"),
        patchset: 1,
      });
      await store.createReviewTask({
        taskId: idReviewFailed,
        ticketId: makeTicketId("rf"),
        subject: "review failed",
        changeId: makeExternalChangeId("I2"),
        patchset: 1,
      });

      // DETECTED → CONTEXT_BUILDING → AGENT_RUNNING → ABANDONED
      await store.transition(idAbandoned, "CONTEXT_BUILDING");
      await store.transition(idAbandoned, "AGENT_RUNNING");
      await store.transition(idAbandoned, "ABANDONED");

      // REVIEW_PENDING → REVIEW_RUNNING → REVIEW_COMMENTING → REVIEW_DONE
      await store.transition(idReviewDone, "REVIEW_RUNNING");
      await store.transition(idReviewDone, "REVIEW_COMMENTING");
      await store.transition(idReviewDone, "REVIEW_DONE");

      // REVIEW_PENDING → REVIEW_FAILED
      await store.transition(idReviewFailed, "REVIEW_FAILED");

      const active = await store.getActiveTasks();
      const activeIds = active.map((t) => t.taskId);
      expect(activeIds).toContain(idActive);
      expect(activeIds).not.toContain(idAbandoned);
      expect(activeIds).not.toContain(idReviewDone);
      expect(activeIds).not.toContain(idReviewFailed);
    });
  });

  describe("reconcileOrphanedActiveTasks", () => {
    it("fails tasks stuck in AGENT_RUNNING / REVIEW_RUNNING / REVIEW_COMMENTING and leaves other states alone", async () => {
      const idAgentRunning = makeTaskId(randomUUID());
      const idReviewRunning = makeTaskId(randomUUID());
      const idReviewCommenting = makeTaskId(randomUUID());
      const idContextBuilding = makeTaskId(randomUUID());
      const idDone = makeTaskId(randomUUID());

      await store.createTask(idAgentRunning, makeTicketId("ar"));
      await store.transition(idAgentRunning, "CONTEXT_BUILDING");
      await store.transition(idAgentRunning, "AGENT_RUNNING");

      await store.createReviewTask({
        taskId: idReviewRunning,
        ticketId: makeTicketId("rr"),
        subject: "review running",
        changeId: makeExternalChangeId("I3"),
        patchset: 1,
      });
      await store.transition(idReviewRunning, "REVIEW_RUNNING");

      await store.createReviewTask({
        taskId: idReviewCommenting,
        ticketId: makeTicketId("rc"),
        subject: "review commenting",
        changeId: makeExternalChangeId("I4"),
        patchset: 1,
      });
      await store.transition(idReviewCommenting, "REVIEW_RUNNING");
      await store.transition(idReviewCommenting, "REVIEW_COMMENTING");

      await store.createTask(idContextBuilding, makeTicketId("cb"));
      await store.transition(idContextBuilding, "CONTEXT_BUILDING");

      await store.createTask(idDone, makeTicketId("dn"));
      await store.transition(idDone, "CONTEXT_BUILDING");
      await store.transition(idDone, "AGENT_RUNNING");
      await store.transition(idDone, "IN_REVIEW");
      await store.transition(idDone, "MERGED");
      await store.transition(idDone, "CLOSING");
      await store.transition(idDone, "DONE");

      const count = await store.reconcileOrphanedActiveTasks();
      expect(count).toBe(3);

      expect((await store.getTask(idAgentRunning))?.state).toBe("FAILED");
      expect((await store.getTask(idReviewRunning))?.state).toBe("REVIEW_FAILED");
      expect((await store.getTask(idReviewCommenting))?.state).toBe("REVIEW_FAILED");
      // Not an "actively executing" state: left untouched.
      expect((await store.getTask(idContextBuilding))?.state).toBe("CONTEXT_BUILDING");
      // Already terminal: left untouched.
      expect((await store.getTask(idDone))?.state).toBe("DONE");
    });

    it("is a no-op when nothing is orphaned", async () => {
      const count = await store.reconcileOrphanedActiveTasks();
      expect(count).toBe(0);
    });
  });

  describe("getFailedTasksForProject", () => {
    it("returns both FAILED and REVIEW_FAILED tasks bound to the project", async () => {
      const projectId = makeProjectId(randomUUID());
      const idFailed = makeTaskId(randomUUID());
      const idReviewFailed = makeTaskId(randomUUID());
      const idActive = makeTaskId(randomUUID());
      const idOtherProject = makeTaskId(randomUUID());

      await store.createTask(idFailed, makeTicketId("f"));
      await store.createTask(idActive, makeTicketId("a"));
      await store.createReviewTask({
        taskId: idReviewFailed,
        ticketId: makeTicketId("rf"),
        subject: "review failed",
        changeId: makeExternalChangeId("Ifail"),
        patchset: 1,
      });
      await store.createTask(idOtherProject, makeTicketId("o"));

      await store.setTaskProjectId(idFailed, projectId);
      await store.setTaskProjectId(idActive, projectId);
      await store.setTaskProjectId(idReviewFailed, projectId);
      await store.setTaskProjectId(idOtherProject, makeProjectId(randomUUID()));

      await store.transition(idFailed, "FAILED");
      await store.transition(idReviewFailed, "REVIEW_FAILED");
      await store.transition(idOtherProject, "FAILED");

      const failed = await store.getFailedTasksForProject(projectId);
      const ids = failed.map((t) => t.taskId);

      expect(ids).toContain(idFailed);
      expect(ids).toContain(idReviewFailed);
      expect(ids).not.toContain(idActive);
      expect(ids).not.toContain(idOtherProject);
    });
  });

  describe("getAllTasks", () => {
    it("returns tasks in all states including DONE, FAILED, and ABANDONED", async () => {
      const idActive = makeTaskId(randomUUID());
      const idDone = makeTaskId(randomUUID());
      const idFailed = makeTaskId(randomUUID());
      const idAbandoned = makeTaskId(randomUUID());

      await store.createTask(idActive, makeTicketId("all-a"));
      await store.createTask(idDone, makeTicketId("all-b"));
      await store.createTask(idFailed, makeTicketId("all-c"));
      await store.createTask(idAbandoned, makeTicketId("all-d"));

      // Move idDone to DONE
      await store.transition(idDone, "CONTEXT_BUILDING");
      await store.transition(idDone, "AGENT_RUNNING");
      await store.transition(idDone, "IN_REVIEW");
      await store.transition(idDone, "MERGED");
      await store.transition(idDone, "CLOSING");
      await store.transition(idDone, "DONE");

      // Move idFailed to FAILED (from DETECTED)
      await store.transition(idFailed, "FAILED");

      // Move idAbandoned to ABANDONED via valid path: DETECTED → CONTEXT_BUILDING → AGENT_RUNNING → RETRY_CYCLE → AGENT_RUNNING → ABANDONED
      await store.transition(idAbandoned, "CONTEXT_BUILDING");
      await store.transition(idAbandoned, "AGENT_RUNNING");
      await store.transition(idAbandoned, "RETRY_CYCLE");
      await store.transition(idAbandoned, "AGENT_RUNNING");
      await store.transition(idAbandoned, "ABANDONED");

      const all = await store.getAllTasks();
      const allIds = all.map((t) => t.taskId);

      expect(allIds).toContain(idActive);
      expect(allIds).toContain(idDone);
      expect(allIds).toContain(idFailed);
      expect(allIds).toContain(idAbandoned);
    });

    it("returns tasks ordered by updatedAt descending", async () => {
      const id1 = makeTaskId(randomUUID());
      const id2 = makeTaskId(randomUUID());

      await store.createTask(id1, makeTicketId("order-a"));
      await store.createTask(id2, makeTicketId("order-b"));
      await store.transition(id1, "FAILED");

      const all = await store.getAllTasks();
      const idx1 = all.findIndex((t) => t.taskId === id1);
      const idx2 = all.findIndex((t) => t.taskId === id2);

      // id1 was updated (transitioned) after id2, so it should appear first
      expect(idx1).toBeLessThan(idx2);
    });
  });

  describe("updateGerritChangeId", () => {
    it("stores and retrieves gerrit change id", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("5"));
      const changeId = makeExternalChangeId("Iabcdef1234");
      await store.updateExternalChangeId(taskId, changeId, 1);
      const task = await store.getTask(taskId);
      expect(task?.externalChangeId).toBe(changeId);
      expect(task?.currentPatchset).toBe(1);
    });

    it("stores reviewUrl when provided", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("review-url-1"));
      const changeId = makeExternalChangeId("Ireviewurl1");
      await store.updateExternalChangeId(taskId, changeId, 2, "https://gerrit.example.com/c/project/+/12345");
      const task = await store.getTask(taskId);
      expect(task?.reviewUrl).toBe("https://gerrit.example.com/c/project/+/12345");
    });

    it("does not overwrite reviewUrl when omitted", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("review-url-2"));
      const changeId = makeExternalChangeId("Ireviewurl2");
      await store.updateExternalChangeId(taskId, changeId, 1, "https://gerrit.example.com/c/+/99");
      await store.updateExternalChangeId(taskId, changeId, 2);
      const task = await store.getTask(taskId);
      // reviewUrl should still be set from the first call
      expect(task?.reviewUrl).toBe("https://gerrit.example.com/c/+/99");
    });
  });

  describe("createTask with ticketUrl", () => {
    it("stores ticketUrl when provided", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("ticket-url-1"), "Title", "Desc", "gitlab-issue", "https://gitlab.example.com/issues/42");
      const task = await store.getTask(taskId);
      expect(task?.ticketUrl).toBe("https://gitlab.example.com/issues/42");
    });

    it("stores null ticketUrl when omitted", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("ticket-url-2"));
      const task = await store.getTask(taskId);
      expect(task?.ticketUrl).toBeNull();
    });
  });

  describe("incrementCycle", () => {
    it("increments cycle count correctly", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("6"));
      const c1 = await store.incrementCycle(taskId);
      const c2 = await store.incrementCycle(taskId);
      expect(c1).toBe(1);
      expect(c2).toBe(2);
    });

    it("throws when incrementing an unknown task", async () => {
      await expect(store.incrementCycle(makeTaskId("missing-task"))).rejects.toThrow(/Task not found/);
    });
  });

  describe("setFailureReason and failed-attempt counting", () => {
    it("persists the failure reason and counts FAILED plus ABANDONED tasks", async () => {
      const ticketId = makeTicketId("failed-1");
      const failedTaskId = makeTaskId(randomUUID());
      const abandonedTaskId = makeTaskId(randomUUID());

      await store.createTask(failedTaskId, ticketId);
      await store.setFailureReason(failedTaskId, "fatal error");
      await store.transition(failedTaskId, "FAILED");

      await store.createTask(abandonedTaskId, ticketId);
      await store.transition(abandonedTaskId, "CONTEXT_BUILDING");
      await store.transition(abandonedTaskId, "AGENT_RUNNING");
      await store.transition(abandonedTaskId, "ABANDONED");

      const failedTask = await store.getTask(failedTaskId);
      expect(failedTask?.failureReason).toBe("fatal error");
      await expect(store.getFailedAttemptCount(ticketId)).resolves.toBe(2);
    });
  });

  describe("comment deduplication", () => {
    it("tracks processed comment ids", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("7"));

      const before = await store.getProcessedCommentIds(taskId);
      expect(before.size).toBe(0);

      await store.markCommentProcessed(taskId, "comment-abc");
      await store.markCommentProcessed(taskId, "comment-def");

      const after = await store.getProcessedCommentIds(taskId);
      expect(after.has("comment-abc")).toBe(true);
      expect(after.has("comment-def")).toBe(true);
      expect(after.has("comment-xyz")).toBe(false);
    });
  });

  describe("posted-review-comment deduplication", () => {
    it("records posted comments and exposes their hashes", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("rev-1"));
      const changeId = makeExternalChangeId("owner/repo#1");

      expect((await store.getPostedReviewCommentHashes(taskId)).size).toBe(0);

      await store.markReviewCommentsPosted(taskId, changeId, [
        { commentHash: "hash-a", file: "src/a.ts", line: 10, message: "Issue A", severity: "error" },
        { commentHash: "hash-b", file: "src/b.ts", line: 20, message: "Issue B", severity: "warning", providerThreadId: "thread-b" },
      ]);

      const hashes = await store.getPostedReviewCommentHashes(taskId);
      expect(hashes.has("hash-a")).toBe(true);
      expect(hashes.has("hash-b")).toBe(true);

      const records = await store.getPostedReviewComments(taskId);
      expect(records).toHaveLength(2);
      const b = records.find((r) => r.commentHash === "hash-b");
      expect(b?.providerThreadId).toBe("thread-b");
      expect(b?.resolved).toBe(false);
    });

    it("ignores duplicate hashes for the same task", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("rev-2"));
      const changeId = makeExternalChangeId("owner/repo#2");

      await store.markReviewCommentsPosted(taskId, changeId, [
        { commentHash: "dup", file: "src/a.ts", line: 1, message: "first", severity: "error" },
      ]);
      await store.markReviewCommentsPosted(taskId, changeId, [
        { commentHash: "dup", file: "src/a.ts", line: 99, message: "second", severity: "error" },
      ]);

      const records = await store.getPostedReviewComments(taskId);
      expect(records).toHaveLength(1);
      expect(records[0]?.line).toBe(1);
    });

    it("marks a posted comment as resolved", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("rev-3"));
      const changeId = makeExternalChangeId("owner/repo#3");

      await store.markReviewCommentsPosted(taskId, changeId, [
        { commentHash: "h", file: "src/a.ts", line: 5, message: "resolve me", severity: "error" },
      ]);
      const [rec] = await store.getPostedReviewComments(taskId);
      expect(rec).toBeDefined();

      await store.markReviewCommentResolved(rec!.id);

      const [updated] = await store.getPostedReviewComments(taskId);
      expect(updated?.resolved).toBe(true);
    });
  });

  describe("thread-reply ledger", () => {
    it("records posted replies and exposes their handled hashes", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("reply-1"));
      const changeId = makeExternalChangeId("owner/repo#10");

      expect((await store.getHandledThreadReplyHashes(taskId)).size).toBe(0);

      await store.markThreadReplyPosted(taskId, changeId, [
        { threadId: "disc-1", handledCommentHash: "hash-1", replyMessage: "Thanks, fixed." },
        { threadId: "disc-2", handledCommentHash: "hash-2", replyMessage: "I disagree." },
      ]);

      const hashes = await store.getHandledThreadReplyHashes(taskId);
      expect(hashes.has("hash-1")).toBe(true);
      expect(hashes.has("hash-2")).toBe(true);
      expect(hashes.has("hash-3")).toBe(false);
    });

    it("ignores duplicate (threadId, handledCommentHash) pairs", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("reply-2"));
      const changeId = makeExternalChangeId("owner/repo#11");

      await store.markThreadReplyPosted(taskId, changeId, [
        { threadId: "disc-1", handledCommentHash: "dup", replyMessage: "first" },
      ]);
      await store.markThreadReplyPosted(taskId, changeId, [
        { threadId: "disc-1", handledCommentHash: "dup", replyMessage: "second" },
      ]);

      const hashes = await store.getHandledThreadReplyHashes(taskId);
      expect(hashes.size).toBe(1);
    });

    it("scopes handled hashes per task", async () => {
      const taskA = makeTaskId(randomUUID());
      const taskB = makeTaskId(randomUUID());
      await store.createTask(taskA, makeTicketId("reply-3a"));
      await store.createTask(taskB, makeTicketId("reply-3b"));
      const changeId = makeExternalChangeId("owner/repo#12");

      await store.markThreadReplyPosted(taskA, changeId, [
        { threadId: "disc-1", handledCommentHash: "only-a", replyMessage: "hi" },
      ]);

      expect((await store.getHandledThreadReplyHashes(taskA)).has("only-a")).toBe(true);
      expect((await store.getHandledThreadReplyHashes(taskB)).has("only-a")).toBe(false);
    });
  });

  describe("saveAgentCycle", () => {
    it("stores and retrieves agent cycle results", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("8"));

      const result = {
        status: "success" as const,
        modifiedFiles: ["src/foo.ts"],
        summary: "Added foo",
        agentLogs: "log output",
        metadata: {},
      };

      await store.saveAgentCycle(taskId, 1, result);

      const cycles = await store.getAgentCycles(taskId);
      expect(cycles).toHaveLength(1);
      expect(cycles[0]?.result.status).toBe("success");
      expect(cycles[0]?.result.modifiedFiles).toEqual(["src/foo.ts"]);
    });

    it("gracefully handles corrupt stored cycle payloads", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("9"));

      const raw = (store as unknown as { raw: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).raw;
      raw.prepare(
        "INSERT INTO agent_cycles (task_id, cycle_number, agent_result, validation_result, created_at) VALUES (?, ?, ?, ?, ?)"
      ).run(taskId, 1, "{bad-json", "{bad-json", Date.now());

      const cycles = await store.getAgentCycles(taskId);
      expect(cycles[0]?.result.summary).toBe("[corrupt cycle data]");
      expect(cycles[0]?.validationResult).toBeNull();
    });

    it("computes and persists cycle cost from assistant.usage events", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("cost-1"));
      const result = {
        status: "success" as const,
        modifiedFiles: [],
        summary: "done",
        agentLogs: "",
        agentEvents: [
          {
            type: "assistant.usage",
            timestamp: "2026-01-01T00:00:00.000Z",
            data: { apiCallId: "req-1", totalNanoAiu: 2_000_000_000, cost: 1.5, inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 7, model: "gpt-test" },
            taskId: String(taskId),
            cycleNumber: 1,
          },
          {
            type: "assistant.usage",
            timestamp: "2026-01-01T00:01:00.000Z",
            data: { apiCallId: "req-2", totalNanoAiu: 1_000_000_000, cost: 0.5, inputTokens: 40, outputTokens: 10, model: "gpt-test" },
            taskId: String(taskId),
            cycleNumber: 1,
          },
        ],
        metadata: {},
      };
      await store.saveAgentCycle(taskId, 1, result);

      const cycles = await store.getAgentCycles(taskId);
      const cost = cycles[0]?.cost;
      expect(cost).toBeDefined();
      expect(cost?.priced).toBe(true);
      expect(cost?.aiCredits).toBe(3);
      expect(cost?.usd).toBeCloseTo(0.03, 10);
      expect(cost?.premiumRequests).toBeCloseTo(2.0, 10);
      expect(cost?.tokens.input).toBe(140);
      expect(cost?.tokens.output).toBe(30);
      expect(cost?.tokens.cached).toBe(5);
      expect(cost?.tokens.cacheWrite).toBe(7);
      expect(cost?.modelId).toBe("gpt-test");
    });

    it("recomputes legacy cycle cost from the agent_events column when the result JSON omits events", async () => {
      const dbPath = tempDbPath();
      let localStore = await SqliteStateStore.create(dbPath);
      const taskId = makeTaskId(randomUUID());
      await localStore.createTask(taskId, makeTicketId("cost-legacy"));
      const events = [
        {
          type: "assistant.usage",
          timestamp: "2026-01-01T00:00:00.000Z",
          data: { apiCallId: "req-1", totalNanoAiu: 2_000_000_000, cost: 1.5, inputTokens: 100, outputTokens: 20, model: "gpt-test" },
          taskId: String(taskId),
          cycleNumber: 1,
        },
      ];
      await localStore.saveAgentCycle(taskId, 1, {
        status: "success",
        modifiedFiles: [],
        summary: "done",
        agentLogs: "",
        agentEvents: events,
        metadata: {},
      });
      localStore.close();

      // Simulate a legacy row: clear the cost snapshot and strip events from the
      // agentResult JSON so they survive only in the canonical agent_events column.
      const raw = new Database(dbPath);
      raw
        .prepare(
          `UPDATE agent_cycles SET cost_ai_credits = NULL, cost_usd = NULL, premium_requests = NULL, cost_input_tokens = NULL, cost_output_tokens = NULL, cost_cached_tokens = NULL, cost_cache_write_tokens = NULL, cost_model_id = NULL, agent_result = ? WHERE task_id = ?`
        )
        .run(
          JSON.stringify({ status: "success", modifiedFiles: [], summary: "done", agentLogs: "", metadata: {} }),
          String(taskId)
        );
      raw.close();

      localStore = await SqliteStateStore.create(dbPath);
      try {
        const cycles = await localStore.getAgentCycles(taskId);
        const cost = cycles[0]?.cost;
        expect(cost).toBeDefined();
        expect(cost?.priced).toBe(true);
        expect(cost?.aiCredits).toBe(2);
        expect(cost?.usd).toBeCloseTo(0.02, 10);
        expect(cost?.tokens.input).toBe(100);
        expect(cost?.tokens.output).toBe(20);
        expect(cost?.modelId).toBe("gpt-test");
      } finally {
        localStore.close();
      }
    });

    it("persists an estimated USD cost from the premium-request multiplier when nano-AIU is absent", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("cost-est"));
      const result = {
        status: "success" as const,
        modifiedFiles: [],
        summary: "done",
        agentLogs: "",
        agentEvents: [
          {
            type: "assistant.usage",
            timestamp: "2026-01-01T00:00:00.000Z",
            data: { cost: 0.5, inputTokens: 100, outputTokens: 20, model: "gpt-est" },
            taskId: String(taskId),
            cycleNumber: 1,
          },
        ],
        metadata: {},
      };
      await store.saveAgentCycle(taskId, 1, result);

      const cycles = await store.getAgentCycles(taskId);
      const cost = cycles[0]?.cost;
      expect(cost?.priced).toBe(false);
      expect(cost?.usd).toBeCloseTo(0.02, 10);
      expect(cost?.aiCredits).toBe(0);
      expect(cost?.premiumRequests).toBeCloseTo(0.5, 10);
    });

    it("recomputes cost for legacy cycles persisted without cost columns", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("cost-2"));
      const raw = (store as unknown as { raw: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).raw;
      const events = JSON.stringify([
        {
          type: "assistant.usage",
          timestamp: "2026-01-01T00:00:00.000Z",
          data: { totalNanoAiu: 5_000_000_000, inputTokens: 12, outputTokens: 4 },
          taskId: String(taskId),
          cycleNumber: 1,
        },
      ]);
      const agentResult = JSON.stringify({ status: "success", modifiedFiles: [], summary: "legacy", agentLogs: "", agentEvents: JSON.parse(events), metadata: {} });
      raw.prepare(
        "INSERT INTO agent_cycles (task_id, cycle_number, agent_result, validation_result, agent_events, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(taskId, 1, agentResult, null, events, Date.now());

      const cycles = await store.getAgentCycles(taskId);
      expect(cycles[0]?.cost?.priced).toBe(true);
      expect(cycles[0]?.cost?.aiCredits).toBe(5);
    });
  });

  describe("getAgentCycleEvents", () => {
      it("returns empty array when no events are stored", async () => {
        const taskId = makeTaskId(randomUUID());
        await store.createTask(taskId, makeTicketId("10"));
        const result = {
          status: "success" as const,
          modifiedFiles: [],
          summary: "done",
          agentLogs: "",
          metadata: {},
        };
        await store.saveAgentCycle(taskId, 1, result);
        const events = await store.getAgentCycleEvents(taskId, 1);
        expect(events).toEqual([]);
      });

      it("persists and retrieves agentEvents from saveAgentCycle", async () => {
        const taskId = makeTaskId(randomUUID());
        await store.createTask(taskId, makeTicketId("11"));
        const agentEvents = [
          {
            type: "tool.execution_start",
            timestamp: "2026-01-01T00:00:00.000Z",
            data: { tool: "readFile" },
            taskId: String(taskId),
            cycleNumber: 1,
          },
        ];
        const result = {
          status: "success" as const,
          modifiedFiles: [],
          summary: "done",
          agentLogs: "",
          agentEvents,
          metadata: {},
        };
        await store.saveAgentCycle(taskId, 1, result);
        const retrieved = await store.getAgentCycleEvents(taskId, 1);
        expect(retrieved).toHaveLength(1);
        expect(retrieved[0]?.type).toBe("tool.execution_start");
        expect(retrieved[0]?.taskId).toBe(String(taskId));
      });
    });

  describe("changePerRepository CRUD", () => {
    it("saves and retrieves per-repo changes", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("repo-1"));

      await store.saveChangePerRepository(taskId, "superproject", "I111", "http://gerrit/c/I111", "OPEN");
      await store.saveChangePerRepository(taskId, "core-lib", "I222", "http://gerrit/c/I222", "OPEN");

      const changes = await store.getChangesForTask(taskId);
      expect(changes).toHaveLength(2);
      expect(changes[0]?.repoKey).toBe("superproject");
      expect(changes[0]?.changeId).toBe("I111");
      expect(changes[0]?.status).toBe("OPEN");
      expect(changes[1]?.repoKey).toBe("core-lib");
    });

    it("upserts existing per-repo change", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("repo-2"));

      await store.saveChangePerRepository(taskId, "superproject", "I111", "http://gerrit/c/I111", "OPEN");
      await store.saveChangePerRepository(taskId, "superproject", "I111-v2", "http://gerrit/c/I111-v2", "OPEN");

      const changes = await store.getChangesForTask(taskId);
      expect(changes).toHaveLength(1);
      expect(changes[0]?.changeId).toBe("I111-v2");
      expect(changes[0]?.reviewUrl).toBe("http://gerrit/c/I111-v2");
    });

    it("updates per-repo change status", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("repo-3"));

      await store.saveChangePerRepository(taskId, "superproject", "I111", null, "OPEN");

      await store.updateChangePerRepositoryStatus(taskId, "superproject", "MERGED");

      const changes = await store.getChangesForTask(taskId);
      expect(changes[0]?.status).toBe("MERGED");
    });

    it("returns empty array when no changes exist", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("repo-4"));

      const changes = await store.getChangesForTask(taskId);
      expect(changes).toHaveLength(0);
    });

    it("saves and retrieves commitIndex and subjectHash", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("repo-5"));

      await store.saveChangePerRepository(taskId, "superproject", "I111", null, "OPEN", "", "gerrit", 1, "hash-aaa");
      await store.saveChangePerRepository(taskId, "superproject", "I222", null, "OPEN", "", "gerrit", 2, "hash-bbb");

      const changes = await store.getChangesForTask(taskId);
      expect(changes).toHaveLength(2);
      const sorted = changes.sort((a, b) => a.commitIndex - b.commitIndex);
      expect(sorted[0]?.commitIndex).toBe(1);
      expect(sorted[0]?.subjectHash).toBe("hash-aaa");
      expect(sorted[0]?.changeId).toBe("I111");
      expect(sorted[1]?.commitIndex).toBe(2);
      expect(sorted[1]?.subjectHash).toBe("hash-bbb");
    });

    it("updateChangePerRepositoryStatus targets specific row by changeId", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("repo-6"));

      await store.saveChangePerRepository(taskId, "superproject", "I111", null, "OPEN", "", "gerrit", 1, "h1");
      await store.saveChangePerRepository(taskId, "superproject", "I222", null, "OPEN", "", "gerrit", 2, "h2");

      // Update only the second commit by changeId
      await store.updateChangePerRepositoryStatus(taskId, "superproject", "MERGED", "I222");

      const changes = await store.getChangesForTask(taskId);
      const sorted = changes.sort((a, b) => a.commitIndex - b.commitIndex);
      expect(sorted[0]?.status).toBe("OPEN");
      expect(sorted[1]?.status).toBe("MERGED");
    });

    it("orphanExcessChanges marks rows beyond maxCommitIndex as ORPHANED", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("repo-orphan"));

      await store.saveChangePerRepository(taskId, "root", "I000", null, "OPEN", "", "gerrit", 0, "h0");
      await store.saveChangePerRepository(taskId, "root", "I001", null, "OPEN", "", "gerrit", 1, "h1");
      await store.saveChangePerRepository(taskId, "root", "I002", null, "OPEN", "", "gerrit", 2, "h2");

      // Retry produced only 1 commit (index 0), so orphan indices > 0
      const count = await store.orphanExcessChanges(taskId, "root", 0);
      expect(count).toBe(2);

      const changes = await store.getChangesForTask(taskId);
      const sorted = changes.sort((a, b) => a.commitIndex - b.commitIndex);
      expect(sorted[0]?.status).toBe("OPEN");
      expect(sorted[1]?.status).toBe("ORPHANED");
      expect(sorted[2]?.status).toBe("ORPHANED");
    });

    it("orphanExcessChanges skips already-terminal rows", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("repo-orphan-skip"));

      await store.saveChangePerRepository(taskId, "root", "I000", null, "OPEN", "", "gerrit", 0, "h0");
      await store.saveChangePerRepository(taskId, "root", "I001", null, "MERGED", "", "gerrit", 1, "h1");
      await store.saveChangePerRepository(taskId, "root", "I002", null, "OPEN", "", "gerrit", 2, "h2");

      // Orphan indices > 0: row at index 1 is MERGED so should be skipped
      const count = await store.orphanExcessChanges(taskId, "root", 0);
      expect(count).toBe(1);

      const changes = await store.getChangesForTask(taskId);
      const sorted = changes.sort((a, b) => a.commitIndex - b.commitIndex);
      expect(sorted[0]?.status).toBe("OPEN");
      expect(sorted[1]?.status).toBe("MERGED");  // untouched
      expect(sorted[2]?.status).toBe("ORPHANED");
    });
  });

  describe("abandonTask", () => {
    it("transitions a task to ABANDONED state", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("abandon-1"));
      await store.transition(taskId, "CONTEXT_BUILDING");
      await store.transition(taskId, "AGENT_RUNNING");

      const result = await store.abandonTask(taskId);
      expect(result.state).toBe("ABANDONED");

      const fetched = await store.getTask(taskId);
      expect(fetched?.state).toBe("ABANDONED");
    });

    it("records a state transition for the abandon action", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("abandon-2"));
      await store.transition(taskId, "CONTEXT_BUILDING");

      await store.abandonTask(taskId);

      const transitions = await store.getStateTransitions(taskId);
      const abandonTransition = transitions.find((t) => t.toState === "ABANDONED");
      expect(abandonTransition).toBeDefined();
      expect(abandonTransition?.fromState).toBe("CONTEXT_BUILDING");
      expect(abandonTransition?.metadata).toEqual({ action: "abandon" });
    });

    it("throws when the task does not exist", async () => {
      await expect(store.abandonTask(makeTaskId("no-such-task"))).rejects.toThrow(/Task not found/);
    });
  });

  describe("deleteTask", () => {
    it("removes a terminal-state task and all its records", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("delete-1"));
      await store.transition(taskId, "FAILED");

      await store.deleteTask(taskId);

      const fetched = await store.getTask(taskId);
      expect(fetched).toBeNull();
    });

    it("removes per-repo changes, cycles, and transitions along with the task", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("delete-2"));

      await store.saveChangePerRepository(taskId, "superproject", "I111", null, "OPEN");
      await store.saveAgentCycle(taskId, 1, {
        status: "success" as const,
        modifiedFiles: [],
        summary: "ok",
        agentLogs: "",
        metadata: {},
      });
      await store.transition(taskId, "CONTEXT_BUILDING");
      await store.transition(taskId, "FAILED");

      await store.deleteTask(taskId);

      const fetched = await store.getTask(taskId);
      expect(fetched).toBeNull();

      const changes = await store.getChangesForTask(taskId);
      expect(changes).toHaveLength(0);
    });

    it("auto-abandons a non-terminal-state task without removing the row", async () => {
      // Fully deleting an active task would allow the polling loop to re-detect
      // the open ticket and spin up a replacement task. By only transitioning to
      // ABANDONED the polling loop's "already abandoned" guard prevents re-queuing.
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("delete-3"));
      await store.transition(taskId, "CONTEXT_BUILDING");
      await store.transition(taskId, "AGENT_RUNNING");
      await store.transition(taskId, "IN_REVIEW");

      await store.deleteTask(taskId);

      const fetched = await store.getTask(taskId);
      expect(fetched).not.toBeNull();
      expect(fetched?.state).toBe("ABANDONED");
    });

    it("fully removes a non-terminal-state task when delete is called twice", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("delete-3b"));
      await store.transition(taskId, "CONTEXT_BUILDING");
      await store.transition(taskId, "AGENT_RUNNING");

      // First delete: transitions to ABANDONED
      await store.deleteTask(taskId);
      expect((await store.getTask(taskId))?.state).toBe("ABANDONED");

      // Second delete: task is now terminal (ABANDONED) → fully removed
      await store.deleteTask(taskId);
      expect(await store.getTask(taskId)).toBeNull();
    });

    it("throws when the task does not exist", async () => {
      await expect(store.deleteTask(makeTaskId("ghost-task"))).rejects.toThrow(/Task not found/);
    });

    it("can delete an ABANDONED task after abandonTask", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("delete-abandon-1"));
      await store.transition(taskId, "CONTEXT_BUILDING");
      await store.transition(taskId, "AGENT_RUNNING");
      await store.abandonTask(taskId);

      await expect(store.deleteTask(taskId)).resolves.not.toThrow();
      expect(await store.getTask(taskId)).toBeNull();
    });
  });

  describe("createReviewTask unique-index regression", () => {
    it("allows a new review task for the same change after REVIEW_DONE", async () => {
      const changeId = makeExternalChangeId("Iabc123");
      const ticketId = makeTicketId("gerrit:12345");

      const firstId = makeTaskId("review-first");
      await store.createReviewTask({
        taskId: firstId,
        ticketId,
        subject: "First review",
        changeId,
        patchset: 1,
      });
      // Drive to REVIEW_DONE (terminal state)
      await store.transition(firstId, "REVIEW_RUNNING");
      await store.transition(firstId, "REVIEW_COMMENTING");
      await store.transition(firstId, "REVIEW_WATCHING");
      await store.transition(firstId, "REVIEW_DONE");

      // A second review task for the same change (new patchset) must not throw
      const secondId = makeTaskId("review-second");
      const second = await store.createReviewTask({
        taskId: secondId,
        ticketId,
        subject: "Second review",
        changeId,
        patchset: 2,
      });

      expect(second.taskId).toBe(secondId);
      expect(second.state).toBe("REVIEW_PENDING");
    });

    it("allows a new review task for the same change after REVIEW_FAILED", async () => {
      const changeId = makeExternalChangeId("Idef456");
      const ticketId = makeTicketId("gerrit:67890");

      const firstId = makeTaskId("review-failed-first");
      await store.createReviewTask({
        taskId: firstId,
        ticketId,
        subject: "Failed review",
        changeId,
        patchset: 1,
      });
      await store.transition(firstId, "REVIEW_RUNNING");
      await store.transition(firstId, "REVIEW_FAILED");

      const secondId = makeTaskId("review-failed-second");
      const second = await store.createReviewTask({
        taskId: secondId,
        ticketId,
        subject: "Retry review",
        changeId,
        patchset: 1,
      });

      expect(second.taskId).toBe(secondId);
      expect(second.state).toBe("REVIEW_PENDING");
    });
  });

  describe("setTaskPushRef", () => {
    it("defaults pushRef to null for newly created tasks", async () => {
      const taskId = makeTaskId(randomUUID());
      const ticketId = makeTicketId("push-ref-default");
      const task = await store.createTask(taskId, ticketId, "Title", "Desc", "jira");
      expect(task.pushRef ?? null).toBeNull();
    });

    it("persists pushRef and exposes it on reads", async () => {
      const taskId = makeTaskId(randomUUID());
      const ticketId = makeTicketId("push-ref-set");
      await store.createTask(taskId, ticketId, "Title", "Desc", "jira");

      await store.setTaskPushRef(taskId, "feature/abcd1234-add-login");

      const reloaded = await store.getTask(taskId);
      expect(reloaded?.pushRef).toBe("feature/abcd1234-add-login");
    });

    it("overwrites a previously stored pushRef", async () => {
      const taskId = makeTaskId(randomUUID());
      const ticketId = makeTicketId("push-ref-overwrite");
      await store.createTask(taskId, ticketId, "Title", "Desc", "jira");

      await store.setTaskPushRef(taskId, "feature/old");
      await store.setTaskPushRef(taskId, "feature/new");

      const reloaded = await store.getTask(taskId);
      expect(reloaded?.pushRef).toBe("feature/new");
    });
  });
});

describe("SqliteStateStore — retryTask resets by task type", () => {
  let store: SqliteStateStore;

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDbPath());
  });

  afterEach(() => {
    store.close();
  });

  it("resets a failed code-review task to REVIEW_PENDING so runReview can pick it up again", async () => {
    const taskId = makeTaskId(randomUUID());
    await store.createReviewTask({
      taskId,
      ticketId: makeTicketId("rf"),
      subject: "review failed",
      changeId: makeExternalChangeId("Iabc"),
      patchset: 1,
    });
    await store.transition(taskId, "REVIEW_RUNNING");
    await store.transition(taskId, "REVIEW_FAILED");

    const retried = await store.retryTask(taskId);

    expect(retried.state).toBe("REVIEW_PENDING");
    expect(retried.cycleCount).toBe(0);
    expect(retried.failureReason ?? null).toBeNull();

    const transitions = await store.getStateTransitions(taskId);
    const last = transitions[transitions.length - 1];
    expect(last?.fromState).toBe("REVIEW_FAILED");
    expect(last?.toState).toBe("REVIEW_PENDING");
    expect(last?.metadata).toMatchObject({ action: "retry" });
  });

  it("still resets a failed code-gen task to DETECTED", async () => {
    const taskId = makeTaskId(randomUUID());
    await store.createTask(taskId, makeTicketId("cg"), "title", "desc", "jira");
    await store.transition(taskId, "CONTEXT_BUILDING");
    await store.transition(taskId, "AGENT_RUNNING");
    await store.transition(taskId, "FAILED");

    const retried = await store.retryTask(taskId);

    expect(retried.state).toBe("DETECTED");
    expect(retried.cycleCount).toBe(0);

    const transitions = await store.getStateTransitions(taskId);
    const last = transitions[transitions.length - 1];
    expect(last?.fromState).toBe("FAILED");
    expect(last?.toState).toBe("DETECTED");
  });

  it("preserves cycle_count across retries so cycle numbers keep incrementing", async () => {
    const taskId = makeTaskId(randomUUID());
    await store.createTask(taskId, makeTicketId("cg2"), "title", "desc", "jira");
    await store.transition(taskId, "CONTEXT_BUILDING");
    await store.transition(taskId, "AGENT_RUNNING");
    // Simulate two completed agent cycles
    await store.incrementCycle(taskId); // cycleCount → 1
    await store.incrementCycle(taskId); // cycleCount → 2
    await store.transition(taskId, "FAILED");

    const retried = await store.retryTask(taskId);

    // cycle_count must NOT be reset to 0 — the next incrementCycle will yield 3.
    expect(retried.state).toBe("DETECTED");
    expect(retried.cycleCount).toBe(2);

    const afterIncrement = await store.incrementCycle(taskId);
    expect(afterIncrement).toBe(3);
  });
});
