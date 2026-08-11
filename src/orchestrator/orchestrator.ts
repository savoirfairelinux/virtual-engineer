import pRetry from "p-retry";
import { randomUUID, createHash } from "crypto";
import { isAbsolute, relative, resolve, sep } from "path";
import type {
  AgentAdapter,
  CommitDescriptor,
  FeedbackItem,
  Integration,
  IntegrationBindingContext,
  ReviewConnector,
  TicketConnector,
  StateStore,
  WorkspaceRunner,
  WorkspaceHandle,
  ProjectRecord,
  ProjectPushTargetRecord,
} from "../interfaces.js";
import { TicketApiError, TicketNotFoundError } from "../interfaces.js";
import type { IntegrationStore } from "../interfaces.js";
import {
  makeTaskId,
  makeTicketId,
  type ExternalChangeId,
  type TicketId,
} from "../domain/identifiers.js";
import {
  TERMINAL_STATES,
  type CodeGenState,
  type Task,
} from "../domain/tasks.js";
import { getLogger } from "../logger.js";
import { FeedbackProcessor } from "./feedbackProcessor.js";
import { TaskLifecycleCoordinator } from "./taskLifecycleCoordinator.js";
import {
  ReviewProgressService,
  type ReviewProgressDependencies,
} from "./reviewProgressService.js";
import { clearTaskEventBuffer } from "../agents/agentEventBus.js";
import { normalizeAgentResult, getModifiedFileCount } from "../agents/agentEventTypes.js";
import { resolveProviderOptions } from "../agents/providerOptions.js";
import type { VcsConnector } from "../vcs/vcsConnector.js";
import { NO_REVIEW_SYSTEM } from "../vcs/vcsConnector.js";
import { VcsConnectorFactory } from "../vcs/vcsFactory.js";
import { encryptToken } from "../utils/encryption.js";
import { redactUrls } from "../utils/redactUrl.js";
import { toRejectionError } from "../utils/rejection.js";
import { isInfrastructureError } from "../utils/errorClassifier.js";
import type { ConcurrencyTracker } from "./concurrencyTracker.js";
import { resolveAgentConfig } from "../state/stateStore.js";
import {
  buildAgentTaskContext,
  type ProjectAgentRuntime,
} from "./agentContextBuilder.js";
import {
  enrichPushTargets,
  resolveCloneKnownHostsPath,
} from "./pushTargetEnrichment.js";

const log = getLogger("orchestrator");

/**
 * Resolve a push target's `localPath` inside the workspace. `localPath` is
 * already validated at the admin API, but the workspace round-trips through the
 * agent sandbox, so re-assert containment before running Git there.
 */
function resolveWorkspaceSubPath(workspacePath: string, localPath: string): string {
  if (isAbsolute(localPath)) {
    throw new Error(`Push target path must stay within the workspace: ${localPath}`);
  }
  const workspace = resolve(workspacePath);
  const target = resolve(workspace, localPath);
  const relativePath = relative(workspace, target);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`Push target path must stay within the workspace: ${localPath}`);
  }
  return target;
}

export interface OrchestratorConfig {
  maxAgentCycles: number;
  maxRetryAttempts: number;
  agentTimeoutMs: number;
  gitAuthorName: string;
  gitAuthorEmail: string;
  agentContainerImage: string;
  adminAuthSecret?: string | undefined;
  /** Max retry attempts for the ticket-close call in `closeTicket()`. Defaults to 5 when omitted. */
  ticketCloseMaxRetries?: number | undefined;
  /** Minimum backoff (ms) between ticket-close retries. Defaults to 5000 when omitted. */
  ticketCloseRetryMinTimeoutMs?: number | undefined;
}

/**
 * Project-mode dependencies. When provided, the orchestrator resolves
 * agent + VCS connectors via project relations rather than env-var fallback.
 */
export interface ProjectModeDeps {
  projectStore: {
    getProjectById(id: import("../interfaces.js").ProjectId): Promise<ProjectRecord | null>;
    listProjectPushTargets(id: import("../interfaces.js").ProjectId): Promise<import("../interfaces.js").ProjectPushTargetRecord[]>;
    listProjectVendorComponents?(id: import("../interfaces.js").ProjectId): Promise<import("../interfaces.js").ProjectVendorComponentRecord[]>;
    getProjectTicketSource(id: import("../interfaces.js").ProjectId): Promise<import("../interfaces.js").ProjectTicketSourceRecord | null>;
    getProjectReviewConfig(id: import("../interfaces.js").ProjectId): Promise<import("../interfaces.js").ProjectReviewConfig | null>;
    getAgentById(id: import("../interfaces.js").AgentId): Promise<import("../interfaces.js").AgentRecord | null>;
    deleteProject?(id: import("../interfaces.js").ProjectId): Promise<void>;
  };
  pluginManager: {
    getConnectorForIntegration<T>(integrationId: string): T | null;
    getConnectorForCapability?<T>(integrationId: string, capability: import("../interfaces.js").DomainCapability): T | null;
    createConnectorForCapability?<T>(integrationId: string, capability: import("../interfaces.js").DomainCapability, context?: IntegrationBindingContext): Promise<T | null>;
    createConnectorForIntegration?<T>(integrationId: string, context?: IntegrationBindingContext): Promise<T | null>;
    getActiveIntegrationById?(integrationId: string): import("../interfaces.js").Integration | null;
    decryptIntegrationConfig?(integration: import("../interfaces.js").Integration): Record<string, unknown>;
  };
  /** Inject a function to build a VcsConnector for a given integration id (host-side). */
  resolveVcsForIntegration?: (integrationId: string, context?: IntegrationBindingContext) => Promise<VcsConnector | null>;
  /**
   * Optional in-memory concurrency tracker. When provided, project-mode tasks
   * must `acquire()` a slot before running and `release()` it on terminal
   * states. Legacy tasks (no projectId) are not gated.
   */
  concurrencyTracker?: ConcurrencyTracker;
}

/**
 * Drives the ticket-driven code-generation lifecycle: clone → agent → push → review → merge → close.
 * Persists all state via `StateStore`; resumes in-flight tasks after a restart via `resumeActiveTasks()`.
 */
export class Orchestrator {
  private readonly feedbackProcessor: FeedbackProcessor;
  private readonly activeWorkflows = new Map<string, Promise<void>>();
  private readonly reviewProgressService: ReviewProgressService;
  private config: OrchestratorConfig;
  private vcsConnector: VcsConnector | undefined;
  private readonly vcsConnectorFactory: VcsConnectorFactory;
  private projectMode: ProjectModeDeps | null = null;
  /**
   * Task ids whose `runWorkflow` is currently executing. Guards against
   * concurrent re-entry when the same task is driven from multiple triggers
   * (boot recovery, stalled-task polling, review events) at once.
   */
  private readonly inFlightTasks = new Set<string>();
  constructor(
    config: OrchestratorConfig,
    private readonly stateStore: StateStore,
    private readonly workspaceRunner: WorkspaceRunner,
    vcsConnector?: VcsConnector,
    private readonly integrationStore?: IntegrationStore,
    projectMode?: ProjectModeDeps,
    private readonly lifecycleCoordinator = new TaskLifecycleCoordinator(),
  ) {
    this.config = config;
    this.vcsConnectorFactory = new VcsConnectorFactory({ adminAuthSecret: config.adminAuthSecret });
    this.vcsConnector = vcsConnector;
    this.feedbackProcessor = new FeedbackProcessor(stateStore);
    this.projectMode = projectMode ?? null;
    this.reviewProgressService = new ReviewProgressService({
      getChangesForTask: (taskId): ReturnType<ReviewProgressDependencies["getChangesForTask"]> =>
        this.stateStore.getChangesForTask(taskId),
      transition: (taskId, state): ReturnType<ReviewProgressDependencies["transition"]> =>
        this.stateStore.transition(taskId, state),
      updateChangeStatus: (taskId, repoKey, status, changeId): ReturnType<ReviewProgressDependencies["updateChangeStatus"]> =>
        this.stateStore.updateChangePerRepositoryStatus(taskId, repoKey, status, changeId),
      getTask: (taskId): ReturnType<ReviewProgressDependencies["getTask"]> =>
        this.stateStore.getTask(taskId),
      resolveReviewConnector: (task): ReturnType<ReviewProgressDependencies["resolveReviewConnector"]> =>
        this.resolveReviewConnector(task),
      resolveVcsConnector: (integrationId, context): ReturnType<ReviewProgressDependencies["resolveVcsConnector"]> =>
        this.tryResolveVcsConnectorForTarget(integrationId, context),
      getDefaultVcsConnector: (): ReturnType<ReviewProgressDependencies["getDefaultVcsConnector"]> =>
        this.vcsConnector,
      extractNewFeedback: (taskId, changeId, comments): ReturnType<ReviewProgressDependencies["extractNewFeedback"]> =>
        this.feedbackProcessor.extractNewFeedback(taskId, changeId, comments),
      reactsToCiFailures: (task): ReturnType<ReviewProgressDependencies["reactsToCiFailures"]> =>
        this.projectReactsToCiFailures(task),
      getMaxAgentCycles: (): ReturnType<ReviewProgressDependencies["getMaxAgentCycles"]> =>
        this.config.maxAgentCycles,
      runAgentCycle: (task, feedback): ReturnType<ReviewProgressDependencies["runAgentCycle"]> =>
        this.runAgentCycle(task, feedback),
      closeTicket: (task): ReturnType<ReviewProgressDependencies["closeTicket"]> =>
        this.closeTicket(task),
      abandonTask: (task, reason): ReturnType<ReviewProgressDependencies["abandonTask"]> =>
        this.handleAbandoned(task, reason),
    });
  }

