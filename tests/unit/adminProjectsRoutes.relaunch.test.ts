import { describe, it, expect, vi } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  registerProjectRoutes,
  type ProjectsRouteDeps,
  type ProjectsRouteStore,
} from "../../src/admin/adminProjectsRoutes.js";
import { Router } from "../../src/admin/router.js";
import {
  makeAgentId,
  makeProjectId,
  makeTaskId,
  makeTicketId,
  type AgentRecord,
  type ProjectRecord,
  type Task,
} from "../../src/interfaces.js";

function projectRecord(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  const now = new Date();
  return {
    id: makeProjectId("proj-1"),
    name: "Demo",
    type: "coding",
    agentId: makeAgentId("agent-1") as unknown as string,
    agentOverrideJson: null,
    postCloneScript: "",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as ProjectRecord;
}

function failedTask(taskId: string): Task {
  const now = new Date();
  return {
    taskId: makeTaskId(taskId),
    ticketId: makeTicketId("TCK-1"),
    ticketSourceLabel: "redmine-1",
    ticketTitle: "t",
    ticketDescription: "d",
    state: "FAILED",
    taskType: "code-gen",
    externalChangeId: null,
    currentPatchset: 0,
    reviewedPatchset: null,
    cycleCount: 0,
    failureReason: "misconfig",
    ticketUrl: null,
    reviewUrl: null,
    projectId: makeProjectId("proj-1"),
    displayId: null,
    pushRef: null,
    createdAt: now,
    updatedAt: now,
  } as Task;
}

interface MockStoreState {
  failedTasks: Task[];
  retryTask: ReturnType<typeof vi.fn>;
  getFailedTasksForProject: ReturnType<typeof vi.fn>;
}

function makeStore(
  state: MockStoreState,
  opts: { project?: ProjectRecord; agent?: AgentRecord | null } = {}
): ProjectsRouteStore {
  const project = opts.project ?? projectRecord();
  return {
    createProject: vi.fn(async () => project),
    getProjectById: vi.fn(async () => project),
    listProjects: vi.fn(async () => [project]),
    updateProject: vi.fn(async () => project),
    updateProjectConfiguration: vi.fn(async () => project),
    deleteProject: vi.fn(),
    setProjectEnabled: vi.fn(),
    setProjectTicketSource: vi.fn(async () => ({}) as never),
    getProjectTicketSource: vi.fn(async () => ({
      id: 1,
      projectId: project.id,
      integrationId: "redmine-1",
      ticketProjectKey: "demo",
      createdAt: new Date(),
    }) as never),
    replaceProjectPushTargets: vi.fn(async () => []),
    listProjectPushTargets: vi.fn(async () => []),
    setProjectReviewConfig: vi.fn(),
    getProjectReviewConfig: vi.fn(async () => null),
    getAgentById: vi.fn(async () => opts.agent ?? null),
    findProjectByTicketSource: vi.fn(async () => null),
    getFailedTasksForProject: state.getFailedTasksForProject,
    retryTask: state.retryTask,
  } as unknown as ProjectsRouteStore;
}

function mockRequest(body: unknown): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]);
  return stream as unknown as IncomingMessage;
}

function mockResponse(): { res: ServerResponse; done: Promise<void>; getStatus: () => number } {
  let status = 0;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  const res = {
    set statusCode(v: number) { status = v; },
    get statusCode() { return status; },
    setHeader: () => {},
    end: () => { resolveDone(); },
  } as unknown as ServerResponse;
  return { res, done, getStatus: () => status };
}

async function dispatchProjects(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  deps: ProjectsRouteDeps
): Promise<boolean> {
  const router = new Router();
  registerProjectRoutes(router, deps);
  return router.dispatch(req, res, path, method);
}

