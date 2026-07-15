import pRetry from "p-retry";
import { randomUUID, createHash } from "crypto";
import { formatTicketFooter, hasTicketFooter } from "../utils/ticketFooterFormatter.js";
import type {
  AgentAdapter,
  CommitDescriptor,
  FeedbackItem,
  ExternalChangeId,
  IntegrationBindingContext,
  ReviewConnector,
  TicketConnector,
  StateStore,
  Task,
  TaskContext,
  TicketId,
  WorkspaceRunner,
  WorkspaceHandle,
  ProjectRecord,
  ResolvedAgentConfig,
  RepositoryMap,
  ProjectPushTargetRecord,
} from "../interfaces.js";
import { makeTaskId, makeTicketId, TERMINAL_STATES, TicketApiError, TicketNotFoundError } from "../interfaces.js";
import type { CodeGenState } from "../interfaces.js";
import type { IntegrationStore } from "../interfaces.js";
import { getLogger } from "../logger.js";
import { FeedbackProcessor } from "./feedbackProcessor.js";
import { clearTaskEventBuffer } from "../agents/agentEventBus.js";
import { normalizeAgentResult, getModifiedFileCount } from "../agents/agentEventTypes.js";
import type { VcsConnector } from "../vcs/vcsConnector.js";
import { NO_REVIEW_SYSTEM } from "../vcs/vcsConnector.js";
import { VcsConnectorFactory } from "../vcs/vcsFactory.js";
import { decryptToken, encryptToken } from "../utils/encryption.js";
import { redactUrls } from "../utils/redactUrl.js";
import { isInfrastructureError } from "../utils/errorClassifier.js";
import type { ConcurrencyTracker } from "./concurrencyTracker.js";
import { resolveAgentConfig } from "../state/stateStore.js";

const log = getLogger("orchestrator");

/** Integration types that clone via HTTPS and need a token injected into the clone URL. */
const HTTPS_VCS_TYPES = new Set(["github", "gitlab"]);

/**
 * Build an authenticated HTTPS clone URL for GitHub/GitLab push targets so the
 * agent container can run `git clone` without interactive credential prompts.
 * Returns undefined for non-HTTPS integrations (Gerrit) or on any error.
 */