  /** Enable or refresh project-mode dependencies at runtime without a restart. */
  setProjectMode(mode: ProjectModeDeps | null): void {
    this.projectMode = mode;
  }

  /** Apply partial runtime overrides (config and/or VCS connector) without restarting. */
  updateRuntime(runtime: {
    config?: Partial<OrchestratorConfig>;
    vcsConnector?: VcsConnector;
  }): void {
    if (runtime.config) {
      const nextConfig: OrchestratorConfig = {
        ...this.config,
        ...runtime.config,
      };
      this.config = nextConfig;
    }
    if (runtime.vcsConnector) {
      this.vcsConnector = runtime.vcsConnector;
      // Clear per-integration cache so next cycle picks up fresh connectors.
      this.vcsConnectorFactory.clear();
    }
  }

  /** Create a project-bound task and run its workflow. The only public task-creation entry point. */
  async startTaskForProject(
    ticket: { id: string; subject?: string; description?: string; webUrl?: string | undefined },
    project: ProjectRecord,
    ticketSourceLabel: string
  ): Promise<void> {
    const projectLease = await this.lifecycleCoordinator.acquireProjectStart(project.id);
    if (projectLease === null) {
      log.info({ projectId: project.id, ticketId: ticket.id }, "project is being deleted; skipping task creation");
      return;
    }
    let task: Task | undefined;
    try {
    const ticketId = makeTicketId(ticket.id);
    // Active-task identity is scoped by (project, ticket): two projects bound to
    // different repos under the same integration may legitimately have tickets
    // with the same number, and must not alias onto one another.
    const existing = await this.stateStore.getActiveTaskByTicketId(ticketId, project.id);
    if (existing) {
      log.info(
        { ticketId, existingTaskId: existing.taskId, state: existing.state, projectId: project.id },
        "project task already in progress, reusing existing task"
      );
      return;
    }
    const failedAttempts = await this.stateStore.getFailedAttemptCount(ticketId, ticketSourceLabel, project.id);
    if (failedAttempts >= this.config.maxRetryAttempts) {
      log.warn(
        { ticketId, source: ticketSourceLabel, failedAttempts, projectId: project.id },
        "project ticket has exhausted max retry attempts, not creating new task"
      );
      return;
    }

    const taskId = makeTaskId(randomUUID());
    // Snapshot the ticket source on the task so it can be adopted by a future
    // project if this project is later deleted. project_id is written atomically
    // so the (project_id, ticket_id) active-uniqueness index applies at insert.
    const ticketSource = await this.projectMode?.projectStore.getProjectTicketSource(project.id);
    task = await this.stateStore.createTask(
      taskId,
      ticketId,
      ticket.subject,
      ticket.description,
      ticketSourceLabel,
      ticket.webUrl,
      ticket.id,
      ticketSource
        ? { integrationId: ticketSource.integrationId, ticketProjectKey: ticketSource.ticketProjectKey }
        : undefined,
      project.id
    );
    log.info(
      { taskId: task.taskId, ticketId, projectId: project.id, source: ticketSourceLabel },
      "created project-mode task"
    );
    } finally {
      projectLease.release();
    }
    if (task === undefined) return;
    await this.runWorkflow(task);
  }

  /** Re-run the workflow for all active non-review tasks after a process restart. */
  async resumeActiveTasks(): Promise<void> {
    const activeTasks = await this.stateStore.getActiveTasks();
    // Code-review tasks are managed by ReviewOrchestrator (via the polling loop);
    // do not resume them through the ticket workflow.
    const ticketTasks = activeTasks.filter((t) => t.taskType !== "code-review");
    log.info({ count: ticketTasks.length }, "resuming active tasks");
    for (const task of ticketTasks) {
      this.runWorkflow(task).catch((err: unknown) => {
        log.error({ taskId: task.taskId, err }, "unhandled error resuming task");
      });
    }
  }

  /**
   * Resume a single code-gen task that stalled while waiting for an agent
   * concurrency slot. Called by the polling loop for tasks left in
   * `CONTEXT_BUILDING` or `RETRY_CYCLE`: `runAgentCycle` defers (without
   * re-queuing) whenever the shared agent slot is busy, so without this poll
   * these tasks would never advance until the next process restart. The
   * in-flight guard in `runWorkflow` prevents double-driving a task whose
   * previous resume is still executing.
   */
  async resumeStalledCodeGenTask(taskId: ReturnType<typeof makeTaskId>): Promise<void> {
    const task = await this.stateStore.getTask(taskId);
    if (!task || task.taskType === "code-review") return;
    if (task.state !== "CONTEXT_BUILDING" && task.state !== "RETRY_CYCLE") return;
    await this.runWorkflow(task);
  }

  /**
   * Polling fallback for code-review tasks stuck in REVIEW_WATCHING.
   * Queries the review system for the current change status and transitions
   * to REVIEW_DONE (merged) or ABANDONED accordingly. This compensates for
   * missed `change-merged` stream events when the Gerrit SSH connection drops.
   */
  async checkReviewWatchingTask(taskId: ReturnType<typeof makeTaskId>): Promise<void> {
    const task = await this.stateStore.getTask(taskId);
    if (!task || task.state !== "REVIEW_WATCHING" || !task.externalChangeId) {
      return;
    }
    let reviewConnector: ReviewConnector;
    try {
      reviewConnector = await this.resolveReviewConnector(task);
    } catch (err) {
      log.warn({ taskId, err }, "checkReviewWatchingTask: could not resolve review connector — skipping");
      return;
    }
    let status: string;
    try {
      status = await reviewConnector.getChangeStatus(task.externalChangeId);
    } catch (err) {
      log.warn({ taskId, changeId: task.externalChangeId, err }, "checkReviewWatchingTask: failed to fetch change status — staying REVIEW_WATCHING");
      return;
    }
    if (status === "MERGED") {
      log.info({ taskId, changeId: task.externalChangeId }, "checkReviewWatchingTask: change is MERGED — transitioning to REVIEW_DONE");
      await this.stateStore.transition(taskId, "REVIEW_DONE");
    } else if (status === "ABANDONED") {
      log.info({ taskId, changeId: task.externalChangeId }, "checkReviewWatchingTask: change is ABANDONED — abandoning review task");
      await this.handleAbandoned(task, "change was abandoned externally (poll)");
    }
  }

  /** Handle an external review event by looking up the in-flight task and checking review progress. */
  async handleReviewEvent(changeId: ExternalChangeId): Promise<void> {
    const task = await this.stateStore.findTaskByExternalChangeId(null, changeId);
    if (!task) {
      log.debug({ changeId }, "no active task for review change");
      return;
    }

    await this.runTaskLifecycle(task.taskId, async () => {
      const current = await this.stateStore.getTask(task.taskId) ?? task;
      log.debug(
        { taskId: current.taskId, changeId, state: current.state, ticketId: current.ticketId },
        "handling review event for task"
      );
      if (TERMINAL_STATES.has(current.state)) {
        log.debug({ taskId: current.taskId, state: current.state }, "task already in terminal state, ignoring review event");
        return;
      }
      if (current.state !== "IN_REVIEW") {
        log.debug({ taskId: current.taskId, state: current.state }, "task not in IN_REVIEW, ignoring review event");
        return;
      }
      await this.checkReviewProgress(current);
    });
  }

  /**
   * Webhook entry points — look up the task for a review-system change id and
   * apply the appropriate lifecycle step. All three are no-ops for unknown or terminal tasks;
   * the polling loop remains the source-of-truth fallback.
   */
  async triggerFeedbackForChange(integrationId: string, externalChangeId: string, streamComments?: import("../interfaces.js").ReviewComment[]): Promise<void> {
    const task = await this.stateStore.findTaskByExternalChangeId(integrationId, externalChangeId);
    if (!task) {
      log.info({ integrationId, externalChangeId }, "webhook feedback: no task for change (likely a human-authored change, ignoring)");
      return;
    }
    await this.runTaskLifecycle(task.taskId, async () => {
      const current = await this.stateStore.getTask(task.taskId) ?? task;
      if (TERMINAL_STATES.has(current.state)) return;
      if (current.state !== "IN_REVIEW") {
        log.info({ taskId: current.taskId, state: current.state, externalChangeId }, "webhook feedback: task not IN_REVIEW, ignoring");
        return;
      }
      log.info({ taskId: current.taskId, integrationId, externalChangeId }, "webhook feedback: triggering review progress check");
      await this.checkReviewProgress(current, externalChangeId, streamComments);
    });
  }