describe("adminProjectsRoutes — automatic relaunch of failed tasks", () => {
  it("relaunches FAILED tasks when a coding project's ticket source is reconfigured", async () => {
    const tasks = [failedTask("task-a"), failedTask("task-b")];
    const state: MockStoreState = {
      failedTasks: tasks,
      retryTask: vi.fn(async (id) => failedTask(String(id))),
      getFailedTasksForProject: vi.fn(async () => tasks),
    };
    const store = makeStore(state);
    const taskControl = { retryTask: vi.fn(async () => {}) };

    const { res, done } = mockResponse();
    const handled = await dispatchProjects(
      mockRequest({ ticketSource: { integrationId: "redmine-2", ticketProjectKey: "demo" } }),
      res,
      "/api/admin/projects/proj-1",
      "PUT",
      { projectStore: store, taskControl }
    );
    await done;

    expect(handled).toBe(true);
    expect(state.getFailedTasksForProject).toHaveBeenCalledWith(makeProjectId("proj-1"));
    expect(state.retryTask).toHaveBeenCalledTimes(2);
    expect(taskControl.retryTask).toHaveBeenCalledTimes(2);
    expect(taskControl.retryTask).toHaveBeenCalledWith(makeTaskId("task-a"));
    expect(taskControl.retryTask).toHaveBeenCalledWith(makeTaskId("task-b"));
  });

  it("does not relaunch when PUT includes enabled:true on an already-enabled project", async () => {
    const state: MockStoreState = {
      failedTasks: [],
      retryTask: vi.fn(),
      getFailedTasksForProject: vi.fn(async () => []),
    };
    // project is already enabled
    const store = makeStore(state, { project: projectRecord({ enabled: true }) });
    const taskControl = { retryTask: vi.fn(async () => {}) };

    const { res, done } = mockResponse();
    await dispatchProjects(
      mockRequest({ enabled: true }),
      res,
      "/api/admin/projects/proj-1",
      "PUT",
      { projectStore: store, taskControl }
    );
    await done;

    expect(state.getFailedTasksForProject).not.toHaveBeenCalled();
    expect(taskControl.retryTask).not.toHaveBeenCalled();
  });

  it("does not relaunch when only the project name changes", async () => {
    const state: MockStoreState = {
      failedTasks: [],
      retryTask: vi.fn(),
      getFailedTasksForProject: vi.fn(async () => []),
    };
    const store = makeStore(state);
    const taskControl = { retryTask: vi.fn(async () => {}) };

    const { res, done } = mockResponse();
    await dispatchProjects(
      mockRequest({ name: "Renamed" }),
      res,
      "/api/admin/projects/proj-1",
      "PUT",
      { projectStore: store, taskControl }
    );
    await done;

    expect(state.getFailedTasksForProject).not.toHaveBeenCalled();
    expect(taskControl.retryTask).not.toHaveBeenCalled();
  });

  it("continues relaunching remaining tasks if one retry fails", async () => {
    const tasks = [failedTask("task-a"), failedTask("task-b")];
    const state: MockStoreState = {
      failedTasks: tasks,
      retryTask: vi.fn(async (id) => {
        if (String(id) === "task-a") throw new Error("boom");
        return failedTask(String(id));
      }),
      getFailedTasksForProject: vi.fn(async () => tasks),
    };
    const store = makeStore(state);
    const taskControl = { retryTask: vi.fn(async () => {}) };

    const { res, done } = mockResponse();
    await dispatchProjects(
      mockRequest({
        pushTargets: [
          {
            integrationId: "gerrit-1",
            repoKey: "repo",
            cloneUrl: "ssh://host/repo",
            targetBranch: "main",
            role: "primary",
            commitOrder: 1,
            localPath: ".",
          },
        ],
      }),
      res,
      "/api/admin/projects/proj-1",
      "PUT",
      { projectStore: store, taskControl }
    );
    await done;

    expect(state.retryTask).toHaveBeenCalledTimes(2);
    // task-a failed before reaching taskControl; task-b still relaunched.
    expect(taskControl.retryTask).toHaveBeenCalledTimes(1);
    expect(taskControl.retryTask).toHaveBeenCalledWith(makeTaskId("task-b"));
  });
});