function buildAuthenticatedCloneUrl(
  rawCloneUrl: string,
  integrationType: string,
  encryptedToken: unknown,
  adminAuthSecret: string | undefined
): string | undefined {
  if (!HTTPS_VCS_TYPES.has(integrationType)) return undefined;
  if (typeof encryptedToken !== "string" || !encryptedToken) return undefined;
  let token: string;
  try {
    token = decryptToken(encryptedToken, adminAuthSecret);
  } catch (err) {
    // Backward-compatibility: older rows may still contain raw PAT strings.
    // Use the raw value as a last resort so private HTTPS clones keep working.
    token = encryptedToken;
    log.warn({ integrationType, cloneUrl: rawCloneUrl, err }, "failed to decrypt token for authenticated clone URL; falling back to raw token value");
  }
  if (/^\*{4,}$/.test(token)) return undefined;
  const usernamePrefix = integrationType === "github" ? "x-access-token" : "oauth2";
  try {
    const normalised = rawCloneUrl.startsWith("git@")
      ? rawCloneUrl.replace(/^git@([^:]+):(.+?)(?:\.git)?$/, "https://$1/$2.git")
      : rawCloneUrl;
    const parsed = new URL(normalised);
    parsed.username = usernamePrefix;
    parsed.password = token;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export interface OrchestratorConfig {
  maxAgentCycles: number;
  maxRetryAttempts: number;
  agentTimeoutMs: number;
  gitAuthorName: string;
  gitAuthorEmail: string;
  agentContainerImage: string;
  adminAuthSecret?: string | undefined;
}

/**
 * Project-mode dependencies. When provided, the orchestrator resolves
 * agent + VCS connectors via project relations rather than env-var fallback.
 */
export interface ProjectModeDeps {
  projectStore: {
    getProjectById(id: import("../interfaces.js").ProjectId): Promise<ProjectRecord | null>;
    listProjectPushTargets(id: import("../interfaces.js").ProjectId): Promise<import("../interfaces.js").ProjectPushTargetRecord[]>;
    getProjectTicketSource(id: import("../interfaces.js").ProjectId): Promise<import("../interfaces.js").ProjectTicketSourceRecord | null>;
    getProjectReviewConfig(id: import("../interfaces.js").ProjectId): Promise<import("../interfaces.js").ProjectReviewConfig | null>;
    getAgentById(id: import("../interfaces.js").AgentId): Promise<import("../interfaces.js").AgentRecord | null>;
  };
  pluginManager: {
    getConnectorForIntegration<T>(integrationId: string): T | null;
    getConnectorForCapability?<T>(integrationId: string, capability: import("../interfaces.js").DomainCapability): T | null;
    createConnectorForCapability?<T>(integrationId: string, capability: import("../interfaces.js").DomainCapability, context?: IntegrationBindingContext): Promise<T | null>;
    createConnectorForIntegration?<T>(integrationId: string, context?: IntegrationBindingContext): Promise<T | null>;
    getActiveIntegrationById?(integrationId: string): import("../interfaces.js").Integration | null;
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

interface ProjectAgentRuntime {
  adapter: AgentAdapter;
  config: ResolvedAgentConfig;
}

/**
 * Drives the ticket-driven code-generation lifecycle: clone → agent → push → review → merge → close.
 * Persists all state via `StateStore`; resumes in-flight tasks after a restart via `resumeActiveTasks()`.
 */
export class Orchestrator {
  private readonly feedbackProcessor: FeedbackProcessor;
  private config: OrchestratorConfig;
  private vcsConnector: VcsConnector | undefined;
  private readonly vcsConnectorFactory: VcsConnectorFactory;
  private projectMode: ProjectModeDeps | null = null;
  constructor(
    config: OrchestratorConfig,
    private readonly stateStore: StateStore,
    private readonly workspaceRunner: WorkspaceRunner,
    vcsConnector?: VcsConnector,
    private readonly integrationStore?: IntegrationStore,
    projectMode?: ProjectModeDeps
  ) {
    this.config = config;
    this.vcsConnectorFactory = new VcsConnectorFactory({ adminAuthSecret: config.adminAuthSecret });
    this.vcsConnector = vcsConnector;
    this.feedbackProcessor = new FeedbackProcessor(stateStore);
    this.projectMode = projectMode ?? null;
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
    const task = await this.stateStore.createTask(
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

    log.debug(
      { taskId: task.taskId, changeId, state: task.state, ticketId: task.ticketId },
      "handling review event for task"
    );

    if (TERMINAL_STATES.has(task.state)) {
      log.debug({ taskId: task.taskId, state: task.state }, "task already in terminal state, ignoring review event");
      return;
    }

    if (task.state !== "IN_REVIEW") {
      log.debug({ taskId: task.taskId, state: task.state }, "task not in IN_REVIEW, ignoring review event");
      return;
    }

    await this.checkReviewProgress(task);
  }

  /** Gerrit-flavoured alias for handleReviewEvent. */
  async handleGerritEvent(changeId: ExternalChangeId): Promise<void> {
    await this.handleReviewEvent(changeId);
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
    if (TERMINAL_STATES.has(task.state)) {
      log.info({ taskId: task.taskId, state: task.state, externalChangeId }, "webhook feedback: task terminal, ignoring");
      return;
    }
    if (task.state !== "IN_REVIEW") {
      log.info({ taskId: task.taskId, state: task.state, externalChangeId }, "webhook feedback: task not IN_REVIEW, ignoring");
      return;
    }
    log.info({ taskId: task.taskId, integrationId, externalChangeId }, "webhook feedback: triggering review progress check");
    await this.checkReviewProgress(task, externalChangeId, streamComments);
  }

  /** Webhook handler: mark the associated task's change as merged and close its ticket. */
  async markChangeMerged(integrationId: string, externalChangeId: string): Promise<void> {
    const task = await this.stateStore.findTaskByExternalChangeId(integrationId, externalChangeId);
    if (!task) {
      log.info({ integrationId, externalChangeId }, "webhook merged: no task for change, ignoring");
      return;
    }
    if (TERMINAL_STATES.has(task.state)) {
      log.info({ taskId: task.taskId, state: task.state }, "webhook merged: task terminal, ignoring");
      return;
    }

    // Code-review tasks wait in REVIEW_WATCHING after posting comments.
    // When the patchset merges, close the review task immediately.
    if (task.state === "REVIEW_WATCHING") {
      log.info({ taskId: task.taskId, externalChangeId }, "webhook merged: marking review task REVIEW_DONE");
      await this.stateStore.transition(task.taskId, "REVIEW_DONE");
      return;
    }

    if (task.state !== "IN_REVIEW") {
      log.info({ taskId: task.taskId, state: task.state }, "webhook merged: task not IN_REVIEW/REVIEW_WATCHING, ignoring");
      return;
    }

    log.info({ taskId: task.taskId, externalChangeId }, "webhook merged: closing ticket");
    const merged = await this.stateStore.transition(task.taskId, "MERGED");
    await this.closeTicket(merged);
  }

  /** Webhook handler: mark the associated task as abandoned when a change is externally abandoned. */
  async markChangeAbandoned(integrationId: string, externalChangeId: string): Promise<void> {
    const task = await this.stateStore.findTaskByExternalChangeId(integrationId, externalChangeId);
    if (!task) {
      log.info({ integrationId, externalChangeId }, "webhook abandoned: no task for change, ignoring");
      return;
    }
    if (TERMINAL_STATES.has(task.state)) {
      log.info({ taskId: task.taskId, state: task.state }, "webhook abandoned: task terminal, ignoring");
      return;
    }
    log.info({ taskId: task.taskId, externalChangeId }, "webhook abandoned: marking task ABANDONED");
    await this.handleAbandoned(task, "change was abandoned externally (webhook)");
  }

  /** Resume an existing task's workflow, typically after a manual retry. */
  async continueTask(taskId: TicketId | ReturnType<typeof makeTaskId>): Promise<void> {
    const task = await this.stateStore.getTask(makeTaskId(String(taskId)));
    if (!task) {
      throw new Error(`Task not found: ${String(taskId)}`);
    }

    await this.runWorkflow(task);
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
    let cycleSlot: { projectId: import("../interfaces.js").ProjectId; agentId: import("../interfaces.js").AgentId } | null = null;
    const projectIdForCycle = task.projectId ?? (await this.stateStore.getTask(task.taskId))?.projectId ?? null;
    if (!task.projectId && projectIdForCycle) {
      task.projectId = projectIdForCycle;
    }
    if (projectIdForCycle && this.projectMode?.concurrencyTracker) {
      const project = await this.projectMode.projectStore.getProjectById(projectIdForCycle);
      if (project) {
        const acquired = await this.projectMode.concurrencyTracker.acquire(project.id, project.agentId);
        if (!acquired) {
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
        cycleSlot = { projectId: project.id, agentId: project.agentId };
      }
    }

    const ticketConnector = await this.resolveTicketConnector(task);
    const ticket = await ticketConnector.getTicket(task.ticketId);
    const priorFeedback = await this.buildPriorFeedback(task, reviewFeedback);
    const cycleNumber = await this.stateStore.incrementCycle(task.taskId);

    log.info({ taskId: task.taskId, cycleNumber }, "starting agent cycle");

    task = await this.stateStore.transition(task.taskId, "AGENT_RUNNING");
    const handle = await this.workspaceRunner.createWorkspace(task.taskId);

    try {
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
      let cloneKnownHostsPath: string | undefined;
      try {
        const rootConnectorForClone = await this.resolveVcsConnectorForTarget(root.integrationId, { repoKey: root.repoKey, targetBranch: root.targetBranch });
        cloneKnownHostsPath = rootConnectorForClone.sshKnownHostsPath ?? undefined;
      } catch {
        // Non-fatal — clone proceeds without strict host key checking
      }

      const enrichedPushTargets = await Promise.all(
        projectPushTargets.map(async (pt) => {
          try {
            // Inject authenticated HTTPS clone URL for GitHub/GitLab targets
            const integration = await (this.integrationStore ?? (this.stateStore as unknown as IntegrationStore)).getIntegration(pt.integrationId);
            if (integration) {
              const cfg = JSON.parse(integration.configJson) as Record<string, unknown>;
              const authUrl = buildAuthenticatedCloneUrl(pt.cloneUrl, integration.provider, cfg["token"], this.config.adminAuthSecret);
              if (authUrl !== undefined) return { ...pt, cloneUrl: authUrl };
            }
          } catch {
            // Non-fatal — fall through to SSH key enrichment
          }
          if (pt.sshKeyPath !== null) return pt;
          try {
            const connector = await this.resolveVcsConnectorForTarget(pt.integrationId, { repoKey: pt.repoKey, targetBranch: pt.targetBranch });
            const fallbackKey = connector.sshKeyPath ?? undefined;
            const fallbackAgentPub = (connector as { sshAgentPubKeyPath?: string | undefined }).sshAgentPubKeyPath ?? undefined;
            if (fallbackKey !== undefined) return { ...pt, sshKeyPath: fallbackKey };
            if (fallbackAgentPub !== undefined) return { ...pt, sshKeyPath: null, sshAgentPubKeyPath: fallbackAgentPub };
            // SSH agent mode with no identity pinning — leave sshKeyPath null
            return pt;
          } catch {
            return pt;
          }
        })
      );

      const cloneResult = await this.workspaceRunner.prepareProjectWorkspace(
        handle,
        enrichedPushTargets,
        projectRecord.postCloneScript,
        cloneKnownHostsPath
      );
      if (!cloneResult.success) {
        throw new Error(`Failed to prepare project workspace: ${cloneResult.error ?? "unknown error"}`);
      }

      const commitMessage = this.buildCommitMessage(task, ticket.subject);
      const projectAgentRuntime = await this.resolveProjectAgentRuntime(projectRecord);
      const resolvedCopilotModel = projectAgentRuntime
        ? projectAgentRuntime.config.model?.trim() || undefined
        : undefined;
      const _rawReasoningEffort = projectAgentRuntime?.config.extra["reasoningEffort"];
      const resolvedReasoningEffort = typeof _rawReasoningEffort === "string" ? _rawReasoningEffort : undefined;
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

      const hasPriorPatchset = await this.checkoutPriorPatchset(task, cycleNumber, handle, root, rootConnector);
      const context: TaskContext = {
        taskId: task.taskId,
        ticketTitle: ticket.subject,
        ticketDescription: ticket.description,
        acceptanceCriteria: this.extractAcceptanceCriteria(ticket.description),
        baseBranch: cloneBranch,
        workspacePath: handle.hostWorkspacePath,
        volumeName: handle.volumeName,
        homeVolumeName: handle.homeVolumeName,
        constraints: [],
        priorFeedback,
        cycleNumber,
        hasPriorPatchset,
        commitMessage,
        ticketUrl: ticket.webUrl,
        ...(projectAgentRuntime
          ? {
              systemPromptId: projectAgentRuntime.config.systemPromptId,
              // On retry cycles, swap in the feedback-specific instructions prompt when one is configured.
              instructionsPromptId:
                cycleNumber > 1 && projectAgentRuntime.config.feedbackInstructionsPromptId
                  ? projectAgentRuntime.config.feedbackInstructionsPromptId
                  : projectAgentRuntime.config.instructionsPromptId,
            }
          : {}),
        agentSession: {
          agentContainerImage: this.config.agentContainerImage,
          repoCloneUrl: cloneUrl,
          pushRef,
          existingChangeId: rootConnector.useChangeIdContinuity ? (task.externalChangeId ?? undefined) : undefined,
          perRepoChangeIds: await (async (): Promise<Record<string, string | Record<string, string>> | undefined> => {
            if (!rootConnector.useChangeIdContinuity) return undefined;
            const storedChanges = await this.stateStore.getChangesForTask(task.taskId);
            if (storedChanges.length === 0) return undefined;
            // Pass ALL commit Change-Ids per repo, keyed by commit index.
            // Single-commit repos produce a flat string (backward compat).
            // Multi-commit repos produce { "0": "I...", "1": "I..." }.
            const validChanges = storedChanges.filter(
              (c) => c.status !== "NO_CHANGE" && c.changeId !== ""
            );
            if (validChanges.length === 0) return undefined;
            const byRepo = new Map<string, Map<number, string>>();
            for (const c of validChanges) {
              let m = byRepo.get(c.repoKey);
              if (!m) { m = new Map(); byRepo.set(c.repoKey, m); }
              m.set(c.commitIndex, c.changeId);
            }
            const result: Record<string, string | Record<string, string>> = {};
            for (const [repoKey, indexMap] of byRepo) {
              if (indexMap.size === 1 && indexMap.has(0)) {
                result[repoKey] = indexMap.get(0)!;
              } else {
                const obj: Record<string, string> = {};
                for (const [idx, cid] of indexMap) obj[String(idx)] = cid;
                result[repoKey] = obj;
              }
            }
            return Object.keys(result).length > 0 ? result : undefined;
          })(),
          gitAuthorName: this.config.gitAuthorName,
          gitAuthorEmail: this.config.gitAuthorEmail,
          githubToken: projectAgentRuntime?.config.apiKey,
          ...(projectAgentRuntime?.config.encryptedSessionToken
            ? { encryptedSessionToken: projectAgentRuntime.config.encryptedSessionToken }
            : {}),
          ...(resolvedCopilotModel ? { copilotModel: resolvedCopilotModel } : {}),
          ...(resolvedReasoningEffort !== undefined ? { copilotReasoningEffort: resolvedReasoningEffort } : {}),
          ...(projectPushTargets.length > 1 || projectPushTargets.some((t) => t.localPath !== ".")
            ? { repositoryMap: buildRepositoryMap(projectPushTargets) }
            : {}),
          ...(projectRecord.skillDiscoveryEnabled ? { skillDiscoveryEnabled: true } : {}),
          ...((): { ticketFooterLine?: string } => {
            if (!projectRecord.useFullTicketUrlInCommits) return {};
            const line = formatTicketFooter(task.ticketId, ticket.webUrl ?? "", task.ticketSourceLabel, true);
            return line ? { ticketFooterLine: line } : {};
          })(),
        },
      };

      const agentResult = await this.withTimeout(
        this.workspaceRunner.runAgent(handle, context, projectAgentRuntime?.adapter ?? undefined),
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

        const retryTask = await this.stateStore.transition(task.taskId, "RETRY_CYCLE");
        await this.runAgentCycle(retryTask);
        return;
      }

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
          handle,
          projectPushTargets,
          commitMessage,
          context.ticketUrl ?? "",
          agentResult.commits,
          projectRecord.gerritTopicOverride
        );
      }

      task = await this.stateStore.transition(task.taskId, "IN_REVIEW");
      const ticketConn = await this.resolveTicketConnector(task);
      await ticketConn.transitionToInReview(task.ticketId);

      // Opt-in (default off — most teams already surface this via standard VCS/ticket
      // integrations): post the review URL(s) as a ticket note. Cross-project fix-up:
      // the ticket lives in one repo/project, but the fix may land in a different one
      // (e.g. jami-client-qt ticket, jami-daemon patch), so a bare "#123"-style reference
      // wouldn't resolve to the right place — the full URL is unambiguous regardless of
      // which repo(s) received commits. Only on cycle 1: later cycles just add patchsets
      // to the same change/URL.
      if (projectRecord?.postReviewLinkToTicket && cycleNumber === 1) {
        const changes = await this.stateStore.getChangesForTask(task.taskId);
        const links = changes
          .filter((c) => c.status !== "NO_CHANGE" && c.status !== "ORPHANED" && c.reviewUrl)
          .map((c) => `${c.repoKey}: ${c.reviewUrl}`);
        if (links.length > 0) {
          await this.addTicketNote(task, `Virtual Engineer opened a review:\n\n${links.join("\n")}`, false);
        }
      }
    } finally {
      try {
        await this.workspaceRunner.destroyWorkspace(handle);
      } catch (err) {
        log.warn(
          { taskId: task.taskId, err },
          "workspace cleanup failed (non-fatal, task state unaffected)"
        );
      }
      if (cycleSlot && this.projectMode?.concurrencyTracker) {
        this.projectMode.concurrencyTracker.release(cycleSlot.projectId, cycleSlot.agentId);
      }
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
      await this.workspaceRunner.applyPriorPatchset(handle, patchsetOpts);
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
            const secOpts = await rootConnector.resolvePatchsetOptions!(change.changeId);
            await this.workspaceRunner.cherryPickPriorPatchset(handle, secOpts);
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
  private async resolveProjectAgentRuntime(project: ProjectRecord | null): Promise<ProjectAgentRuntime | null> {
    if (!project || !this.projectMode) {
      return null;
    }

    const agent = await this.projectMode.projectStore.getAgentById(project.agentId);
    if (!agent?.integrationId) {
      return null;
    }

    const adapter = this.projectMode.pluginManager.getConnectorForIntegration<AgentAdapter>(agent.integrationId);
    if (!adapter) {
      log.warn(
        { projectId: project.id, agentId: agent.id, integrationId: agent.integrationId },
        "project agent integration is not active; falling back to the runtime adapter"
      );
      return null;
    }

    const resolvedConfig = resolveAgentConfig(agent, project);

    // The agent's modelConfigJson rarely carries credentials; fall back to the
    // agent-execution integration's own configJson. This is provider-aware:
    // Copilot stores an OAuth `sessionToken` or a PAT (`token`); Claude stores
    // an `apiKey` (api_key mode) or an interactive-OAuth `sessionToken`
    // (subscription mode).
    //
    // NOTE: `apiKey` is read from the RAW configJson (user-entered password
    // fields are stored plaintext at rest; only the OAuth `sessionToken` is
    // AES-encrypted). If password-at-rest encryption is ever added, decrypt it
    // here before use.
    let encryptedSessionToken = resolvedConfig.encryptedSessionToken;
    let apiKey = resolvedConfig.apiKey;
    if (!encryptedSessionToken || !apiKey) {
      const integration = this.projectMode.pluginManager.getActiveIntegrationById?.(agent.integrationId);
      if (integration) {
        try {
          const integCfg = JSON.parse(integration.configJson) as Record<string, unknown>;
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
      apiKey !== resolvedConfig.apiKey;
    return {
      adapter,
      config: authChanged
        ? { ...resolvedConfig, encryptedSessionToken, apiKey }
        : resolvedConfig,
    };
  }

  /** Poll review system status; advance to MERGED, trigger a retry cycle, or stay IN_REVIEW. */
  private async checkReviewProgress(task: Task, streamChangeId?: string, streamComments?: import("../interfaces.js").ReviewComment[]): Promise<void> {
    // Check for per-repository changes first (multi-repo path)
    const perRepoChanges = await this.stateStore.getChangesForTask(task.taskId);
    if (perRepoChanges.length > 0) {
      await this.checkMultiRepoReviewProgress(task, perRepoChanges, streamChangeId, streamComments);
      return;
    }

    // Single-repo path (legacy)
    const changeId = task.externalChangeId;
    if (!changeId) {
      log.warn({ taskId: task.taskId }, "IN_REVIEW but no gerritChangeId — waiting");
      return;
    }

    const reviewConnector = await this.resolveReviewConnector(task);

    let status: string;
    try {
      status = await reviewConnector.getChangeStatus(changeId);
    } catch (err) {
      log.warn({ taskId: task.taskId, changeId, err }, "failed to fetch Gerrit change status — staying IN_REVIEW");
      return;
    }

    if (status === "MERGED") {
      log.info({ taskId: task.taskId }, "change MERGED");
      task = await this.stateStore.transition(task.taskId, "MERGED");
      await this.closeTicket(task);
      return;
    }

    if (status === "ABANDONED") {
      await this.handleAbandoned(task, "change was abandoned externally");
      return;
    }

    // Fetch unresolved comments on the latest patchset only. Anchoring the
    // review to the current patchset (instead of the root) prevents VE from
    // repeatedly acting on stale comments from earlier patchsets.
    const comments = await reviewConnector.getUnresolvedComments(
      changeId,
      task.currentPatchset
    );
    // Also collect any failed CI check runs so the agent can fix them.
    const ciComments = reviewConnector.getCICheckFailures
      ? await reviewConnector.getCICheckFailures(changeId).catch((err: unknown) => {
          log.warn({ taskId: task.taskId, changeId, err }, "failed to fetch CI check failures (non-fatal)");
          return [] as import("../interfaces.js").ReviewComment[];
        })
      : [];
    const baseComments = ciComments.length > 0 ? [...comments, ...ciComments] : comments;
    const allComments = streamComments && streamComments.length > 0 ? [...streamComments, ...baseComments] : baseComments;

    task = await this.stateStore.transition(task.taskId, "FEEDBACK_PROCESSING");
    const [feedbackItems, processedComments] = await this.feedbackProcessor.extractNewFeedback(
      task.taskId,
      changeId,
      allComments
    );

    if (feedbackItems.length === 0) {
      log.debug({ taskId: task.taskId }, "no new actionable comments, back to IN_REVIEW");
      task = await this.stateStore.transition(task.taskId, "IN_REVIEW");
      return;
    }

    if (task.cycleCount > this.config.maxAgentCycles) {
      await this.handleAbandoned(task, `Max cycles ${this.config.maxAgentCycles} reached during review`);
      return;
    }

    log.info(
      { taskId: task.taskId, feedbackCount: feedbackItems.length },
      "actionable feedback found, starting retry cycle"
    );
    task = await this.stateStore.transition(task.taskId, "RETRY_CYCLE");
    await this.runAgentCycle(task, feedbackItems);

    const updatedTask = await this.stateStore.getTask(task.taskId);
    if (updatedTask?.state !== "IN_REVIEW") {
      return;
    }

    if (processedComments.length > 0) {
      try {
        await reviewConnector.resolveComments(changeId, processedComments);
        log.info({ taskId: task.taskId, count: processedComments.length }, "resolved review comments");
      } catch (err) {
        log.warn({ taskId: task.taskId, err }, "failed to resolve Gerrit comments (non-fatal)");
      }
    }
  }

  /**
   * Multi-repo review progress. Polls each per-repository change:
   * transitions to MERGED when ALL repos are merged, ABANDONED if ANY is abandoned,
   * or aggregates feedback and triggers a retry cycle.
   */
  private async checkMultiRepoReviewProgress(
    task: Task,
    perRepoChanges: import("../interfaces.js").ChangePerRepository[],
    streamChangeId?: string,
    streamComments?: import("../interfaces.js").ReviewComment[]
  ): Promise<void> {
    const activeChanges = perRepoChanges.filter((c) => c.status !== "NO_CHANGE" && c.status !== "ORPHANED");
    if (activeChanges.length === 0) {
      log.info({ taskId: task.taskId }, "all per-repo changes are NO_CHANGE, treating as merged");
      task = await this.stateStore.transition(task.taskId, "MERGED");
      await this.closeTicket(task);
      return;
    }

    // Lazy fallback: only resolved if a change lacks its own integration connector.
    let _fallbackReviewConnector: ReviewConnector | undefined;
    const getFallbackReviewConnector = async (): Promise<ReviewConnector> => {
      if (!_fallbackReviewConnector) {
        _fallbackReviewConnector = await this.resolveReviewConnector(task);
      }
      return _fallbackReviewConnector;
    };

    // Poll each repo's change status
    let allMerged = true;
    let anyAbandoned = false;
    const allFeedback: FeedbackItem[] = [];
    const allProcessedComments: import("../interfaces.js").ReviewComment[] = [];

    for (const change of activeChanges) {
      // Use the non-throwing target resolver here — a transient factory failure
      // should log and skip, not abort the whole task.
      const changeConnector: VcsConnector | import("../interfaces.js").ReviewConnector | undefined =
        (change.integrationId
          ? await this.tryResolveVcsConnectorForTarget(change.integrationId, { repoKey: change.repoKey })
          : this.vcsConnector ?? await getFallbackReviewConnector());
      if (!changeConnector) {
        log.warn(
          { taskId: task.taskId, repoKey: change.repoKey, integrationId: change.integrationId },
          "skipping per-repo review polling because the repo connector is unavailable"
        );
        allMerged = false;
        continue;
      }

      try {
        let currentStatus: string;
        if (changeConnector && "getChangeStatus" in changeConnector) {
          currentStatus = await (changeConnector as VcsConnector).getChangeStatus(change.changeId);
        } else {
          currentStatus = await (await getFallbackReviewConnector()).getChangeStatus(
            change.changeId as ExternalChangeId
          );
        }

        // Update stored status if changed
        if (currentStatus !== change.status) {
          await this.stateStore.updateChangePerRepositoryStatus(
            task.taskId,
            change.repoKey,
            currentStatus,
            change.changeId
          );
          log.info(
            { taskId: task.taskId, repoKey: change.repoKey, oldStatus: change.status, newStatus: currentStatus },
            "per-repo change status updated"
          );
        }

        if (currentStatus === "ABANDONED") {
          anyAbandoned = true;
        } else if (currentStatus !== "MERGED") {
          allMerged = false;
        }

        // Gather feedback for non-merged repos
        if (currentStatus === "OPEN" || currentStatus === "NEW") {
          try {
            let comments: import("../interfaces.js").ReviewComment[];
            if ("getUnresolvedComments" in changeConnector && typeof (changeConnector as VcsConnector).getUnresolvedComments === "function") {
              comments = await (changeConnector as VcsConnector).getUnresolvedComments!(change.changeId);
            } else {
              comments = await (await getFallbackReviewConnector()).getUnresolvedComments(
                change.changeId as ExternalChangeId
              );
            }
            // Collect CI check failures via the fallback review connector (which may implement getCICheckFailures).
            let ciComments: import("../interfaces.js").ReviewComment[] = [];
            try {
              const ciSource = await getFallbackReviewConnector();
              if (ciSource.getCICheckFailures) {
                ciComments = await ciSource.getCICheckFailures(change.changeId as ExternalChangeId);
              }
            } catch (ciErr) {
              log.warn(
                { taskId: task.taskId, repoKey: change.repoKey, err: ciErr },
                "failed to fetch CI check failures for repo (non-fatal)"
              );
            }
            // Prepend stream-event comment when it belongs to this specific change.
            // Required because Gerrit's `gerrit query --comments` only returns inline file
            // comments, not top-level change messages — the stream event payload is the
            // only reliable source of general review feedback for Gerrit.
            const extraComments = (streamChangeId === change.changeId && streamComments && streamComments.length > 0)
              ? streamComments
              : [];
            const allComments = [
              ...(extraComments.length > 0 ? extraComments : []),
              ...comments,
              ...ciComments,
            ];
            const [feedback, processed] = await this.feedbackProcessor.extractNewFeedback(
              task.taskId,
              change.changeId as ExternalChangeId,
              allComments
            );
            // Tag feedback with repoKey for agent context
            for (const item of feedback) {
              allFeedback.push({
                ...item,
                content: `[${change.repoKey}] ${item.content}`,
              });
            }
            allProcessedComments.push(...processed);
          } catch (err) {
            log.warn(
              { taskId: task.taskId, repoKey: change.repoKey, err },
              "failed to fetch feedback for repo (non-fatal)"
            );
          }
        }
      } catch (err) {
        log.warn(
          { taskId: task.taskId, repoKey: change.repoKey, changeId: change.changeId, err },
          "failed to poll per-repo change status (non-fatal)"
        );
        allMerged = false;
      }
    }

    // Convergence: if any repo is abandoned, abandon the whole task
    if (anyAbandoned) {
      const abandonedRepos = activeChanges
        .filter((c) => c.status === "ABANDONED")
        .map((c) => c.repoKey);
      await this.handleAbandoned(
        task,
        `Change abandoned externally for repositories: ${abandonedRepos.join(", ")}`
      );
      return;
    }

    // Convergence: all repos merged → task is merged
    if (allMerged) {
      log.info(
        { taskId: task.taskId, repoCount: activeChanges.length },
        "all per-repo changes MERGED — task converged"
      );
      task = await this.stateStore.transition(task.taskId, "MERGED");
      await this.closeTicket(task);
      return;
    }

    // Process aggregated feedback
    task = await this.stateStore.transition(task.taskId, "FEEDBACK_PROCESSING");

    if (allFeedback.length === 0) {
      log.debug({ taskId: task.taskId }, "no new multi-repo feedback, back to IN_REVIEW");
      task = await this.stateStore.transition(task.taskId, "IN_REVIEW");
      return;
    }

    if (task.cycleCount > this.config.maxAgentCycles) {
      await this.handleAbandoned(task, `Max cycles ${this.config.maxAgentCycles} reached during multi-repo review`);
      return;
    }

    log.info(
      { taskId: task.taskId, feedbackCount: allFeedback.length },
      "multi-repo feedback found, starting retry cycle"
    );
    task = await this.stateStore.transition(task.taskId, "RETRY_CYCLE");
    await this.runAgentCycle(task, allFeedback);

    const updatedTask = await this.stateStore.getTask(task.taskId);
    if (updatedTask?.state !== "IN_REVIEW") {
      return;
    }

    // Resolve processed comments per-repo using the correct connector for each change
    for (const change of activeChanges) {
      // Only resolve comments that belong to this repo's change (filter by repoKey in filePath)
      const repoComments = allProcessedComments.filter(
        (c) => !c.filePath || c.filePath.startsWith(change.repoKey + "/") || c.filePath === change.repoKey
      );
      if (repoComments.length === 0) continue;

      const changeConnector: VcsConnector | import("../interfaces.js").ReviewConnector | undefined =
        (change.integrationId
          ? await this.tryResolveVcsConnectorForTarget(change.integrationId, { repoKey: change.repoKey })
          : this.vcsConnector ?? await getFallbackReviewConnector());
      if (!changeConnector) {
        log.warn(
          { taskId: task.taskId, repoKey: change.repoKey, integrationId: change.integrationId },
          "skipping comment resolution because the repo connector is unavailable"
        );
        continue;
      }

      try {
        if ("resolveComments" in changeConnector && typeof (changeConnector as VcsConnector).resolveComments === "function") {
          await (changeConnector as VcsConnector).resolveComments!(change.changeId, repoComments);
        } else {
          await (await getFallbackReviewConnector()).resolveComments(
            change.changeId as ExternalChangeId,
            repoComments
          );
        }
      } catch (err) {
        log.warn(
          { taskId: task.taskId, repoKey: change.repoKey, err },
          "failed to resolve comments for repo (non-fatal)"
        );
      }
    }
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
    ticketUrl: string,
    agentCommits: CommitDescriptor[] | undefined = undefined,
    topicOverride: string | null = null
  ): Promise<void> {
    const sorted = [...pushTargets].sort((a, b) => a.commitOrder - b.commitOrder);

    let dirtyCount = 0;
    let successCount = 0;
    const pushErrors: Array<{ repoKey: string; err: unknown }> = [];

    for (const target of sorted) {
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

      const volumeOpts = { volumeName: handle.volumeName, image: handle.containerImage, subPath: target.localPath };
      try {
        const commitMsg = this.appendTicketFooter(fallbackCommitMessage, task.ticketId, ticketUrl, task.ticketSourceLabel);
        const subjectHash = createHash("sha1").update(fallbackCommitMessage.split("\n")[0] ?? "").digest("hex");

        let pushResult;
        if (vcsConnector.pushDirect) {
          pushResult = await vcsConnector.pushDirect(handle.hostWorkspacePath, ref, topic, volumeOpts);
        } else {
          pushResult = await vcsConnector.push(handle.hostWorkspacePath, ref, commitMsg, undefined, volumeOpts);
        }

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
        { retries: 5, minTimeout: 5000 }
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
          { taskId: task.taskId, ticketId: task.ticketId, statusCode: (err as TicketApiError).statusCode, err },
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

  /**
   * Appends a ticket reference footer to a conventional commit message.
   *
   * The footer is formatted using the modular ticketFooterFormatter utility,
   * which supports any configured ticketing system in ID format: "System: #ticketId"
   *
   * Footer is skipped if the message already contains an existing footer
   * (idempotent — safe to call multiple times).
   */
  private appendTicketFooter(message: string, ticketId: string, ticketUrl: string, ticketSourceLabel?: string): string {
    if (hasTicketFooter(message, ticketSourceLabel)) {
      return message;
    }

    const footer = this.buildTicketFooter(ticketId, ticketUrl, ticketSourceLabel);
    if (!footer) return message;

    return `${message.trimEnd()}\n\n${footer}\n`;
  }

  /**
   * Builds the footer line using the modular ticketFooterFormatter utility.
   * Returns null if no footer is applicable (unknown system or missing data).
   *
   * All supported systems use ID format: "System: #ticketId"
   * This is simple, consistent, and works across all review systems (GitLab, Gerrit, etc.)
   * and is future-proof for new ticketing systems.
   *
   * To add support for a new ticketing system:
   * 1. Add configuration to TICKET_SYSTEM_CONFIG in ticketFooterFormatter.ts
   * 2. No changes needed here — automatically supported.
   */
  private buildTicketFooter(ticketId: string, ticketUrl: string, ticketSourceLabel?: string): string | null {
    return formatTicketFooter(ticketId, ticketUrl, ticketSourceLabel);
  }

  /** Extract acceptance-criteria lines (checklist or numbered items) from a ticket description. */
  private extractAcceptanceCriteria(description: string): string[] {
    return description
      .split("\n")
      .filter((line) => /^\s*[-*]\s+\[[ x]\]/.test(line) || /^\s*\d+\.\s+/.test(line))
      .map((line) => line.trim());
  }

  /** Race a promise against a timeout, rejecting with `message` if it expires first. */
  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    const wrappedPromise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        clearTimeout(timer);
        reject(new Error(message));
      }, timeoutMs);

      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });

    void wrappedPromise.catch(() => undefined);

    return wrappedPromise;
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

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a {@link RepositoryMap} from a project's push targets so the agent
 * container knows which subdirectories map to which repositories.
 *
 * The target with `localPath === "."` (or the lowest `commitOrder` if none) is
 * treated as the superproject; all others become submodules.
 */
export function buildRepositoryMap(pushTargets: ProjectPushTargetRecord[]): RepositoryMap {
  const sorted = [...pushTargets].sort((a, b) => a.commitOrder - b.commitOrder);
  const rootIdx = sorted.findIndex((t) => t.localPath === ".");
  const root = rootIdx >= 0 ? sorted[rootIdx]! : sorted[0]!;
  const rest = sorted.filter((t) => t !== root);

  return {
    superproject: { repoKey: root.repoKey, localPath: root.localPath },
    submodules: rest.map((t) => ({ repoKey: t.repoKey, localPath: t.localPath })),
  };
}
