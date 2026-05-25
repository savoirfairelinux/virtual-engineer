import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("../../src/workspace/dockerVolume.js", () => ({
  createVolume: vi.fn(),
  removeVolume: vi.fn(),
  execInVolume: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
  listVeVolumes: vi.fn().mockResolvedValue([]),
}));

import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import type { ProjectModeDeps } from "../../src/orchestrator/orchestrator.js";
import {
  makeTaskId,
  makeTicketId,
  makeProjectId,
  makeAgentId,
  makeExternalChangeId,
  type AgentAdapter,
  type StateStore,
  type WorkspaceRunner,
  type TicketConnector,
  type AgentRecord,
  type ProjectRecord,
  type ProjectPushTargetRecord,
  type Task,
} from "../../src/interfaces.js";
import type { VcsConnector } from "../../src/vcs/vcsConnector.js";

function makeTask(over: Partial<Task> = {}): Task {
  return {
    taskId: makeTaskId("t-1"),
    ticketId: makeTicketId("42"),
    ticketSourceLabel: "redmine:int-1",
    ticketTitle: "Add X",
    ticketDescription: "do stuff",
    state: "AGENT_RUNNING",
    taskType: "code-gen",
    externalChangeId: null,
    currentPatchset: 0,
    reviewedPatchset: null,
    cycleCount: 0,
    failureReason: null,
    ticketUrl: null,
    reviewUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    projectId: makeProjectId("p-1"),
    repoSetId: null,
    ...over,
  } as Task;
}

