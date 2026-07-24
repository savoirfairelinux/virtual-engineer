import { describe, expect, it } from "vitest";
import {
  makeAgentId as makeDomainAgentId,
  makeExternalChangeId as makeDomainExternalChangeId,
  makeProjectId as makeDomainProjectId,
  makeTaskId as makeDomainTaskId,
  makeTicketId as makeDomainTicketId,
  type TaskId as DomainTaskId,
} from "../../src/domain/identifiers.js";
import {
  CODE_GEN_STATES as DOMAIN_CODE_GEN_STATES,
  CODE_REVIEW_STATES as DOMAIN_CODE_REVIEW_STATES,
  TASK_STATES as DOMAIN_TASK_STATES,
  TERMINAL_STATES as DOMAIN_TERMINAL_STATES,
  type ChangePerRepository as DomainChangePerRepository,
  type StateTransition as DomainStateTransition,
  type Task as DomainTask,
} from "../../src/domain/tasks.js";
import {
  CODE_GEN_STATES,
  CODE_REVIEW_STATES,
  TASK_STATES,
  TERMINAL_STATES,
  makeAgentId,
  makeExternalChangeId,
  makeProjectId,
  makeTaskId,
  makeTicketId,
  type ChangePerRepository,
  type StateTransition,
  type Task,
  type TaskId,
} from "../../src/interfaces.js";

describe("task domain compatibility", () => {
  it("re-exports identifier makers through the interfaces facade", () => {
    expect(makeTaskId).toBe(makeDomainTaskId);
    expect(makeTicketId).toBe(makeDomainTicketId);
    expect(makeExternalChangeId).toBe(makeDomainExternalChangeId);
    expect(makeAgentId).toBe(makeDomainAgentId);
    expect(makeProjectId).toBe(makeDomainProjectId);
  });

  it("re-exports the same task-state runtime values", () => {
    expect(CODE_GEN_STATES).toBe(DOMAIN_CODE_GEN_STATES);
    expect(CODE_REVIEW_STATES).toBe(DOMAIN_CODE_REVIEW_STATES);
    expect(TASK_STATES).toBe(DOMAIN_TASK_STATES);
    expect(TERMINAL_STATES).toBe(DOMAIN_TERMINAL_STATES);
  });

  it("keeps facade and domain task types interchangeable", () => {
    const taskId: DomainTaskId = makeTaskId("task-1");
    const facadeTaskId: TaskId = taskId;
    const task: DomainTask = {
      taskId,
      ticketId: makeTicketId("ticket-1"),
      ticketSourceLabel: "redmine:integration-1",
      ticketTitle: "Title",
      ticketDescription: "Description",
      state: "DETECTED",
      taskType: "code-gen",
      externalChangeId: null,
      currentPatchset: 0,
      reviewedPatchset: null,
      cycleCount: 0,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      failureReason: null,
      ticketUrl: null,
      reviewUrl: null,
      displayId: "1",
    };
    const facadeTask: Task = task;
    const change: DomainChangePerRepository = {
      id: "change-1",
      taskId,
      repoKey: "team/repo",
      changeId: "I123",
      reviewUrl: null,
      status: "OPEN",
      integrationId: "integration-1",
      reviewSystem: "gerrit",
      commitIndex: 0,
      subjectHash: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const facadeChange: ChangePerRepository = change;
    const transition: DomainStateTransition = {
      id: 1,
      taskId,
      fromState: "DETECTED",
      toState: "CONTEXT_BUILDING",
      metadata: {},
      createdAt: new Date(0),
    };
    const facadeTransition: StateTransition = transition;

    expect(facadeTask.taskId).toBe(facadeTaskId);
    expect(facadeChange.taskId).toBe(taskId);
    expect(facadeTransition.toState).toBe("CONTEXT_BUILDING");
  });
});