  /** Webhook handler: mark the associated task's change as merged and close its ticket. */
  async markChangeMerged(integrationId: string, externalChangeId: string): Promise<void> {
    const task = await this.stateStore.findTaskByExternalChangeId(integrationId, externalChangeId);
    if (!task) {
      log.info({ integrationId, externalChangeId }, "webhook merged: no task for change, ignoring");
      return;
    }
    await this.runTaskLifecycle(task.taskId, async () => {
      const current = await this.stateStore.getTask(task.taskId) ?? task;
      if (TERMINAL_STATES.has(current.state)) return;
      if (current.state === "REVIEW_WATCHING") {
        log.info({ taskId: current.taskId, externalChangeId }, "webhook merged: marking review task REVIEW_DONE");
        await this.stateStore.transition(current.taskId, "REVIEW_DONE");
        return;
      }
      if (current.state !== "IN_REVIEW") {
        log.info({ taskId: current.taskId, state: current.state }, "webhook merged: task not IN_REVIEW/REVIEW_WATCHING, ignoring");
        return;
      }
      log.info({ taskId: current.taskId, externalChangeId }, "webhook merged: closing ticket");
      const merged = await this.stateStore.transition(current.taskId, "MERGED");
      await this.closeTicket(merged);
    });
  }

  /** Webhook handler: mark the associated task as abandoned when a change is externally abandoned. */
  async markChangeAbandoned(integrationId: string, externalChangeId: string): Promise<void> {
    const task = await this.stateStore.findTaskByExternalChangeId(integrationId, externalChangeId);
    if (!task) {
      log.info({ integrationId, externalChangeId }, "webhook abandoned: no task for change, ignoring");
      return;
    }
    await this.runTaskLifecycle(task.taskId, async () => {
      const current = await this.stateStore.getTask(task.taskId) ?? task;
      if (TERMINAL_STATES.has(current.state)) return;
      log.info({ taskId: current.taskId, externalChangeId }, "webhook abandoned: marking task ABANDONED");
      await this.handleAbandoned(current, "change was abandoned externally (webhook)");
    });
  }

  /** Resume an existing task's workflow, typically after a manual retry. */
  async continueTask(taskId: TicketId | ReturnType<typeof makeTaskId>): Promise<void> {
    const task = await this.stateStore.getTask(makeTaskId(String(taskId)));
    if (!task) {
      throw new Error(`Task not found: ${String(taskId)}`);
    }

    await this.runWorkflow(task);
  }

  async abandonTask(taskId: ReturnType<typeof makeTaskId>): Promise<Task> {
    let abandoned: Task | undefined;
    await this.lifecycleCoordinator.cancelTaskAndRun(taskId, async () => {
      const current = await this.stateStore.getTask(taskId);
      if (!current) throw new Error(`Task not found: ${taskId}`);
      abandoned = TERMINAL_STATES.has(current.state)
        ? current
        : await this.stateStore.abandonTask(taskId);
    });
    if (!abandoned) throw new Error(`Task not found: ${taskId}`);
    return abandoned;
  }

  async deleteProject(projectId: import("../interfaces.js").ProjectId): Promise<void> {
    const projectStore = this.projectMode?.projectStore;
    if (!projectStore?.deleteProject) throw new Error("Project deletion is not configured");
    await this.lifecycleCoordinator.deleteProject(
      projectId,
      async () => (await this.stateStore.getAllTasks())
        .filter((task) => task.projectId === projectId)
        .map((task) => task.taskId),
      () => projectStore.deleteProject!(projectId),
    );
  }

  /** Invalidate the cached VCS connector for an integration after a config update. */
  invalidateVcsConnector(integrationId: string): void {
    this.vcsConnectorFactory.invalidate(integrationId);
  }

  /** Resolve the VCS connector for a push target; returns undefined on transient lookup failures. */
  private async tryResolveVcsConnectorForTarget(
    integrationId: string,
    context?: IntegrationBindingContext
  ): Promise<VcsConnector | undefined> {
    try {
      if (this.projectMode?.resolveVcsForIntegration) {
        return (await this.projectMode.resolveVcsForIntegration(integrationId, context)) ?? undefined;
      }
      return await this.resolveConnectorForIntegration(integrationId, context);
    } catch (err) {
      log.warn({ integrationId, context, err }, "failed to resolve VCS connector for target");
      return undefined;
    }
  }

  /** Resolve the VCS connector for a push target, throwing if none is available. */
  private async resolveVcsConnectorForTarget(integrationId: string, context?: IntegrationBindingContext): Promise<VcsConnector> {
    const connector = await this.tryResolveVcsConnectorForTarget(integrationId, context);
    if (!connector) {
      throw new Error(`No VCS connector available for integration ${integrationId}`);
    }
    return connector;
  }

  /** Resolve a VCS connector for an integration ID using the factory; returns undefined if unavailable. */
  private async resolveConnectorForIntegration(
    integrationId: string,
    context?: IntegrationBindingContext
  ): Promise<VcsConnector | undefined> {
    try {
      const store = this.integrationStore ?? (this.stateStore as unknown as IntegrationStore);
      const integration = await store.getIntegration(integrationId);
      if (integration && integration.enabled) {
        return this.vcsConnectorFactory.getConnector(integration, context);
      }
    } catch (err) {
      log.warn({ integrationId, err }, "failed to resolve connector for integration");
    }
    return undefined;
  }

  /** Resolve the ticket connector for a project-bound task via the project's ticket source. */
  private async resolveTicketConnector(task: Pick<Task, "taskId" | "projectId">): Promise<TicketConnector> {
    if (!task.projectId || !this.projectMode) {
      throw new Error(`Task ${task.taskId} is not project-bound; cannot resolve ticket connector`);
    }
    const ts = await this.projectMode.projectStore.getProjectTicketSource(task.projectId);
    if (!ts) {
      throw new Error(`No ticket source configured for project ${task.projectId} (task ${task.taskId})`);
    }
    const connector = this.projectMode.pluginManager.createConnectorForCapability
      ? await this.projectMode.pluginManager.createConnectorForCapability<TicketConnector>(
        ts.integrationId,
        "issue_tracking",
        { ticketProjectKey: ts.ticketProjectKey }
      )
      : this.projectMode.pluginManager.createConnectorForIntegration
        ? await this.projectMode.pluginManager.createConnectorForIntegration<TicketConnector>(
          ts.integrationId,
          { ticketProjectKey: ts.ticketProjectKey }
        )
        : this.projectMode.pluginManager.getConnectorForIntegration<TicketConnector>(ts.integrationId);
    if (!connector) {
      throw new Error(`Ticket source integration ${ts.integrationId} is not active (task ${task.taskId})`);
    }
    return connector;
  }

  /** Resolve the review connector for a project-bound task via review config or push targets. */
  private async resolveReviewConnector(task: Pick<Task, "taskId" | "projectId">): Promise<ReviewConnector> {
    if (!task.projectId || !this.projectMode) {
      throw new Error(`Task ${task.taskId} is not project-bound; cannot resolve review connector`);
    }
    // Try review config first (for review projects). Resolve the `code_review`
    // capability explicitly: a unified provider (e.g. github/gitlab) also exposes
    // `issue_tracking`, and `getConnectorForIntegration` would return the issue
    // connector first — which lacks `getChangeStatus`.
    const rc = await this.projectMode.projectStore.getProjectReviewConfig(task.projectId);
    if (rc) {
      const connector = this.resolveReviewCapabilityConnector(rc.integrationId);
      if (connector) return connector;
    }
    // Fall back to push targets (for coding projects — the VCS connector often doubles as review)
    const pts = await this.projectMode.projectStore.listProjectPushTargets(task.projectId);
    for (const pt of pts) {
      const connector = this.resolveReviewCapabilityConnector(pt.integrationId);
      if (connector) return connector;
    }
    throw new Error(`No active review connector found for project ${task.projectId} (task ${task.taskId})`);
  }

  /**
   * Resolve a review-capable connector for an integration id. Prefers the
   * explicit `code_review` capability so unified providers (github/gitlab) that
   * also expose `issue_tracking` do not resolve to the issue connector, which
   * lacks `getChangeStatus`. Falls back to `getConnectorForIntegration` only
   * when the capability resolver is unavailable.
   */
  private resolveReviewCapabilityConnector(integrationId: string): ReviewConnector | null {
    const pm = this.projectMode?.pluginManager;
    if (!pm) return null;
    if (pm.getConnectorForCapability) {
      const byCapability = pm.getConnectorForCapability<ReviewConnector>(integrationId, "code_review");
      if (byCapability) return byCapability;
    }
    return pm.getConnectorForIntegration<ReviewConnector>(integrationId);
  }

