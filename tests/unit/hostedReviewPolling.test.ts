import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubPullRequestReviewConnector } from "../../src/connectors/githubPullRequestReviewConnector.js";
import { GitLabMergeRequestConnector } from "../../src/connectors/gitlabMergeRequestConnector.js";
import type {
  DomainCapability,
  IntegrationBindingContext,
  ProjectPushTargetRecord,
  ReviewConnector,
  Task,
  WorkspaceRunner,
} from "../../src/interfaces.js";
import { makeProjectId, makeTaskId, makeTicketId } from "../../src/interfaces.js";
import { Orchestrator, type ProjectModeDeps } from "../../src/orchestrator/orchestrator.js";
import { PollingLoop } from "../../src/orchestrator/pollingLoop.js";
import { ProjectPushService } from "../../src/orchestrator/projectPushService.js";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { GitHubVcsConnector } from "../../src/vcs/githubVcsConnector.js";
import { GitLabVcsConnector } from "../../src/vcs/gitlabVcsConnector.js";
import type { VcsConnector } from "../../src/vcs/vcsConnector.js";
import { errorResponse, jsonResponse } from "./helpers/fixtures.js";
import { RecordingGitRunner } from "./helpers/recordingGitRunner.js";

type Provider = "github" | "gitlab";
type ReviewState = "open" | "closed" | "merged";

const TASK_ID = makeTaskId("task-1");
const GITHUB_API = "https://api.github.com/repos/octocat/hello-world";
const GITLAB_MR_API = "https://gitlab.example.test/api/v4/projects/group%2Fproject/merge_requests";
const PROVIDERS = {
  github: { repoKey: "octocat/hello-world", url: "https://github.com/octocat/hello-world/pull/42" },
  gitlab: { repoKey: "group/project", url: "https://gitlab.example.test/group/project/-/merge_requests/42" },
} as const;

/** Fake provider API: VE's native PR/MR 42 carrying one actionable review comment. */
function providerApi(provider: Provider, review: { state: ReviewState }) {
  return vi.fn((input: string, init?: RequestInit): Promise<Response> => {
    const [path = ""] = input.split("?");
    const method = init?.method ?? "GET";
    if (provider === "github") {
      const pullRequest = {
        number: 42, title: "Add feature", html_url: PROVIDERS.github.url, requested_reviewers: [],
        state: review.state === "open" ? "open" : "closed", merged: review.state === "merged",
        head: { ref: "feature-task-1", sha: "abc123" },
      };
      const routes: Record<string, unknown> = {
        [`GET ${GITHUB_API}/pulls`]: [],
        [`POST ${GITHUB_API}/pulls`]: pullRequest,
        [`GET ${GITHUB_API}/pulls/42`]: pullRequest,
        [`GET ${GITHUB_API}/pulls/42/reviews`]: [{ state: "CHANGES_REQUESTED", user: { login: "reviewer" } }],
        [`GET ${GITHUB_API}/pulls/42/comments`]: [{
          id: 101, node_id: "PRRC_101", user: { login: "reviewer" }, body: "Validate the input",
          path: "src/index.ts", line: 3, updated_at: "2026-11-05T10:00:00Z",
        }],
        [`GET ${GITHUB_API}/issues/42/comments`]: [],
        [`GET ${GITHUB_API}/commits/abc123/check-runs`]: { check_runs: [] },
      };
      const body = routes[`${method} ${path}`];
      return Promise.resolve(body === undefined ? errorResponse(404, "Not Found") : jsonResponse(body));
    }
    const routes: Record<string, unknown> = {
      [`POST ${GITLAB_MR_API}`]: { iid: 42, web_url: PROVIDERS.gitlab.url },
      [`GET ${GITLAB_MR_API}/42`]: { state: review.state === "open" ? "opened" : review.state },
      [`GET ${GITLAB_MR_API}/42/discussions`]: [{
        id: "discussion-1", individual_note: false, resolved: false,
        notes: [{
          id: 1, system: false, author: { id: 2, username: "reviewer" }, body: "Validate the input",
          updated_at: "2026-11-05T10:00:00Z", position: { new_path: "src/index.ts", new_line: 3 },
        }],
      }],
    };
    const body = routes[`${method} ${path}`];
    return Promise.resolve(body === undefined ? errorResponse(404, "Not Found") : jsonResponse(body));
  });
}