function makeProject(): ProjectRecord {
  return {
    id: makeProjectId("p-1"),
    name: "P1",
    type: "coding",
    agentId: makeAgentId("a-1"),
    agentOverrideJson: null,
    postCloneScript: "",
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as ProjectRecord;
}

function makePushTarget(over: Partial<ProjectPushTargetRecord> & { id: number; commitOrder: number; localPath: string; integrationId: string; repoKey: string }): ProjectPushTargetRecord {
  return {
    id: over.id,
    projectId: makeProjectId("p-1"),
    integrationId: over.integrationId,
    repoKey: over.repoKey,
    cloneUrl: over.cloneUrl ?? `git@host:${over.repoKey}.git`,
    targetBranch: over.targetBranch ?? "main",
    role: over.role ?? "primary",
    commitOrder: over.commitOrder,
    localPath: over.localPath,
    sshKeyPath: over.sshKeyPath ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as ProjectPushTargetRecord;
}

function makeStateStore(over: Partial<StateStore> = {}): StateStore {
  return {
    createTask: vi.fn(async (taskId, ticketId, title, desc, label) =>
      makeTask({
        taskId,
        ticketId,
        ticketTitle: title ?? "",
        ticketDescription: desc ?? "",
        ticketSourceLabel: label ?? "redmine",
        state: "DETECTED",
        projectId: null,
      })
    ),
    getTask: vi.fn(),
    getTaskByTicketId: vi.fn().mockResolvedValue(null),
    getActiveTasks: vi.fn().mockResolvedValue([]),
    getFailedAttemptCount: vi.fn().mockResolvedValue(0),
    transition: vi.fn(async (taskId, to) => makeTask({ taskId, state: to })),
    incrementCycle: vi.fn().mockResolvedValue(1),
    setFailureReason: vi.fn(),
    saveAgentCycle: vi.fn(),
    updateAgentCycleCommitMessages: vi.fn(),
    getProcessedCommentIds: vi.fn().mockResolvedValue(new Set()),
    markCommentProcessed: vi.fn(),
    getAgentCycles: vi.fn().mockResolvedValue([]),
    getStateTransitions: vi.fn().mockResolvedValue([]),
    getChangesForTask: vi.fn().mockResolvedValue([]),
    saveChangePerRepository: vi.fn(),
    updateChangePerRepositoryStatus: vi.fn(),
    getActiveRepoSetLock: vi.fn().mockResolvedValue(null),
    setTaskProjectId: vi.fn(),
    setTaskPushRef: vi.fn(),
    setTaskRepoSetId: vi.fn(),
    updateGerritChangeId: vi.fn(),
    getRepositorySet: vi.fn().mockResolvedValue(null),
    findRepositorySetByTicketSourceId: vi.fn().mockResolvedValue(null),
    getTaskRepositoryContext: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as unknown as StateStore;
}

function makeWorkspaceRunner(over: Partial<WorkspaceRunner> = {}): WorkspaceRunner {
  return {
    createWorkspace: vi.fn().mockResolvedValue({
      taskId: makeTaskId("t-1"),
      containerId: "c1",
      volumeName: "v1",
      homeVolumeName: "h1",
      hostWorkspacePath: "/workspace",
      containerImage: "img:latest",
    }),
    cloneRepo: vi.fn().mockResolvedValue({ success: true, localPath: "/workspace" }),
    prepareProjectWorkspace: vi.fn().mockResolvedValue({ success: true, localPath: "/workspace" }),
    execGitInVolume: vi.fn().mockResolvedValue("1\n"),
    runAgent: vi.fn().mockResolvedValue({
      status: "success",
      modifiedFiles: ["src/a.ts"],
      summary: "ok",
      agentLogs: "",
      commits: [{ subject: "feat: x", repoKey: "root", changeId: "Iabc", body: "" }],
      gerritChangeId: makeExternalChangeId("Iabc"),
      metadata: {},
    }),
    destroyWorkspace: vi.fn(),
    ...over,
  } as unknown as WorkspaceRunner;
}

function makeRedmine(): TicketConnector {
  return {
    getAssignedTickets: vi.fn().mockResolvedValue([]),
    getTicket: vi.fn().mockResolvedValue({
      id: makeTicketId("42"),
      subject: "Add X",
      description: "do stuff",
      status: "Open",
      assigneeId: 1,
      projectId: 1,
      customFields: {},
    }),
    addNote: vi.fn(),
    transitionStatus: vi.fn(),
    transitionToInProgress: vi.fn(),
    transitionToInReview: vi.fn(),
    closeTicket: vi.fn(),
    getSourceLabel: vi.fn().mockReturnValue("redmine"),
  } as unknown as TicketConnector;
}

function makeAgentRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: makeAgentId("a-1"),
    name: "Copilot A",
    type: "coding",
    modelConfigJson: JSON.stringify({ model: "gpt-5.4" }),
    integrationId: "copilot-a",
    systemPromptId: null,
    instructionsPromptId: null,
    maxConcurrent: 1,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function baseConfig() {
  return {
    maxAgentCycles: 3,
    maxRetryAttempts: 5,
    agentTimeoutMs: 5000,
    gitAuthorName: "VE",
    gitAuthorEmail: "ve@x.com",
    agentContainerImage: "img:latest",
  };
}

describe("Orchestrator — Phase 4 project mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("startTaskForProject creates a task tagged with projectId and calls setTaskProjectId", async () => {
    const stateStore = makeStateStore();
    const ws = makeWorkspaceRunner();
    const project = makeProject();
    const projectMode: ProjectModeDeps = {
      projectStore: {
        getProjectById: vi.fn(async () => project),
        listProjectPushTargets: vi.fn(async () => [
          makePushTarget({ id: 1, commitOrder: 1, localPath: ".", integrationId: "vcs-1", repoKey: "root" }),
        ]),
        getProjectTicketSource: vi.fn(),
        getProjectReviewConfig: vi.fn().mockResolvedValue(null),
        getAgentById: vi.fn(),
      },
      pluginManager: { getConnectorForIntegration: vi.fn() },
    };
    const orch = new Orchestrator(baseConfig(), stateStore, ws, undefined, undefined, projectMode);

    // Make runWorkflow short-circuit so we don't need to mock the entire pipeline.
    // setTaskProjectId is awaited BEFORE runWorkflow, so make transition throw to bail.
    (stateStore.transition as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("__stop__"));

    await orch
      .startTaskForProject({ id: "42", subject: "Add X", description: "do stuff" }, project, "redmine:int-1")
      .catch(() => undefined);

    expect(stateStore.createTask).toHaveBeenCalled();
    expect(stateStore.setTaskProjectId).toHaveBeenCalledWith(expect.any(String), project.id);
  });

  it("startTaskForProject reuses existing in-progress task and skips creation", async () => {
    const existing = makeTask({ state: "AGENT_RUNNING" });
    const stateStore = makeStateStore({
      getTaskByTicketId: vi.fn().mockResolvedValue(existing),
    });
    const project = makeProject();
    const orch = new Orchestrator(baseConfig(), stateStore, makeWorkspaceRunner());

    await orch.startTaskForProject({ id: "42" }, project, "redmine:int-1");

    expect(stateStore.createTask).not.toHaveBeenCalled();
    expect(stateStore.setTaskProjectId).not.toHaveBeenCalled();
  });

  it("resolves a project-bound ticket connector with the VE ticket project binding", async () => {
    const boundConnector = makeRedmine();
    const projectMode: ProjectModeDeps = {
      projectStore: {
        getProjectById: vi.fn(async () => makeProject()),
        listProjectPushTargets: vi.fn(async () => []),
        getProjectTicketSource: vi.fn(async () => ({
          id: 1,
          projectId: makeProjectId("p-1"),
          integrationId: "gitlab-int",
          ticketProjectKey: "group/platform",
          createdAt: new Date(),
        })),
        getProjectReviewConfig: vi.fn().mockResolvedValue(null),
        getAgentById: vi.fn(),
      },
      pluginManager: {
        getConnectorForIntegration: vi.fn(() => null),
        createConnectorForIntegration: vi.fn(async () => boundConnector),
      } as unknown as ProjectModeDeps["pluginManager"],
    };

    const orch = new Orchestrator(baseConfig(), makeStateStore(), makeWorkspaceRunner(), undefined, undefined, projectMode);

    const connector = await (orch as unknown as { resolveTicketConnector: (task: Pick<Task, "taskId" | "projectId"> & { ticketId?: Task["ticketId"] }) => Promise<TicketConnector> }).resolveTicketConnector(
      makeTask({ projectId: makeProjectId("p-1") })
    );

    expect((projectMode.pluginManager as unknown as { createConnectorForIntegration: ReturnType<typeof vi.fn> }).createConnectorForIntegration).toHaveBeenCalledWith("gitlab-int", {
      ticketProjectKey: "group/platform",
    });
    expect(connector).toBe(boundConnector);
  });

  it("project-mode runAgentCycle calls prepareProjectWorkspace and pushes per-target via resolveVcsForIntegration", async () => {
    const stateStore = makeStateStore();
    const ws = makeWorkspaceRunner();
    const project = makeProject();
    const targets = [
      makePushTarget({ id: 1, commitOrder: 1, localPath: ".", integrationId: "vcs-root", repoKey: "root" }),
      makePushTarget({ id: 2, commitOrder: 2, localPath: "libs/core", integrationId: "vcs-core", repoKey: "core" }),
    ];
    const vcsRoot: VcsConnector = {
      clone: vi.fn(),
      push: vi.fn().mockResolvedValue({ changeId: "Iroot", url: "u-root", status: "OPEN" }),
      pushDirect: vi.fn().mockResolvedValue({ changeId: "Iroot", url: "u-root", status: "OPEN" }),
      getChangeStatus: vi.fn(),
      buildPushSpec: vi.fn().mockReturnValue({ ref: "refs/for/main", topic: "VE-task-id" }),
      useChangeIdContinuity: true,
      reviewSystemLabel: "gerrit",
    } as unknown as VcsConnector;
    const vcsCore: VcsConnector = {
      clone: vi.fn(),
      push: vi.fn().mockResolvedValue({ changeId: "Icore", url: "u-core", status: "OPEN" }),
      pushDirect: vi.fn().mockResolvedValue({ changeId: "Icore", url: "u-core", status: "OPEN" }),
      getChangeStatus: vi.fn(),
      buildPushSpec: vi.fn().mockReturnValue({ ref: "refs/for/main", topic: "VE-task-id" }),
      useChangeIdContinuity: true,
      reviewSystemLabel: "gerrit",
    } as unknown as VcsConnector;

    const projectMode: ProjectModeDeps = {
      projectStore: {
        getProjectById: vi.fn(async () => project),
        listProjectPushTargets: vi.fn(async () => targets),
        getProjectTicketSource: vi.fn().mockResolvedValue({ integrationId: "redmine-int" }),
        getProjectReviewConfig: vi.fn().mockResolvedValue(null),
        getAgentById: vi.fn(),
      },
      pluginManager: { getConnectorForIntegration: vi.fn().mockImplementation((id: string) => {
        if (id === "redmine-int") return makeRedmine();
        return null;
      }) },
      resolveVcsForIntegration: vi.fn(async (id: string) => {
        if (id === "vcs-root") return vcsRoot;
        if (id === "vcs-core") return vcsCore;
        return null;
      }),
    };

    const orch = new Orchestrator(baseConfig(), stateStore, ws, undefined, undefined, projectMode);

    const task = makeTask({ state: "AGENT_RUNNING" });
    await (orch as unknown as { runAgentCycle: (t: Task) => Promise<void> }).runAgentCycle(task);

    expect(ws.prepareProjectWorkspace).toHaveBeenCalledWith(expect.any(Object), targets, "", undefined);
    expect(projectMode.resolveVcsForIntegration).toHaveBeenCalledWith("vcs-root", { repoKey: "root" });
    expect(projectMode.resolveVcsForIntegration).toHaveBeenCalledWith("vcs-core", { repoKey: "core" });
    expect(stateStore.saveChangePerRepository).toHaveBeenCalledWith(
      task.taskId,
      "root",
      "Iroot",
      "u-root",
      "OPEN",
      "vcs-root",
      "gerrit",
      1,
      expect.any(String)
    );
    expect(stateStore.saveChangePerRepository).toHaveBeenCalledWith(
      task.taskId,
      "core",
      "Icore",
      "u-core",
      "OPEN",
      "vcs-core",
      "gerrit",
      2,
      expect.any(String)
    );
  });

  it("project-mode runAgentCycle passes the project-linked agent adapter to the workspace runner", async () => {
    const stateStore = makeStateStore();
    const ws = makeWorkspaceRunner();
    const project = makeProject();
    const projectAgent = {
      name: "project-agent",
      buildContainerSpec: vi.fn(() => ({ image: "x:latest", env: {}, command: [] })),
      execute: vi.fn(),
    } as unknown as AgentAdapter;

    const projectMode: ProjectModeDeps = {
      projectStore: {
        getProjectById: vi.fn(async () => project),
        listProjectPushTargets: vi.fn(async () => [
          makePushTarget({ id: 1, commitOrder: 1, localPath: ".", integrationId: "vcs-1", repoKey: "root" }),
        ]),
        getProjectTicketSource: vi.fn().mockResolvedValue({ integrationId: "redmine-int" }),
        getProjectReviewConfig: vi.fn().mockResolvedValue(null),
        getAgentById: vi.fn(async () => makeAgentRecord({ integrationId: "copilot-project" })),
      },
      pluginManager: {
        getConnectorForIntegration: vi.fn((integrationId: string) => {
          if (integrationId === "copilot-project") return projectAgent;
          if (integrationId === "redmine-int") return makeRedmine();
          return null;
        }),
      } as unknown as ProjectModeDeps["pluginManager"],
      resolveVcsForIntegration: vi.fn(async () => ({
        clone: vi.fn(),
        push: vi.fn().mockResolvedValue({ changeId: "Iroot", url: "u-root", status: "OPEN" }),
        pushDirect: vi.fn().mockResolvedValue({ changeId: "Iroot", url: "u-root", status: "OPEN" }),
        getChangeStatus: vi.fn(),
        buildPushSpec: vi.fn().mockReturnValue({ ref: "refs/for/main", topic: "VE-task-id" }),
        useChangeIdContinuity: true,
        reviewSystemLabel: "gerrit",
      }) as unknown as VcsConnector),
    };

    const orch = new Orchestrator(baseConfig(), stateStore, ws, undefined, undefined, projectMode);

    const task = makeTask({ state: "AGENT_RUNNING" });
    await (orch as unknown as { runAgentCycle: (t: Task) => Promise<void> }).runAgentCycle(task);

    expect(ws.runAgent).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), projectAgent);
  });

  it("project-mode runAgentCycle applies resolved agent overrides to task context", async () => {
    const stateStore = makeStateStore();
    const ws = makeWorkspaceRunner();
    const project = {
      ...makeProject(),
      agentOverrideJson: JSON.stringify({
        model: "gpt-4o",
        apiKey: "project-gh",
        systemPromptId: "project-system",
        instructionsPromptId: "project-instructions",
      }),
    } satisfies ProjectRecord;
    const projectAgent = {
      name: "project-agent",
      buildContainerSpec: vi.fn(() => ({ image: "x:latest", env: {}, command: [] })),
      execute: vi.fn(),
    } as unknown as AgentAdapter;

    const projectMode: ProjectModeDeps = {
      projectStore: {
        getProjectById: vi.fn(async () => project),
        listProjectPushTargets: vi.fn(async () => [
          makePushTarget({ id: 1, commitOrder: 1, localPath: ".", integrationId: "vcs-1", repoKey: "root" }),
        ]),
        getProjectTicketSource: vi.fn().mockResolvedValue({ integrationId: "redmine-int" }),
        getProjectReviewConfig: vi.fn().mockResolvedValue(null),
        getAgentById: vi.fn(async () => makeAgentRecord({
          integrationId: "copilot-project",
          systemPromptId: "agent-system",
          instructionsPromptId: "agent-instructions",
          modelConfigJson: JSON.stringify({
            model: "gpt-5.4",
            apiKey: "agent-gh",
          }),
        })),
      },
      pluginManager: {
        getConnectorForIntegration: vi.fn((integrationId: string) => {
          if (integrationId === "copilot-project") return projectAgent;
          if (integrationId === "redmine-int") return makeRedmine();
          return null;
        }),
      } as unknown as ProjectModeDeps["pluginManager"],
      resolveVcsForIntegration: vi.fn(async () => ({
        clone: vi.fn(),
        push: vi.fn().mockResolvedValue({ changeId: "Iroot", url: "u-root", status: "OPEN" }),
        pushDirect: vi.fn().mockResolvedValue({ changeId: "Iroot", url: "u-root", status: "OPEN" }),
        getChangeStatus: vi.fn(),
        buildPushSpec: vi.fn().mockReturnValue({ ref: "refs/for/main", topic: "VE-task-id" }),
        useChangeIdContinuity: true,
        reviewSystemLabel: "gerrit",
      }) as unknown as VcsConnector),
    };

    const orch = new Orchestrator(baseConfig(), stateStore, ws, undefined, undefined, projectMode);

    const task = makeTask({ state: "AGENT_RUNNING" });
    await (orch as unknown as { runAgentCycle: (t: Task) => Promise<void> }).runAgentCycle(task);

    const context = vi.mocked(ws.runAgent).mock.calls[0]?.[1] as import("../../src/interfaces.js").TaskContext;
    expect(context.agentSession.githubToken).toBe("project-gh");
    expect(context.agentSession.copilotModel).toBe("gpt-4o");
    expect(context.systemPromptId).toBe("project-system");
    expect(context.instructionsPromptId).toBe("project-instructions");
  });

  it("project-mode runAgentCycle records NO_CHANGE for a clean repo (best-effort)", async () => {
    const stateStore = makeStateStore();
    const ws = makeWorkspaceRunner();
    const project = makeProject();
    const targets = [
      makePushTarget({ id: 1, commitOrder: 1, localPath: ".", integrationId: "vcs-root", repoKey: "root" }),
      makePushTarget({ id: 2, commitOrder: 2, localPath: "libs/core", integrationId: "vcs-core", repoKey: "core" }),
    ];
    const vcsRoot: VcsConnector = {
      clone: vi.fn(),
      push: vi.fn(),
      pushDirect: vi.fn().mockResolvedValue({ changeId: "Iroot", url: "u-root", status: "OPEN" }),
      getChangeStatus: vi.fn(),
      buildPushSpec: vi.fn().mockReturnValue({ ref: "refs/for/main", topic: "VE-task-id" }),
      useChangeIdContinuity: true,
      reviewSystemLabel: "gerrit",
    } as unknown as VcsConnector;

    const projectMode: ProjectModeDeps = {
      projectStore: {
        getProjectById: vi.fn(async () => project),
        listProjectPushTargets: vi.fn(async () => targets),
        getProjectTicketSource: vi.fn().mockResolvedValue({ integrationId: "redmine-int" }),
        getProjectReviewConfig: vi.fn().mockResolvedValue(null),
        getAgentById: vi.fn(),
      },
      pluginManager: { getConnectorForIntegration: vi.fn().mockImplementation((id: string) => {
        if (id === "redmine-int") return makeRedmine();
        return null;
      }) },
      resolveVcsForIntegration: vi.fn(async (id: string) => (id === "vcs-root" ? vcsRoot : null)),
    };

    const orch = new Orchestrator(baseConfig(), stateStore, ws, undefined, undefined, projectMode);

    // First target has 1 commit ahead of origin (push needed), second has 0 (NO_CHANGE).
    let call = 0;
    (ws.execGitInVolume as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      call++;
      return call === 1 ? "1\n" : "0\n";
    });

    const task = makeTask({ state: "AGENT_RUNNING" });
    await (orch as unknown as { runAgentCycle: (t: Task) => Promise<void> }).runAgentCycle(task);

    expect(stateStore.saveChangePerRepository).toHaveBeenCalledWith(
      task.taskId,
      "core",
      "",
      "",
      "NO_CHANGE",
      "vcs-core",
      "none",
      2,
      ""
    );
  });

  it("project-mode runAgentCycle pushes a repo whose working tree is clean but has commits ahead of origin", async () => {
    // Regression: git status --porcelain returns "" after the agent commits its work,
    // but there are local commits ahead of origin that must still be pushed.
    const stateStore = makeStateStore();
    const ws = makeWorkspaceRunner();
    const project = makeProject();
    const targets = [
      makePushTarget({ id: 1, commitOrder: 1, localPath: ".", integrationId: "vcs-root", repoKey: "root" }),
    ];
    const vcsRoot: VcsConnector = {
      clone: vi.fn(),
      push: vi.fn(),
      pushDirect: vi.fn().mockResolvedValue({ changeId: "Iroot", url: "u-root", status: "OPEN" }),
      getChangeStatus: vi.fn(),
      buildPushSpec: vi.fn().mockReturnValue({ ref: "refs/for/main", topic: "VE-task-id" }),
      useChangeIdContinuity: true,
      reviewSystemLabel: "gerrit",
    } as unknown as VcsConnector;

    const projectMode: ProjectModeDeps = {
      projectStore: {
        getProjectById: vi.fn(async () => project),
        listProjectPushTargets: vi.fn(async () => targets),
        getProjectTicketSource: vi.fn().mockResolvedValue({ integrationId: "redmine-int" }),
        getProjectReviewConfig: vi.fn().mockResolvedValue(null),
        getAgentById: vi.fn(),
      },
      pluginManager: { getConnectorForIntegration: vi.fn().mockImplementation((id: string) => {
        if (id === "redmine-int") return makeRedmine();
        return null;
      }) },
      resolveVcsForIntegration: vi.fn(async () => vcsRoot),
    };

    const orch = new Orchestrator(baseConfig(), stateStore, ws, undefined, undefined, projectMode);

    // Agent committed its work: 1 commit ahead of origin, working tree clean.
    (ws.execGitInVolume as ReturnType<typeof vi.fn>).mockResolvedValue("1\n");

    const task = makeTask({ state: "AGENT_RUNNING" });
    await (orch as unknown as { runAgentCycle: (t: Task) => Promise<void> }).runAgentCycle(task);

    // Must have pushed, not recorded NO_CHANGE
    expect(vcsRoot.pushDirect).toHaveBeenCalled();
    expect(stateStore.saveChangePerRepository).toHaveBeenCalledWith(
      task.taskId,
      "root",
      "Iroot",
      "u-root",
      "OPEN",
      "vcs-root",
      "gerrit",
      1,
      expect.any(String)
    );
  });

  it("project-mode runAgentCycle transitions to FAILED when all push targets fail (email auth error)", async () => {
    const stateStore = makeStateStore();
    const ws = makeWorkspaceRunner();
    const project = makeProject();
    const targets = [
      makePushTarget({ id: 1, commitOrder: 1, localPath: ".", integrationId: "vcs-root", repoKey: "root" }),
    ];
    const pushError = new Error(
      "remote: ERROR: commit abc123: email address ve@local is not registered"
    );
    const vcsRoot: VcsConnector = {
      clone: vi.fn(),
      push: vi.fn(),
      pushDirect: vi.fn().mockRejectedValue(pushError),
      getChangeStatus: vi.fn(),
      buildPushSpec: vi.fn().mockReturnValue({ ref: "refs/for/main", topic: "VE-task-id" }),
      useChangeIdContinuity: true,
      reviewSystemLabel: "gerrit",
    } as unknown as VcsConnector;

    const projectMode: ProjectModeDeps = {
      projectStore: {
        getProjectById: vi.fn(async () => project),
        listProjectPushTargets: vi.fn(async () => targets),
        getProjectTicketSource: vi.fn().mockResolvedValue({ integrationId: "redmine-int" }),
        getProjectReviewConfig: vi.fn().mockResolvedValue(null),
        getAgentById: vi.fn(),
      },
      pluginManager: {
        getConnectorForIntegration: vi.fn().mockImplementation((id: string) => {
          if (id === "redmine-int") return makeRedmine();
          return null;
        }),
      },
      resolveVcsForIntegration: vi.fn(async () => vcsRoot),
    };

    const orch = new Orchestrator(baseConfig(), stateStore, ws, undefined, undefined, projectMode);
    (ws.execGitInVolume as ReturnType<typeof vi.fn>).mockResolvedValue("1\n");

    const task = makeTask({ state: "AGENT_RUNNING" });
    // Call runWorkflow so the full error-handling path (handleFatalError) is exercised.
    await (orch as unknown as { runWorkflow: (t: Task) => Promise<void> }).runWorkflow(task);

    // Task must have been transitioned to FAILED, not IN_REVIEW.
    const transitionCalls = vi.mocked(stateStore.transition).mock.calls.map((c) => c[1]);
    expect(transitionCalls).toContain("FAILED");
    expect(transitionCalls).not.toContain("IN_REVIEW");
  });

  it("project-mode review polling resolves per-repo change connectors with the repo binding", async () => {
    const task = makeTask({ state: "IN_REVIEW" });
    const stateStore = makeStateStore({
      getChangesForTask: vi.fn().mockResolvedValue([
        {
          id: "chg-1",
          taskId: task.taskId,
          repoKey: "group/platform",
          changeId: "17",
          reviewUrl: "https://gitlab.local/group/platform/-/merge_requests/17",
          status: "OPEN",
          integrationId: "gitlab-int",
          reviewSystem: "gitlab",
          commitIndex: 1,
          subjectHash: "abc",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]),
      transition: vi.fn()
        .mockResolvedValueOnce(makeTask({ state: "FEEDBACK_PROCESSING" }))
        .mockResolvedValueOnce(makeTask({ state: "IN_REVIEW" })),
    });
    const reviewConnector = {
      clone: vi.fn(),
      push: vi.fn(),
      getChangeStatus: vi.fn().mockResolvedValue("OPEN"),
      getUnresolvedComments: vi.fn().mockResolvedValue([]),
      buildPushSpec: vi.fn().mockReturnValue({ ref: "feature-task", topic: undefined }),
      useChangeIdContinuity: false,
      reviewSystemLabel: "gitlab",
    } as unknown as VcsConnector;

    const projectMode: ProjectModeDeps = {
      projectStore: {
        getProjectById: vi.fn(async () => makeProject()),
        listProjectPushTargets: vi.fn(async () => []),
        getProjectTicketSource: vi.fn().mockResolvedValue({ integrationId: "redmine-int" }),
        getProjectReviewConfig: vi.fn().mockResolvedValue(null),
        getAgentById: vi.fn(),
      },
      pluginManager: { getConnectorForIntegration: vi.fn(() => null) } as unknown as ProjectModeDeps["pluginManager"],
      resolveVcsForIntegration: vi.fn(async () => reviewConnector),
    };

    const orch = new Orchestrator(baseConfig(), stateStore, makeWorkspaceRunner(), undefined, undefined, projectMode);

    await (orch as unknown as { checkReviewProgress: (task: Task) => Promise<void> }).checkReviewProgress(task);

    expect(projectMode.resolveVcsForIntegration).toHaveBeenCalledWith("gitlab-int", {
      repoKey: "group/platform",
    });
    expect(reviewConnector.getChangeStatus).toHaveBeenCalledWith("17");
  });

  it("project-mode review polling skips a repo when repo-bound connector resolution fails", async () => {
    const task = makeTask({ state: "IN_REVIEW" });
    const stateStore = makeStateStore({
      getChangesForTask: vi.fn().mockResolvedValue([
        {
          id: "chg-1",
          taskId: task.taskId,
          repoKey: "group/platform",
          changeId: "17",
          reviewUrl: "https://gitlab.local/group/platform/-/merge_requests/17",
          status: "OPEN",
          integrationId: "gitlab-int",
          reviewSystem: "gitlab",
          commitIndex: 1,
          subjectHash: "abc",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]),
      transition: vi.fn()
        .mockResolvedValueOnce(makeTask({ state: "FEEDBACK_PROCESSING" }))
        .mockResolvedValueOnce(makeTask({ state: "IN_REVIEW" })),
    });

    const projectMode: ProjectModeDeps = {
      projectStore: {
        getProjectById: vi.fn(async () => makeProject()),
        listProjectPushTargets: vi.fn(async () => []),
        getProjectTicketSource: vi.fn().mockResolvedValue({ integrationId: "redmine-int" }),
        getProjectReviewConfig: vi.fn().mockResolvedValue(null),
        getAgentById: vi.fn(),
      },
      pluginManager: { getConnectorForIntegration: vi.fn(() => null) } as unknown as ProjectModeDeps["pluginManager"],
      resolveVcsForIntegration: vi.fn(async () => {
        throw new Error("factory unavailable");
      }),
    };

    const orch = new Orchestrator(baseConfig(), stateStore, makeWorkspaceRunner(), undefined, undefined, projectMode);

    await expect((orch as unknown as { checkReviewProgress: (task: Task) => Promise<void> }).checkReviewProgress(task)).resolves.toBeUndefined();

    expect(projectMode.resolveVcsForIntegration).toHaveBeenCalledWith("gitlab-int", {
      repoKey: "group/platform",
    });
    expect(stateStore.transition).toHaveBeenCalledWith(task.taskId, "FEEDBACK_PROCESSING");
    expect(stateStore.transition).toHaveBeenCalledWith(task.taskId, "IN_REVIEW");
  });

  it("project-mode review polling keeps comment resolution non-fatal when repo-bound connector resolution fails", async () => {
    const task = makeTask({ state: "IN_REVIEW" });
    const processedComment = {
      id: "note-1",
      author: "reviewer",
      content: "Please fix this",
      createdAt: new Date().toISOString(),
      filePath: "group/platform/src/app.ts",
    };
    const stateStore = makeStateStore({
      getChangesForTask: vi.fn().mockResolvedValue([
        {
          id: "chg-1",
          taskId: task.taskId,
          repoKey: "group/platform",
          changeId: "17",
          reviewUrl: "https://gitlab.local/group/platform/-/merge_requests/17",
          status: "OPEN",
          integrationId: "gitlab-int",
          reviewSystem: "gitlab",
          commitIndex: 1,
          subjectHash: "abc",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]),
      transition: vi.fn()
        .mockResolvedValueOnce(makeTask({ state: "FEEDBACK_PROCESSING" }))
        .mockResolvedValueOnce(makeTask({ state: "RETRY_CYCLE" })),
      getTask: vi.fn().mockResolvedValue(makeTask({ state: "IN_REVIEW" })),
    });
    const reviewConnector = {
      clone: vi.fn(),
      push: vi.fn(),
      getChangeStatus: vi.fn().mockResolvedValue("OPEN"),
      getUnresolvedComments: vi.fn().mockResolvedValue([processedComment]),
      buildPushSpec: vi.fn().mockReturnValue({ ref: "feature-task", topic: undefined }),
      useChangeIdContinuity: false,
      reviewSystemLabel: "gitlab",
    } as unknown as VcsConnector;

    const projectMode: ProjectModeDeps = {
      projectStore: {
        getProjectById: vi.fn(async () => makeProject()),
        listProjectPushTargets: vi.fn(async () => []),
        getProjectTicketSource: vi.fn().mockResolvedValue({ integrationId: "redmine-int" }),
        getProjectReviewConfig: vi.fn().mockResolvedValue(null),
        getAgentById: vi.fn(),
      },
      pluginManager: { getConnectorForIntegration: vi.fn(() => null) } as unknown as ProjectModeDeps["pluginManager"],
      resolveVcsForIntegration: vi.fn()
        .mockResolvedValueOnce(reviewConnector)
        .mockRejectedValueOnce(new Error("factory unavailable")),
    };

    const orch = new Orchestrator(baseConfig(), stateStore, makeWorkspaceRunner(), undefined, undefined, projectMode);
    vi.spyOn(orch as unknown as { runAgentCycle: (task: Task) => Promise<void> }, "runAgentCycle").mockResolvedValue(undefined);
    vi.spyOn(
      (orch as unknown as { feedbackProcessor: { extractNewFeedback: (taskId: Task["taskId"], changeId: string, comments: unknown[]) => Promise<[unknown[], typeof processedComment[]]> } }).feedbackProcessor,
      "extractNewFeedback"
    ).mockResolvedValue([
      [{ id: "feedback-1", source: "review", content: "Please fix this" }],
      [processedComment],
    ]);

    await expect((orch as unknown as { checkReviewProgress: (task: Task) => Promise<void> }).checkReviewProgress(task)).resolves.toBeUndefined();

    expect(reviewConnector.getChangeStatus).toHaveBeenCalledWith("17");
    expect(stateStore.transition).toHaveBeenCalledWith(task.taskId, "RETRY_CYCLE");
  });
});