  /** Drive the state machine from the task's current state, dispatching to the appropriate step. */
  private async runWorkflow(task: Task): Promise<void> {
    // Code-review tasks are managed exclusively by ReviewOrchestrator.
    if (task.taskType === "code-review") {
      log.debug({ taskId: task.taskId, state: task.state }, "skipping code-review task in ticket orchestrator");
      return;
    }

    const activeWorkflow = this.activeWorkflows.get(task.taskId);
    if (activeWorkflow !== undefined) {
      log.debug({ taskId: task.taskId }, "joining active task workflow");
      await activeWorkflow;
      return;
    }

    const workflow = this.runTaskLifecycle(task.taskId, async () => {
      const current = await this.stateStore.getTask(task.taskId);
      if (!current && this.lifecycleCoordinator.wasTaskDeleted(task.taskId)) return;
      await this.executeWorkflow(current ?? task);
    });
    this.activeWorkflows.set(task.taskId, workflow);
    try {
      await workflow;
    } finally {
      if (this.activeWorkflows.get(task.taskId) === workflow) {
        this.activeWorkflows.delete(task.taskId);
      }
    }
  }

  private async runTaskLifecycle(taskId: Task["taskId"], operation: () => Promise<void>): Promise<void> {
    await this.lifecycleCoordinator.runTask(taskId, async () => operation());
  }

  private async executeWorkflow(task: Task): Promise<void> {
    // Guard against concurrent re-entry: a task already being driven (e.g. still
    // building context or mid-cycle) must not be picked up again by the
    // stalled-task poll or a second trigger.
    if (this.inFlightTasks.has(task.taskId)) {
      log.debug({ taskId: task.taskId, state: task.state }, "workflow already in flight; skipping re-entry");
      return;
    }
    this.inFlightTasks.add(task.taskId);
    log.info({ taskId: task.taskId, state: task.state }, "running workflow from state");

    // The code-review early-return above guarantees task.state is a CodeGenState here.
    const codeGenState = task.state as CodeGenState;
    try {
      switch (codeGenState) {
        case "DETECTED":
          await this.runFromDetected(task);
          break;
        case "CONTEXT_BUILDING":
          await this.runFromContextBuilding(task);
          break;
        case "AGENT_RUNNING":
        case "RETRY_CYCLE":
          await this.runAgentCycle(task);
          break;
        case "IN_REVIEW":
          await this.checkReviewProgress(task);
          break;
        case "FEEDBACK_PROCESSING":
          await this.processFeedback(task);
          break;
        case "MERGED":
        case "CLOSING":
          await this.closeTicket(task);
          break;
        case "DONE":
        case "FAILED":
        case "ABANDONED":
          break;
        default: {
          const _exhaustive: never = codeGenState;
          log.warn({ state: _exhaustive }, "unhandled code-gen state in runWorkflow");
        }
      }
    } catch (err) {
      await this.handleFatalError(task, err);
    } finally {
      this.inFlightTasks.delete(task.taskId);
    }
  }

  /** Transition a detected ticket to context-building: mark in-progress and add a start note. */
  private async runFromDetected(task: Task): Promise<void> {
    const ticketConnector = await this.resolveTicketConnector(task);
    await ticketConnector.getTicket(task.ticketId);
    await ticketConnector.transitionToInProgress(task.ticketId);
    await this.addTicketNote(
      task,
      `Virtual Engineer (task ${task.taskId}) is starting work on this ticket.`
    );
    task = await this.stateStore.transition(task.taskId, "CONTEXT_BUILDING");
    await this.runFromContextBuilding(task);
  }

  /** Advance context-building to the first agent cycle. */
  private async runFromContextBuilding(task: Task): Promise<void> {
    await this.runAgentCycle(task);
  }