function gitRunner(): RecordingGitRunner {
  const runner = new RecordingGitRunner();
  runner.run.mockImplementation((args) => Promise.resolve({
    stdout: args[0] === "remote" && args[1] === "get-url"
      ? "https://git.example.test/origin.git"
      : args[0] === "log" ? "feat: add feature" : "",
    stderr: "",
  }));
  return runner;
}

function splitRepository(repoKey: string): { owner: string; repo: string } {
  const [owner = "", repo = ""] = repoKey.split("/");
  return { owner, repo };
}

function makeVcsConnector(provider: Provider, repoKey: string): VcsConnector {
  const identity = { token: "test-token", gitAuthorName: "VE", gitAuthorEmail: "ve@example.test" };
  return provider === "github"
    ? new GitHubVcsConnector({
      apiBaseUrl: "https://api.github.com", host: "github.com", ...splitRepository(repoKey), ...identity,
    }, gitRunner())
    : new GitLabVcsConnector({ baseUrl: "https://gitlab.example.test", projectId: repoKey, ...identity }, gitRunner());
}

function makeReviewConnector(provider: Provider, repoKey: string): ReviewConnector {
  return provider === "github"
    ? new GitHubPullRequestReviewConnector({
      apiBaseUrl: "https://api.github.com", ...splitRepository(repoKey), token: "test-token",
      virtualEngineerUserLogin: "virtual-engineer",
    })
    : new GitLabMergeRequestConnector({ baseUrl: "https://gitlab.example.test", projectId: repoKey, token: "test-token" });
}