describe("adminProjectsRoutes — relaunch on create", () => {
  const codingAgent = { id: makeAgentId("agent-1"), type: "coding" } as unknown as AgentRecord;

  function createBody(enabled: boolean): Record<string, unknown> {
    return {
      type: "coding",
      name: "App",
      agentId: "agent-1",
      enabled,
      ticketSource: { integrationId: "redmine-1", ticketProjectKey: "demo" },
      pushTargets: [
        {
          integrationId: "gerrit-1",
          repoKey: "repo",
          cloneUrl: "ssh://host/repo",
          targetBranch: "main",
          role: "primary",
          commitOrder: 1,
          localPath: ".",
        },
      ],
    };
  }

  it("relaunches FAILED tasks when an enabled coding project is created", async () => {
    const tasks = [failedTask("task-a")];
    const state: MockStoreState = {
      failedTasks: tasks,
      retryTask: vi.fn(async (id) => failedTask(String(id))),
      getFailedTasksForProject: vi.fn(async () => tasks),
    };
    const store = makeStore(state, { project: projectRecord({ enabled: true }), agent: codingAgent });
    const taskControl = { retryTask: vi.fn(async () => {}) };

    const { res, done } = mockResponse();
    await dispatchProjects(
      mockRequest(createBody(true)),
      res,
      "/api/admin/projects",
      "POST",
      { projectStore: store, taskControl }
    );
    await done;

    expect(state.getFailedTasksForProject).toHaveBeenCalledWith(makeProjectId("proj-1"));
    expect(taskControl.retryTask).toHaveBeenCalledTimes(1);
  });

  it("does not relaunch when the coding project is created disabled", async () => {
    const state: MockStoreState = {
      failedTasks: [],
      retryTask: vi.fn(),
      getFailedTasksForProject: vi.fn(async () => []),
    };
    const store = makeStore(state, { project: projectRecord({ enabled: false }), agent: codingAgent });
    const taskControl = { retryTask: vi.fn(async () => {}) };

    const { res, done } = mockResponse();
    await dispatchProjects(
      mockRequest(createBody(false)),
      res,
      "/api/admin/projects",
      "POST",
      { projectStore: store, taskControl }
    );
    await done;

    expect(state.getFailedTasksForProject).not.toHaveBeenCalled();
    expect(taskControl.retryTask).not.toHaveBeenCalled();
  });
});

describe("adminProjectsRoutes — relaunch on PATCH /enable", () => {
  it("relaunches FAILED tasks when re-enabling a previously-disabled project", async () => {
    const tasks = [failedTask("task-a"), failedTask("task-b")];
    const state: MockStoreState = {
      failedTasks: tasks,
      retryTask: vi.fn(async (id) => failedTask(String(id))),
      getFailedTasksForProject: vi.fn(async () => tasks),
    };
    const store = makeStore(state, { project: projectRecord({ enabled: false }) });
    const taskControl = { retryTask: vi.fn(async () => {}) };

    const { res } = mockResponse();
    await dispatchProjects(
      mockRequest({}),
      res,
      "/api/admin/projects/proj-1/enable",
      "PATCH",
      { projectStore: store, taskControl }
    );

    expect(store.setProjectEnabled).toHaveBeenCalledWith(makeProjectId("proj-1"), true);
    expect(state.getFailedTasksForProject).toHaveBeenCalledWith(makeProjectId("proj-1"));
    expect(state.retryTask).toHaveBeenCalledTimes(2);
    expect(taskControl.retryTask).toHaveBeenCalledTimes(2);
  });

  it("does not relaunch when enabling an already-enabled project", async () => {
    const state: MockStoreState = {
      failedTasks: [],
      retryTask: vi.fn(),
      getFailedTasksForProject: vi.fn(async () => []),
    };
    const store = makeStore(state, { project: projectRecord({ enabled: true }) });
    const taskControl = { retryTask: vi.fn(async () => {}) };

    const { res } = mockResponse();
    await dispatchProjects(
      mockRequest({}),
      res,
      "/api/admin/projects/proj-1/enable",
      "PATCH",
      { projectStore: store, taskControl }
    );

    expect(store.setProjectEnabled).toHaveBeenCalledWith(makeProjectId("proj-1"), true);
    expect(state.getFailedTasksForProject).not.toHaveBeenCalled();
  });
});