  /** Execute one agent cycle: build context, invoke the agent, push changes, and advance state. */
  private async runAgentCycle(task: Task, reviewFeedback: FeedbackItem[] = []): Promise<void> {
    let cycleLease: import("./concurrencyTracker.js").ConcurrencyLease | null = null;
    let pendingRetry: Task | null = null;
    const projectIdForCycle = task.projectId ?? (await this.stateStore.getTask(task.taskId))?.projectId ?? null;
    if (!task.projectId && projectIdForCycle) {
      task.projectId = projectIdForCycle;
    }
    try {
    if (projectIdForCycle && this.projectMode?.concurrencyTracker) {
      const project = await this.projectMode.projectStore.getProjectById(projectIdForCycle);
      if (project) {
        const acquiredLease = await this.projectMode.concurrencyTracker.acquire(project.id, project.agentId);
        if (acquiredLease === null) {
          if (task.state === "AGENT_RUNNING") {
            task = await this.stateStore.transition(task.taskId, "RETRY_CYCLE", {
              reason: "waiting for available agent slot",
            });
          }
          log.info(
            { taskId: task.taskId, projectId: project.id, agentId: project.agentId },
            "ai adapter at capacity; retrying on next poll tick"
          );
          return;
        }
        cycleLease = acquiredLease;
      }
    }

    const ticketConnector = await this.resolveTicketConnector(task);
    const ticket = await ticketConnector.getTicket(task.ticketId);
    const priorFeedback = await this.buildPriorFeedback(task, reviewFeedback);
    const currentCycle = task.state === "AGENT_RUNNING" && task.cycleCount > 0
      ? (await this.stateStore.getAgentCycles(task.taskId)).find(
          (cycle) => cycle.cycleNumber === task.cycleCount && cycle.result.status === "running"
        )
      : undefined;
    const runningResult = {
      status: "running" as const,
      modifiedFiles: [],
      summary: "",
      agentLogs: "",
      metadata: {},
    };
    let cycleNumber: number;
    if (currentCycle !== undefined) {
      cycleNumber = currentCycle.cycleNumber;
      await this.stateStore.saveAgentCycle(task.taskId, cycleNumber, runningResult);
    } else {
      task = await this.stateStore.transition(task.taskId, "AGENT_RUNNING");
      cycleNumber = await this.stateStore.startAgentCycle(task.taskId, runningResult);
    }

    log.info({ taskId: task.taskId, cycleNumber }, "starting agent cycle");

    let handle: WorkspaceHandle | undefined;
    try {
      const activeHandle = await this.workspaceRunner.createWorkspace(task.taskId);
      handle = activeHandle;
      if (!task.projectId || !this.projectMode || !this.workspaceRunner.prepareProjectWorkspace) {
        throw new Error(
          `Task ${task.taskId} is not project-bound; project-mode is the only supported workflow.`
        );
      }
      let cloneUrl: string;
      let cloneBranch: string;
      let projectPushTargets: import("../interfaces.js").ProjectPushTargetRecord[] = [];
      let projectRecord: ProjectRecord | null = null;

      projectRecord = await this.projectMode.projectStore.getProjectById(task.projectId);
      if (!projectRecord) {
        throw new Error(`Project not found for task: ${task.projectId}`);
      }
      projectPushTargets = await this.projectMode.projectStore.listProjectPushTargets(task.projectId);
      if (projectPushTargets.length === 0) {
        throw new Error(`Project ${task.projectId} has no push targets configured`);
      }
      const vendorComponents = (await this.projectMode.projectStore.listProjectVendorComponents?.(task.projectId) ?? [])
        .map((component) => ({
          sourcePath: component.sourcePath,
          localPath: component.localPath,
          origin: component.origin,
        }));
      const sortedTargets = [...projectPushTargets].sort((a, b) => a.commitOrder - b.commitOrder);
      const root = sortedTargets.find((t) => t.localPath === ".") ?? sortedTargets[0]!;
      cloneUrl = root.cloneUrl;
      cloneBranch = root.targetBranch;
      log.info(
        { taskId: task.taskId, projectId: task.projectId, targetCount: projectPushTargets.length },
        "preparing project-mode workspace"
      );

      // Resolve sshKnownHostsPath from root target's VCS connector (if available).
      // Also enrich any push target whose sshKeyPath is null with the key from its linked connector.
      const cloneKnownHostsPath = await resolveCloneKnownHostsPath(root, (integrationId, context) =>
        this.resolveVcsConnectorForTarget(integrationId, context)
      );

      const enrichedPushTargets = await enrichPushTargets(projectPushTargets, {
        getIntegration: (integrationId) =>
          (this.integrationStore ?? (this.stateStore as unknown as IntegrationStore)).getIntegration(integrationId),
        resolveIntegrationConfig: (integration) => this.resolveIntegrationConfig(integration),
        resolveVcsConnectorForTarget: (integrationId, context) => this.resolveVcsConnectorForTarget(integrationId, context),
      });

      const cloneResult = await this.workspaceRunner.prepareProjectWorkspace(
        activeHandle,
        enrichedPushTargets,
        projectRecord.postCloneScript,
        cloneKnownHostsPath
      );
      if (!cloneResult.success) {
        throw new Error(`Failed to prepare project workspace: ${cloneResult.error ?? "unknown error"}`);
      }

      const commitMessage = this.buildCommitMessage(task, ticket.subject);
      let projectAgentRuntime: ProjectAgentRuntime;
      try {
        projectAgentRuntime = await this.resolveProjectAgentRuntime(projectRecord);
      } catch (err) {
        await this.handleFatalError(task, err);
        return;
      }
      const resolvedCopilotModel = projectAgentRuntime.config.model?.trim() || undefined;
      const providerOptions = resolveProviderOptions(projectAgentRuntime.config.extra);
      if (!resolvedCopilotModel) {
        log.warn(
          { taskId: task.taskId, projectId: projectRecord?.id ?? null },
          "no model resolved from project agent config — container will use adapter default (DEFAULT_COPILOT_MODEL)"
        );
      }
      const rootConnector = await this.resolveVcsConnectorForTarget(root.integrationId, { repoKey: root.repoKey, targetBranch: root.targetBranch });
      const pushRef = await this.resolvePushRef(task, () =>
        rootConnector.buildPushSpec(cloneBranch, task.taskId, ticket.subject).ref
      );

      const hasPriorPatchset = await this.checkoutPriorPatchset(task, cycleNumber, activeHandle, root, rootConnector);
      const context = await buildAgentTaskContext({
        task,
        ticket,
        cycleNumber,
        hasPriorPatchset,
        commitMessage,
        cloneBranch,
        cloneUrl,
        pushRef,
        handle: activeHandle,
        priorFeedback,
        projectAgentRuntime,
        resolvedCopilotModel,
        providerOptions,
        useChangeIdContinuity: rootConnector.useChangeIdContinuity,
        projectPushTargets,
        vendorComponents,
        projectRecord,
        agentContainerImage: this.config.agentContainerImage,
        gitAuthorName: this.config.gitAuthorName,
        gitAuthorEmail: this.config.gitAuthorEmail,
        getChangesForTask: (taskId) => this.stateStore.getChangesForTask(taskId),
      });

      const agentResult = await this.withTimeout(
        (abortSignal) => this.workspaceRunner.runAgent(
          activeHandle,
          { ...context, abortSignal },
          projectAgentRuntime.adapter,
        ),
        this.config.agentTimeoutMs,
        `Agent timed out after ${this.config.agentTimeoutMs}ms`
      );

      // Normalize result to support both flat (single-repo) and repo-grouped (multi-repo) formats.
      const normalizedResult = normalizeAgentResult(agentResult);
      const fileCount = getModifiedFileCount(agentResult.modifiedFiles);

      log.info(
        { taskId: task.taskId, status: normalizedResult.status, files: fileCount },
        "agent cycle completed"
      );
      clearTaskEventBuffer(task.taskId);

      // Guard: the task may have been abandoned/deleted while the agent was
      // running (e.g. webhook change-abandoned + admin delete).  Re-read from
      // the database before writing any child rows to avoid FK violations.
      const freshTask = await this.stateStore.getTask(task.taskId);
      if (!freshTask) {
        log.warn({ taskId: task.taskId }, "task no longer exists after agent cycle; discarding result");
        return;
      }
      if (TERMINAL_STATES.has(freshTask.state)) {
        const summary = `Agent result discarded because task reached ${freshTask.state}`;
        await this.stateStore.saveAgentCycle(task.taskId, cycleNumber, {
          status: "failed",
          modifiedFiles: [],
          summary,
          agentLogs: "",
          metadata: { error: summary, cancelled: true },
        });
        log.warn(
          { taskId: task.taskId, state: freshTask.state },
          "task reached terminal state while agent was running; discarding result"
        );
        return;
      }

      if (normalizedResult.status === "no_change") {
        await this.stateStore.saveAgentCycle(task.taskId, cycleNumber, normalizedResult);
        await this.handleNoChange(task, cycleNumber);
        return;
      }

      if (normalizedResult.status === "failed") {
        await this.stateStore.saveAgentCycle(task.taskId, cycleNumber, normalizedResult);
        if (cycleNumber >= this.config.maxAgentCycles) {
          await this.handleAbandoned(task, `Agent failed after ${cycleNumber} cycles`);
          return;
        }

        pendingRetry = await this.stateStore.transition(task.taskId, "RETRY_CYCLE");
      } else {
        const hasAgentCommits = agentResult.commits != null && agentResult.commits.length > 0;

        if (rootConnector.useChangeIdContinuity && !agentResult.externalChangeId && !hasAgentCommits) {
          throw new Error("Agent reported success but did not return a Gerrit Change-Id or commits");
        }

        await this.stateStore.saveAgentCycle(task.taskId, cycleNumber, normalizedResult);

        // For Gerrit: agent commits[] are pre-validated; each becomes a separate change (topic-grouped).
        // For GitLab: all N commits land in one MR via force-push.
        if (task.projectId && this.projectMode && projectPushTargets.length > 0) {
          await this.pushProjectChanges(
            task,
            activeHandle,
            projectPushTargets,
            commitMessage,
            agentResult.commits,
            projectRecord.gerritTopicOverride
          );
        }

        task = await this.stateStore.transition(task.taskId, "IN_REVIEW");
        const ticketConn = await this.resolveTicketConnector(task);
        await ticketConn.transitionToInReview(task.ticketId);

        // Opt-in (default off): post the review URL(s) as a ticket note. A fix may
        // land in a different repo than the ticket, so the full URL is unambiguous.
        // Only on cycle 1 — later cycles add patchsets to the same change/URL.
        if (projectRecord?.postReviewLinkToTicket && cycleNumber === 1) {
          const changes = await this.stateStore.getChangesForTask(task.taskId);
          const links = changes
            .filter((c) => c.status !== "NO_CHANGE" && c.status !== "ORPHANED" && c.reviewUrl)
            .map((c) => `${c.repoKey}: ${c.reviewUrl}`);
          if (links.length > 0) {
            await this.addTicketNote(task, `Virtual Engineer opened a review:\n\n${links.join("\n")}`, false);
          }
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Agent cycle failed";
      await this.stateStore.saveAgentCycle(task.taskId, cycleNumber, {
        status: "failed",
        modifiedFiles: [],
        summary: message,
        agentLogs: "",
        metadata: { error: message },
      }).catch((saveErr: unknown) => {
        log.warn({ err: saveErr, taskId: task.taskId }, "failed to save agent failure cycle");
      });
      clearTaskEventBuffer(task.taskId);
      throw err;
    } finally {
      if (handle !== undefined) {
        try {
          await this.workspaceRunner.destroyWorkspace(handle);
        } catch (err) {
          log.warn(
            { taskId: task.taskId, err },
            "workspace cleanup failed (non-fatal, task state unaffected)"
          );
        }
      }
    }
    } finally {
      if (cycleLease !== null && this.projectMode?.concurrencyTracker) {
        this.projectMode.concurrencyTracker.release(cycleLease);
      }
    }
    if (pendingRetry) {
      await this.runAgentCycle(pendingRetry);
    }
  }

  /**
   * On retry cycles with Change-Id continuity, fetch the existing Gerrit patchset into
   * the volume so the agent starts from its previous work rather than a blank slate.
   *
   * For multi-commit pushes, the primary change (commitIndex 0) is checked out as
   * detached HEAD, then commits 1..N are cherry-picked on top in order.
   * Cherry-pick failures for secondary commits are non-fatal (logged and skipped).
   */
  /**
   * Returns `true` if a prior patchset was successfully checked out into the
   * workspace volume (so the agent can amend existing commits), `false` if no
   * patchset was applied (first cycle, non-Gerrit connector, no stored change,
   * or checkout failure).
   */
  private async checkoutPriorPatchset(
    task: Task,
    cycleNumber: number,
    handle: WorkspaceHandle,
    root: ProjectPushTargetRecord,
    rootConnector: VcsConnector
  ): Promise<boolean> {
    if (cycleNumber <= 1 || !rootConnector.useChangeIdContinuity) return false;
    if (!rootConnector.resolvePatchsetOptions) return false;
    if (!this.workspaceRunner.applyPriorPatchset) return false;

    const storedChanges = await this.stateStore.getChangesForTask(task.taskId);
    const rootChanges = storedChanges
      .filter((c) => c.repoKey === root.repoKey && c.status !== "NO_CHANGE" && c.changeId !== "")
      .sort((a, b) => a.commitIndex - b.commitIndex);

    const primaryChange = rootChanges.find((c) => c.commitIndex === 0);
    if (!primaryChange) return false;

    try {
      const patchsetOpts = await rootConnector.resolvePatchsetOptions(primaryChange.changeId);
      // The connector cannot know the repo path; supply the full clone URL
      // (base + repo) so `git fetch` has a valid remote to pull refs/changes from.
      await this.workspaceRunner.applyPriorPatchset(handle, { ...patchsetOpts, vcsBaseUrl: root.cloneUrl });
      log.info(
        { taskId: task.taskId, changeId: primaryChange.changeId, revisionNumber: patchsetOpts.revisionNumber, patchset: patchsetOpts.patchset },
        "checked out existing patchset for retry cycle"
      );

      // Cherry-pick secondary commits (indices 1..N) on top of the primary.
      // Each is a separate Gerrit change; resolve its latest patchset and cherry-pick.
      const secondaryChanges = rootChanges.filter((c) => c.commitIndex > 0);
      if (secondaryChanges.length > 0 && this.workspaceRunner.cherryPickPriorPatchset) {
        for (const change of secondaryChanges) {
          try {
            const secOpts = await rootConnector.resolvePatchsetOptions(change.changeId);
            await this.workspaceRunner.cherryPickPriorPatchset(handle, { ...secOpts, vcsBaseUrl: root.cloneUrl });
            log.info(
              { taskId: task.taskId, changeId: change.changeId, commitIndex: change.commitIndex, revisionNumber: secOpts.revisionNumber, patchset: secOpts.patchset },
              "cherry-picked secondary patchset for retry cycle"
            );
          } catch (err) {
            log.warn(
              { taskId: task.taskId, changeId: change.changeId, commitIndex: change.commitIndex, err },
              "failed to cherry-pick secondary patchset; agent will see partial history"
            );
            // Stop cherry-picking further commits — they likely depend on this one.
            break;
          }
        }
      }
      return true;
    } catch (err) {
      log.warn(
        { taskId: task.taskId, changeId: primaryChange.changeId, err },
        "failed to checkout patchset for retry; agent will work from fresh clone"
      );
      return false;
    }
  }

  /** Resolve the per-project agent adapter and resolved config from the project's agent record. */
  private async resolveProjectAgentRuntime(project: ProjectRecord | null): Promise<ProjectAgentRuntime> {
    if (!project || !this.projectMode) {
      throw new Error("Project agent runtime cannot be resolved outside project mode");
    }

    const agent = await this.projectMode.projectStore.getAgentById(project.agentId);
    if (!agent) {
      throw new Error(`Project agent ${project.agentId} was not found for project ${project.id}`);
    }
    if (!agent.enabled || agent.type !== "coding") {
      throw new Error(`Project agent ${agent.id} is not an enabled coding agent for project ${project.id}`);
    }
    if (!agent.integrationId) {
      throw new Error(`Project agent ${agent.id} has no agent integration configured`);
    }

    const adapter = this.projectMode.pluginManager.getConnectorForIntegration<AgentAdapter>(agent.integrationId);
    if (!adapter) {
      throw new Error(
        `Project agent adapter is unavailable for agent ${agent.id} ` +
        `(integration ${agent.integrationId}, project ${project.id})`
      );
    }

    const resolvedConfig = resolveAgentConfig(agent, project);

    // The agent's modelConfigJson rarely carries credentials; fall back to the
    // agent-execution integration's own configJson. This is provider-aware:
    // Copilot stores an OAuth `sessionToken` or a PAT (`token`); Claude stores
    // an `apiKey` (api_key mode) or an interactive-OAuth `sessionToken`
    // (subscription mode).
    //
    let encryptedSessionToken = resolvedConfig.encryptedSessionToken;
    let apiKey = resolvedConfig.apiKey;
    // Aider forwards backend credentials via `extra`; start from the resolved
    // extras so we don't clobber agent-level overrides.
    const extra: Record<string, unknown> = { ...resolvedConfig.extra };
    if (!encryptedSessionToken || !apiKey || Object.keys(extra).length === 0) {
      const integration = this.projectMode.pluginManager.getActiveIntegrationById?.(agent.integrationId);
      if (integration) {
        try {
          const integCfg = this.resolveIntegrationConfig(integration);
          if (integration.provider === "claude") {
            if (integCfg["authMode"] === "api_key") {
              if (!apiKey) {
                const key = integCfg["apiKey"];
                if (typeof key === "string" && key) apiKey = key;
              }
            } else if (!encryptedSessionToken) {
              const sess = integCfg["sessionToken"];
              if (typeof sess === "string" && sess) {
                encryptedSessionToken = sess;
              }
            }
          } else if (integration.provider === "codex") {
            // Codex stores its subscription credential under `accessToken`
            // (see src/plugins/descriptors/codex.ts), not `sessionToken`.
            if (integCfg["authMode"] === "api_key") {
              if (!apiKey) {
                const key = integCfg["apiKey"];
                if (typeof key === "string" && key) apiKey = key;
              }
            } else if (!encryptedSessionToken) {
              const token = integCfg["accessToken"];
              if (typeof token === "string" && token) {
                encryptedSessionToken = token;
              }
            }
          } else if (integration.provider === "aider") {
            // Aider carries a backend selector + that backend's API key / base
            // URL on the integration config. Forward them via `extra` so the
            // AiderAdapter can map them onto the litellm env vars. This must be
            // checked before the generic `!encryptedSessionToken` branch below,
            // since Aider never populates `encryptedSessionToken` and would
            // otherwise be swallowed by that branch and never forwarded.
            const backend = integCfg["aiderBackend"];
            const key = integCfg["aiderApiKey"];
            const base = integCfg["aiderApiBase"];
            if (typeof backend === "string" && backend) extra["aiderBackend"] = backend;
            if (typeof key === "string" && key) extra["aiderApiKey"] = key;
            if (typeof base === "string" && base) extra["aiderApiBase"] = base;
          } else if (integration.provider === "goose") {
            // Goose carries a provider selector + that provider's API key / base
            // URL on the integration config. Forward them via `extra` so the
            // GooseAdapter can map them onto the provider's auth env vars. This
            // must be checked before the generic `!encryptedSessionToken` branch
            // below, since Goose never populates `encryptedSessionToken` and
            // would otherwise be swallowed by that branch and never forwarded.
            const provider = integCfg["gooseProvider"];
            const key = integCfg["gooseApiKey"];
            const base = integCfg["gooseApiBase"];
            if (typeof provider === "string" && provider) extra["gooseProvider"] = provider;
            if (typeof key === "string" && key) extra["gooseApiKey"] = key;
            if (typeof base === "string" && base) extra["gooseApiBase"] = base;
          } else if (integration.provider === "opencode") {
            // OpenCode carries a provider selector + that provider's API key /
            // base URL on the integration config, exactly like Goose. Forward
            // them via `extra` so the OpenCodeAdapter can map them onto the
            // provider's auth env vars. This must be checked before the generic
            // `!encryptedSessionToken` branch below, since OpenCode never
            // populates `encryptedSessionToken` and would otherwise be
            // swallowed by that branch and never forwarded.
            const provider = integCfg["openCodeProvider"];
            const key = integCfg["openCodeApiKey"];
            const base = integCfg["openCodeApiBase"];
            if (typeof provider === "string" && provider) extra["openCodeProvider"] = provider;
            if (typeof key === "string" && key) extra["openCodeApiKey"] = key;
            if (typeof base === "string" && base) extra["openCodeApiBase"] = base;
          } else if (!encryptedSessionToken) {
            const t = integCfg["sessionToken"];
            if (typeof t === "string" && t) {
              encryptedSessionToken = t;
            } else if (integCfg["authMode"] === "pat") {
              const pat = integCfg["token"];
              if (typeof pat === "string" && pat) {
                encryptedSessionToken = encryptToken(pat, this.config.adminAuthSecret);
              }
            }
          }
        } catch { /* ignore */ }
      }
    }

    const authChanged =
      encryptedSessionToken !== resolvedConfig.encryptedSessionToken ||
      apiKey !== resolvedConfig.apiKey ||
      Object.keys(extra).length > 0;
    return {
      adapter,
      config: authChanged
        ? { ...resolvedConfig, encryptedSessionToken, apiKey, extra }
        : resolvedConfig,
    };
  }

  private resolveIntegrationConfig(integration: Integration): Record<string, unknown> {
    return this.projectMode?.pluginManager.decryptIntegrationConfig?.(integration)
      ?? JSON.parse(integration.configJson) as Record<string, unknown>;
  }

  /** Poll review system status; advance to MERGED, trigger a retry cycle, or stay IN_REVIEW. */
  /** Whether this task's project opts in to treating CI build failures as actionable feedback (default off). */
  private async projectReactsToCiFailures(task: Task): Promise<boolean> {
    if (!task.projectId || !this.projectMode) return false;
    const project = await this.projectMode.projectStore.getProjectById(task.projectId);
    return project?.reactToCiFailures ?? false;
  }

  private async checkReviewProgress(task: Task, streamChangeId?: string, streamComments?: import("../interfaces.js").ReviewComment[]): Promise<void> {
    await this.reviewProgressService.check(task, streamChangeId, streamComments);
  }

  /**
   * Returns the task's persisted pushRef if set, otherwise computes one via `compute()`,
   * persists it, and returns it. Guarantees a stable branch name across resume/retry cycles.
   */
  private async resolvePushRef(task: Task, compute: () => string): Promise<string> {
    if (task.pushRef) {
      return task.pushRef;
    }
    const ref = compute();
    await this.stateStore.setTaskPushRef(task.taskId, ref);
    return ref;
  }

  /**
   * Project-mode push: for each push target sorted by `commitOrder`, dirty-check and push.
   * Clean repos are recorded as NO_CHANGE. Per-target failures are isolated.
   */
  private async pushProjectChanges(
    task: Task,
    handle: WorkspaceHandle,
    pushTargets: import("../interfaces.js").ProjectPushTargetRecord[],
    fallbackCommitMessage: string,
    agentCommits: CommitDescriptor[] | undefined = undefined,
    topicOverride: string | null = null
  ): Promise<void> {
    const sorted = [...pushTargets].sort((a, b) => a.commitOrder - b.commitOrder);
    // Only repositories VE cloned itself (and whose `.git` it rebuilt from
    // host-trusted data) may be used as a host-side Git working directory. A
    // target whose clone failed would otherwise be an agent-authored directory
    // that the push would hand credentials to.
    const trustedRepoPaths = this.workspaceRunner.listTrustedRepoPaths
      ? new Set(this.workspaceRunner.listTrustedRepoPaths(handle))
      : null;

    let dirtyCount = 0;
    let successCount = 0;
    const pushErrors: Array<{ repoKey: string; err: unknown }> = [];

    for (const target of sorted) {
      if (trustedRepoPaths !== null && !trustedRepoPaths.has(target.localPath)) {
        const err = new Error(
          `Push target "${target.repoKey}" was not cloned by Virtual Engineer; refusing to push from an untrusted workspace path`
        );
        log.warn({ taskId: task.taskId, repoKey: target.repoKey, localPath: target.localPath }, err.message);
        pushErrors.push({ repoKey: target.repoKey, err });
        // An untrusted target is never dirty-checked, but it must still count as
        // an attempt so a cycle where nothing could be pushed fails loudly.
        dirtyCount++;
        continue;
      }
      // Check whether there are local commits ahead of origin that need pushing.
      // The agent always commits its work, so git status --porcelain is always empty
      // after a successful cycle. The only meaningful question is: are there commits
      // on this branch that haven't been pushed yet?
      let isDirty = false;
      if (this.workspaceRunner.execGitInVolume) {
        try {
          const aheadOut = await this.workspaceRunner.execGitInVolume(
            handle,
            ["rev-list", "--count", "HEAD", `^origin/${target.targetBranch}`],
            target.localPath
          );
          isDirty = (parseInt(aheadOut.trim(), 10) || 0) > 0;
        } catch (err) {
          // rev-list failed — assume there is something to push.
          log.warn({ taskId: task.taskId, repoKey: target.repoKey, err }, "git rev-list failed for project push target; assuming changes present");
          isDirty = true;
        }
      }

      if (!isDirty) {
        await this.stateStore.saveChangePerRepository(
          task.taskId,
          target.repoKey,
          "",
          "",
          "NO_CHANGE",
          target.integrationId,
          NO_REVIEW_SYSTEM,
          0,
          ""
        );
        log.info({ taskId: task.taskId, repoKey: target.repoKey }, "project push target had no changes");
        continue;
      }

      dirtyCount++;

      // Connector is only needed when the repo has changes to push.
      let vcsConnector: VcsConnector;
      try {
        vcsConnector = await this.resolveVcsConnectorForTarget(target.integrationId, { repoKey: target.repoKey });
      } catch (err) {
        log.warn(
          { taskId: task.taskId, repoKey: target.repoKey, integrationId: target.integrationId, err },
          "no VCS connector for push target; skipping"
        );
        pushErrors.push({ repoKey: target.repoKey, err });
        continue;
      }
      const { ref: computedRef, topic: computedTopic } = vcsConnector.buildPushSpec(
        target.targetBranch,
        task.taskId,
        task.ticketTitle
      );
      const ref = await this.resolvePushRef(task, () => computedRef);
      const topic = topicOverride?.trim() ? topicOverride.trim() : computedTopic;
      const reviewSystemLabel = vcsConnector.reviewSystemLabel;

      // Push runs host-side against the repo's working directory. Multi-repo
      // targets live in sub-directories of the workspace, so join the target's
      // localPath ("." for the root repo) onto the host workspace path.
      const repoDir = resolveWorkspaceSubPath(handle.hostWorkspacePath, target.localPath);
      try {
        const subjectHash = createHash("sha1").update(fallbackCommitMessage.split("\n")[0] ?? "").digest("hex");

        if (!vcsConnector.pushDirect) {
          throw new Error(`VCS connector for ${reviewSystemLabel} does not implement pushDirect`);
        }
        const pushResult = await vcsConnector.pushDirect(
          repoDir,
          ref,
          topic,
          target.reviewerEmails
        );

        // Use Change-Ids from agent commits when available — this is the source of truth
        // for multi-commit pushes where pushResult.changeId only reflects HEAD (the last commit).
        // The agent already injected deterministic Change-Ids into each commit before pushing.
        const repoCommits = (agentCommits ?? []).filter((c) => c.repoKey === target.repoKey);

        // Derive URL for a given Change-Id by replacing the head Change-Id in pushResult.url.
        // Falls back to pushResult.url when changeId is absent or replacement is not possible.
        const makeChangeUrl = (targetChangeId: string): string => {
          if (!pushResult.url) return "";
          if (pushResult.changeId && pushResult.url.includes(pushResult.changeId)) {
            return pushResult.url.replace(pushResult.changeId, targetChangeId);
          }
          return pushResult.url;
        };

        if (repoCommits.length > 1) {
          // Multi-commit: save each commit at its own index so the retry cycle can
          // retrieve commit[0]'s Change-Id and reuse it to produce a new patchset.
          for (let i = 0; i < repoCommits.length; i++) {
            const commit = repoCommits[i]!;
            const cHash = createHash("sha1").update(commit.subject).digest("hex");
            await this.stateStore.saveChangePerRepository(
              task.taskId,
              target.repoKey,
              commit.changeId,
              i === 0 ? makeChangeUrl(commit.changeId) : "",
              pushResult.status || "OPEN",
              target.integrationId,
              reviewSystemLabel,
              i,
              cHash
            );
          }
          log.info(
            { taskId: task.taskId, repoKey: target.repoKey, commitCount: repoCommits.length, firstChangeId: repoCommits[0]?.changeId },
            "pushed project target (multi-commit)"
          );
          // Orphan stale rows from prior cycles that had more commits than this one
          const orphaned = await this.stateStore.orphanExcessChanges(task.taskId, target.repoKey, repoCommits.length - 1);
          if (orphaned > 0) {
            log.info(
              { taskId: task.taskId, repoKey: target.repoKey, orphanedCount: orphaned },
              "marked excess change_per_repository rows as ORPHANED"
            );
          }
        } else {
          // Single-commit: prefer the agent's own Change-Id (commit[0]) over the VCS
          // push result which may differ when the connector re-reads from HEAD.
          const primaryChangeId = repoCommits[0]?.changeId || pushResult.changeId;
          await this.stateStore.saveChangePerRepository(
            task.taskId,
            target.repoKey,
            primaryChangeId,
            makeChangeUrl(primaryChangeId),
            pushResult.status || "OPEN",
            target.integrationId,
            reviewSystemLabel,
            0,
            subjectHash
          );
          log.info(
            { taskId: task.taskId, repoKey: target.repoKey, changeId: primaryChangeId, url: makeChangeUrl(primaryChangeId) },
            "pushed project target"
          );
          // Orphan stale rows from prior cycles that had more commits
          const orphaned = await this.stateStore.orphanExcessChanges(task.taskId, target.repoKey, 0);
          if (orphaned > 0) {
            log.info(
              { taskId: task.taskId, repoKey: target.repoKey, orphanedCount: orphaned },
              "marked excess change_per_repository rows as ORPHANED"
            );
          }
        }
        successCount++;
      } catch (err) {
        log.error(
          { taskId: task.taskId, repoKey: target.repoKey, err },
          "project push target push failed; continuing with remaining targets"
        );
        pushErrors.push({ repoKey: target.repoKey, err });
      }
    }

    // If every dirty target failed, surface the errors so the task transitions
    // to FAILED (visible in the UI) instead of silently advancing to IN_REVIEW.
    if (dirtyCount > 0 && successCount === 0 && pushErrors.length > 0) {
      const detail = pushErrors
        .map((e) => `${e.repoKey}: ${e.err instanceof Error ? e.err.message : String(e.err)}`)
        .join("; ");
      throw new Error(`All push targets failed: ${detail}`);
    }

    if (pushErrors.length > 0) {
      log.warn(
        { taskId: task.taskId, successCount, failedCount: pushErrors.length },
        "some push targets failed but at least one succeeded; proceeding to IN_REVIEW"
      );
    }
  }

  /** Re-enter review progress check from the FEEDBACK_PROCESSING state. */
  private async processFeedback(task: Task): Promise<void> {
    await this.checkReviewProgress(task);
  }

  /** Transition to CLOSING, close the external ticket with retry, and mark the task DONE. */
  private async closeTicket(task: Task): Promise<void> {
    task = await this.stateStore.transition(task.taskId, "CLOSING");
    const perRepoChanges = await this.stateStore.getChangesForTask(task.taskId);
    const firstActive = perRepoChanges.find((c) => c.status !== "NO_CHANGE" && c.status !== "ORPHANED");
    const changeRef = firstActive?.reviewUrl || `change ${task.externalChangeId ?? ""}`;

    const ticketConnector = await this.resolveTicketConnector(task);

    try {
      const closeResult = await pRetry(
        async () => {
          try {
            await ticketConnector.closeTicket(
              task.ticketId,
              `Virtual Engineer: ${changeRef} has been merged. Closing ticket automatically.`
            );
            return "closed" as const;
          } catch (err) {
            if (this.isTicketNotFoundError(err)) {
              return "not_found" as const;
            }
            throw err;
          }
        },
        { retries: this.config.ticketCloseMaxRetries ?? 5, minTimeout: this.config.ticketCloseRetryMinTimeoutMs ?? 5000 }
      );

      if (closeResult === "not_found") {
        log.warn(
          { taskId: task.taskId, ticketId: task.ticketId },
          "Redmine ticket no longer exists during close; marking task done"
        );
      }

      await this.stateStore.transition(task.taskId, "DONE");
      log.info({ taskId: task.taskId, ticketId: task.ticketId }, "task DONE — ticket closed");
    } catch (err) {
      await this.stateStore.setFailureReason(
        task.taskId,
        `Ticket close failed (change is merged): ${err instanceof Error ? err.message : String(err)}`
      );
      await this.stateStore.transition(task.taskId, "FAILED");
    }
  }

  /** Abandon a task when the agent cycle produced no file changes. */
  private async handleNoChange(task: Task, cycleNumber: number): Promise<void> {
    const reason = `Agent produced no changes after cycle ${cycleNumber}`;
    log.warn({ taskId: task.taskId }, reason);
    await this.stateStore.setFailureReason(task.taskId, reason);
    await this.stateStore.transition(task.taskId, "ABANDONED");
    await this.notifyTicketFailure(task, reason);
  }

  /** Persist a failure reason and transition the task to ABANDONED, then notify the ticket. */
  private async handleAbandoned(task: Task, reason: string): Promise<void> {
    log.warn({ taskId: task.taskId, reason }, "task abandoned");
    await this.stateStore.setFailureReason(task.taskId, reason);
    await this.stateStore.transition(task.taskId, "ABANDONED");
    await this.notifyTicketFailure(task, reason);
  }

  /** Handle unexpected errors by persisting them and transitioning the task to FAILED. */
  private async handleFatalError(task: Task, err: unknown): Promise<void> {
    // If the task no longer exists (deleted externally while running), there is
    // nothing to persist — log and bail out.
    const current = await this.stateStore.getTask(task.taskId).catch(() => null);
    if (!current) {
      log.warn({ taskId: task.taskId, err }, "task no longer exists; cannot record fatal error");
      return;
    }

    if (this.isTicketNotFoundError(err)) {
      const reason = `Ticket ${task.ticketId} (${task.ticketSourceLabel}) was not found`;
      log.warn({ taskId: task.taskId, ticketId: task.ticketId, err }, "ticket missing during task execution");

      try {
        await this.stateStore.setFailureReason(task.taskId, reason);
        await this.stateStore.transition(task.taskId, "FAILED", { error: reason });
      } catch (innerErr) {
        log.error({ taskId: task.taskId, innerErr }, "failed to record fatal error in state store");
      }

      return;
    }

    const reason = err instanceof Error ? err.message : String(err);
    const safeReason = redactUrls(reason);
    log.error({ taskId: task.taskId, err: safeReason }, "fatal task error");
    try {
      await this.stateStore.setFailureReason(task.taskId, safeReason);
      await this.stateStore.transition(task.taskId, "FAILED", { error: safeReason });
      // Infrastructure / connectivity / config errors (e.g. the Gerrit SSH
      // connection cannot be established) are already surfaced in the admin UI.
      // Posting them as a ticket note duplicates that view and adds noise to the
      // ticket-following process, so skip the notification for those.
      if (isInfrastructureError(err)) {
        log.warn(
          { taskId: task.taskId, ticketId: task.ticketId },
          "infrastructure error — skipping ticket failure note"
        );
      } else {
        await this.notifyTicketFailure(task, `Virtual Engineer encountered an error: ${safeReason}`);
      }
    } catch (innerErr) {
      log.error({ taskId: task.taskId, innerErr }, "failed to record fatal error in state store");
    }
  }

  /** Post a failure note to the external ticket to inform stakeholders. */
  private async notifyTicketFailure(task: Task, reason: string): Promise<void> {
    await this.addTicketNote(
      task,
      `Virtual Engineer was unable to complete this task.\n\nReason: ${reason}\n\nTask ID: ${task.taskId}`,
      false
    );
  }

  /** Append a note to the external ticket, returning false on non-fatal errors. */
  private async addTicketNote(
    task: Pick<Task, "taskId" | "ticketId" | "projectId">,
    note: string,
    isPrivate = false
  ): Promise<boolean> {
    try {
      const ticketConnector = await this.resolveTicketConnector(task);
      await ticketConnector.addNote(task.ticketId, note, isPrivate);
      return true;
    } catch (err) {
      if (this.isTicketNotFoundError(err)) {
        log.warn({ taskId: task.taskId, ticketId: task.ticketId }, "skipping note because ticket no longer exists");
        return false;
      }

      if (this.isTicketApiError(err)) {
        log.warn(
          { taskId: task.taskId, ticketId: task.ticketId, statusCode: (err).statusCode, err },
          "failed to add note to ticket (non-fatal)"
        );
        return false;
      }

      log.warn({ taskId: task.taskId, ticketId: task.ticketId, err }, "failed to add note to ticket (non-fatal)");
      return false;
    }
  }

  /** Collect prior agent-cycle failure logs as feedback items for the next cycle. */
  private async buildPriorFeedback(task: Task, reviewFeedback: FeedbackItem[] = []): Promise<FeedbackItem[]> {
    const cycles = await this.stateStore.getAgentCycles(task.taskId);
    const feedback: FeedbackItem[] = [];
    const lastCycle = cycles.at(-1);
    if (lastCycle?.result.status === "failed" && lastCycle.result.agentLogs) {
      feedback.push({
        source: "lint_failure",
        content: lastCycle.result.agentLogs.slice(0, 3000),
      });
    }
    return [...feedback, ...reviewFeedback];
  }

  /**
   * Fallback commit message used when the agent-worker does not return a valid
   * Conventional Commits message. Produces a clean `feat: <subject>` string
   * (max 72 chars, no trailing period). The agent-provided message is preferred
   * when it passes validation in CopilotAdapter.
   */
  private buildCommitMessage(_task: Task, ticketSubject: string): string {
    const subject = ticketSubject.slice(0, 72).replace(/\.$/, "");
    return `feat: ${subject}`;
  }

  /** Abort an operation at its deadline and await its termination before rejecting. */
  private withTimeout<T>(
    operation: Promise<T> | ((signal: AbortSignal) => Promise<T>),
    timeoutMs: number,
    message: string,
  ): Promise<T> {
    const controller = new AbortController();
    if (typeof operation !== "function") {
      const wrappedPromise = new Promise<T>((resolve, reject) => {
        const legacyTimer = setTimeout(() => {
          clearTimeout(legacyTimer);
          reject(new Error(message));
        }, timeoutMs);
        operation.then(
          (value) => {
            clearTimeout(legacyTimer);
            resolve(value);
          },
          (err: unknown) => {
            clearTimeout(legacyTimer);
            reject(toRejectionError(err));
          },
        );
      });
      void wrappedPromise.catch(() => undefined);
      return wrappedPromise;
    }
    return (async (): Promise<T> => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      try {
        return await operation(controller.signal);
      } catch (err) {
        if (timedOut) throw new Error(message);
        throw err;
      } finally {
        clearTimeout(timer);
      }
    })();
  }

  /** Type guard: true when the error originates from a missing ticket. */
  private isTicketNotFoundError(err: unknown): err is TicketNotFoundError {
    return err instanceof TicketNotFoundError;
  }

  /** Type guard: true when the error is a ticket API HTTP error. */
  private isTicketApiError(err: unknown): err is TicketApiError {
    return err instanceof TicketApiError;
  }
}