function makeTarget(provider: Provider): ProjectPushTargetRecord {
  return {
    id: 1,
    projectId: makeProjectId("proj-1"),
    integrationId: `${provider}-1`,
    repoKey: PROVIDERS[provider].repoKey,
    cloneUrl: `https://git.example.test/${PROVIDERS[provider].repoKey}.git`,
    targetBranch: "main",
    role: "primary",
    commitOrder: 1,
    localPath: ".",
    sshKeyPath: null,
    reviewerEmails: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function makeOrchestrator(store: SqliteStateStore, provider: Provider): Orchestrator {
  const ticketConnector = {
    getTicket: vi.fn().mockResolvedValue(null),
    addNote: vi.fn().mockResolvedValue(undefined),
    transitionToInReview: vi.fn().mockResolvedValue(undefined),
    closeTicket: vi.fn().mockResolvedValue(undefined),
    getSourceLabel: vi.fn().mockReturnValue("redmine"),
  };
  const integrationId = `${provider}-1`;
  const projectMode: ProjectModeDeps = {
    projectStore: {
      getProjectById: vi.fn().mockResolvedValue(null),
      listProjectPushTargets: vi.fn().mockResolvedValue([makeTarget(provider)]),
      getProjectTicketSource: vi.fn().mockResolvedValue({ integrationId: "redmine-int" }),
      getProjectReviewConfig: vi.fn().mockResolvedValue(null),
      getAgentById: vi.fn().mockResolvedValue(null),
    },
    pluginManager: {
      getConnectorForIntegration: vi.fn().mockReturnValue(null),
      createConnectorForCapability: vi.fn((id: string, capability: DomainCapability, context?: IntegrationBindingContext) => {
        if (id === "redmine-int" && capability === "issue_tracking") return Promise.resolve(ticketConnector);
        if (id === integrationId && capability === "code_review" && context?.repoKey !== undefined) {
          return Promise.resolve(makeReviewConnector(provider, context.repoKey));
        }
        return Promise.resolve(null);
      }),
    } as unknown as ProjectModeDeps["pluginManager"],
    resolveVcsForIntegration: vi.fn((id: string, context?: IntegrationBindingContext) =>
      Promise.resolve(id === integrationId && context?.repoKey !== undefined
        ? makeVcsConnector(provider, context.repoKey)
        : null)),
  };
  return new Orchestrator(
    {
      maxAgentCycles: 3,
      maxRetryAttempts: 5,
      agentTimeoutMs: 1000,
      gitAuthorName: "VE",
      gitAuthorEmail: "ve@example.test",
      agentContainerImage: "x:latest",
    },
    store,
    { prepareWorkspace: vi.fn(), cleanupWorkspace: vi.fn(), runAgent: vi.fn() } as unknown as WorkspaceRunner,
    undefined,
    undefined,
    projectMode,
  );
}

describe.each(["github", "gitlab"] as const)("%s native review polling", (provider) => {
  const { repoKey } = PROVIDERS[provider];
  let store: SqliteStateStore;
  let review: { state: ReviewState };

  beforeEach(async () => {
    store = await SqliteStateStore.create(":memory:");
    review = { state: "open" };
    vi.stubGlobal("fetch", providerApi(provider, review));
    await store.createTask(TASK_ID, makeTicketId("ticket-1"), "Add feature");
    (store as unknown as { raw: Database.Database }).raw
      .prepare("UPDATE tasks SET state = 'IN_REVIEW', project_id = 'proj-1' WHERE task_id = ?")
      .run(TASK_ID);
    const pushService = new ProjectPushService({
      stateStore: store,
      workspaceRunner: { listTrustedRepoPaths: () => ["."], execGitInVolume: vi.fn().mockResolvedValue("1\n") },
      resolveVcsConnectorForTarget: (_integrationId, context) =>
        Promise.resolve(makeVcsConnector(provider, context?.repoKey ?? "")),
      resolvePushRef: (_task, compute) => Promise.resolve(compute()),
    });
    await pushService.pushProjectChanges(
      { taskId: TASK_ID, ticketTitle: "Add feature", pushRef: null },
      { taskId: TASK_ID, containerId: "sandbox-1", hostWorkspacePath: "/tmp/workspace" },
      [makeTarget(provider)],
      "feat: add feature",
      [{ repoKey, sha: "sha-1", subject: "feat: add feature", body: "", changeId: `I${"1".repeat(40)}`, files: [] }],
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    store.close();
  });

  /** Run one real poll; webhooks were missed, so polling is the only signal. */
  async function poll(): Promise<{ runAgentCycle: ReturnType<typeof vi.fn> }> {
    const orchestrator = makeOrchestrator(store, provider);
    const runAgentCycle = vi.fn().mockResolvedValue(undefined);
    Object.assign(orchestrator, { runAgentCycle });
    await new PollingLoop({ ticketIntervalMs: 30_000, maxRetryAttempts: 5 }, orchestrator, store).pollInReviewTasks();
    return { runAgentCycle };
  }

  it("records only the native per-repository change, without a task-level id", async () => {
    expect((await store.getTask(TASK_ID))?.externalChangeId).toBeNull();
    expect(await store.getChangesForTask(TASK_ID)).toEqual([
      expect.objectContaining({ repoKey, changeId: "42", reviewUrl: PROVIDERS[provider].url, status: "OPEN" }),
    ]);
  });

  it("polls the open review and starts a retry cycle with its reviewer feedback", async () => {
    const { runAgentCycle } = await poll();

    await vi.waitFor(() => expect(runAgentCycle).toHaveBeenCalledOnce());
    expect(runAgentCycle).toHaveBeenCalledWith(
      expect.objectContaining<Partial<Task>>({ taskId: TASK_ID, state: "RETRY_CYCLE" }),
      [expect.objectContaining({
        source: "review_comment",
        reviewSystem: provider,
        content: `[${repoKey}] Validate the input`,
        filePath: "src/index.ts",
        line: 3,
      })],
    );
  });

  it("abandons the task when the review was closed without merging", async () => {
    review.state = "closed";

    const { runAgentCycle } = await poll();

    await vi.waitFor(async () => expect((await store.getTask(TASK_ID))?.state).toBe("ABANDONED"));
    expect((await store.getChangesForTask(TASK_ID))[0]?.status).toBe("ABANDONED");
    expect(runAgentCycle).not.toHaveBeenCalled();
  });

  it("completes the task when the review was merged", async () => {
    review.state = "merged";

    await poll();

    await vi.waitFor(async () => expect((await store.getTask(TASK_ID))?.state).toBe("DONE"));
    expect((await store.getChangesForTask(TASK_ID))[0]?.status).toBe("MERGED");
  });
});
