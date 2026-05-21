import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { InvalidTransitionError } from "../../src/state/stateMachine.js";
import { makeTaskId, makeTicketId, makeExternalChangeId } from "../../src/interfaces.js";
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
      const originalGetTask = store.getTask.bind(store);
      let firstRead = true;

      store.getTask = (async (requestedTaskId) => {
        if (firstRead && requestedTaskId === taskId) {
          firstRead = false;
          return null;
        }
        return originalGetTask(requestedTaskId);
      }) as SqliteStateStore["getTask"];

      await expect(store.createTask(taskId, makeTicketId("missing-readback"))).rejects.toThrow(
        `Failed to create task ${taskId}`
      );
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
  });

  describe("updateAgentCycleCommitMessages", () => {
    it("updates commitMessages on a saved cycle", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("commit-msg-1"));

      const result = {
        status: "success" as const,
        modifiedFiles: ["src/main.ts"],
        summary: "Updated main",
        agentLogs: "",
        metadata: {},
      };
      await store.saveAgentCycle(taskId, 1, result);

      const commitMessages = {
        superproject: "feat: add feature\n\nChange-Id: I111",
        "core-lib": "feat: add core feature\n\nChange-Id: I222",
      };
      await store.updateAgentCycleCommitMessages(taskId, 1, commitMessages);

      const cycles = await store.getAgentCycles(taskId);
      expect(cycles[0]?.result.commitMessages).toEqual(commitMessages);
    });

    it("does nothing when cycle does not exist", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("commit-msg-2"));
      // Should not throw when no cycle exists
      await expect(store.updateAgentCycleCommitMessages(taskId, 99, { repo: "msg" })).resolves.not.toThrow();
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
});
