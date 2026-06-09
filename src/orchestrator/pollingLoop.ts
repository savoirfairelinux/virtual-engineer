import type { Orchestrator } from "./orchestrator.js";
import type { TicketConnector } from "../interfaces.js";
import type { StateStore } from "../interfaces.js";
import type {
  IntegrationBindingContext,
  ProjectRecord,
  ProjectTicketSourceRecord,
  ProjectReviewConfig,
  ProjectId,
  ReviewDiscoveryConnector,
  ReviewAssignmentDiscovery,
} from "../interfaces.js";
import { makeTicketId, TERMINAL_STATES } from "../interfaces.js";
import { getLogger } from "../logger.js";

const log = getLogger("polling-loop");

export interface PollingConfig {
  ticketIntervalMs: number;
  maxRetryAttempts: number;
}

/**
 * Minimal project store contract used by the polling loop.
 * `SqliteStateStore` already satisfies this interface structurally.
 */
export interface ProjectAwareStore {
  listProjects(filter?: { type?: "coding" | "review"; enabled?: boolean }): Promise<ProjectRecord[]>;
  getProjectTicketSource(projectId: ProjectId): Promise<ProjectTicketSourceRecord | null>;
  getProjectReviewConfig(projectId: ProjectId): Promise<ProjectReviewConfig | null>;
}

/**
 * Trigger interface used by the polling loop to start a review task for a
 * newly discovered PR/MR where VE has been assigned as reviewer.
 */
export interface ReviewAssignmentTrigger {
  triggerReview(integrationId: string, changeId: string): Promise<void>;
}

/**
 * Minimal plugin manager contract used by the polling loop.
 */
export interface ProjectAwarePluginManager {
  getConnectorForIntegration<T>(integrationId: string): T | null;
  createConnectorForIntegration?<T>(integrationId: string, context?: IntegrationBindingContext): Promise<T | null>;
  /**
   * Returns true when the integration's descriptor declares a `streamEvents`
   * factory, meaning review discovery is driven by a live event stream rather
   * than polling.  Optional so tests that don't need this can omit it.
   */
  integrationHasStreamEvents?(integrationId: string): boolean;
}

/**
 * Orchestrator hook to start a task wired to a specific project.
 * Called once per (project, ticket) pair during project-mode polling.
 */
export interface ProjectAwareOrchestrator {
  startTaskForProject(
    ticket: { id: string; subject?: string; description?: string; webUrl?: string | undefined },
    project: ProjectRecord,
    ticketSourceLabel: string
  ): Promise<void>;
}

/**
 * Periodically checks the ticket system for newly assigned work. Errors are caught and logged.
 * In production, replace with webhooks for lower latency.
 */
export class PollingLoop {
  private ticketTimer: NodeJS.Timeout | null = null;
  private running = false;
  /** Consecutive polling failure count — used to compute exponential backoff. */
  private ticketFailureCount = 0;
  /** Timestamp (ms) until which polling is suppressed due to repeated failures. */
  private ticketBackoffUntil = 0;
  private projectStore: ProjectAwareStore | null = null;
  private pluginManager: ProjectAwarePluginManager | null = null;
  private reviewTrigger: ReviewAssignmentTrigger | null = null;
  /** Per-changeId timestamp of last review poll — prevents redundant API calls within the same interval. */
  private readonly reviewPollCooldowns = new Map<string, number>();

  constructor(
    private readonly config: PollingConfig,
    private readonly orchestrator: Orchestrator,
    private readonly stateStore: StateStore,
    projectMode?: {
      projectStore: ProjectAwareStore;
      pluginManager: ProjectAwarePluginManager;
      reviewTrigger?: ReviewAssignmentTrigger | undefined;
    }
  ) {
    if (projectMode) {
      this.projectStore = projectMode.projectStore;
      this.pluginManager = projectMode.pluginManager;
      this.reviewTrigger = projectMode.reviewTrigger ?? null;
    }
  }

  /** Enable or refresh project-mode polling at runtime without a restart. */
  setProjectMode(mode: {
    projectStore: ProjectAwareStore;
    pluginManager: ProjectAwarePluginManager;
  } | null): void {
    if (mode) {
      this.projectStore = mode.projectStore;
      this.pluginManager = mode.pluginManager;
    } else {
      this.projectStore = null;
      this.pluginManager = null;
    }
  }

  /** Set or clear the review trigger used by `pollReviewProjects`. */
  setReviewTrigger(trigger: ReviewAssignmentTrigger | null): void {
    this.reviewTrigger = trigger;
  }

  /** Reset exponential backoff counters after a successful poll. */
  resetBackoff(): void {
    this.ticketFailureCount = 0;
    this.ticketBackoffUntil = 0;
  }

  /** Begin polling: run immediately on start, then on the configured interval. */
  start(): void {
    if (this.running) return;
    this.running = true;

    log.info(
      { ticketIntervalMs: this.config.ticketIntervalMs },
      "polling loop started"
    );

    // Run immediately on start, then on interval
    this.runTicketPollCycle("initial ticket poll failed");

    this.ticketTimer = setInterval(() => {
      this.runTicketPollCycle("ticket poll error");
    }, this.config.ticketIntervalMs);
  }

  /** Stop the polling interval timer. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.ticketTimer) clearInterval(this.ticketTimer);
    log.info("polling loop stopped");
  }

  /** Return whether the polling loop is currently active. */
  isRunning(): boolean {
    return this.running;
  }

  /** Return the configured polling interval in milliseconds. */
  getIntervals(): { intervalMs: number } {
    return {
      intervalMs: this.config.ticketIntervalMs,
    };
  }

  /** Execute one ticket-poll cycle, applying exponential backoff on failure. */
  private runTicketPollCycle(errorMessage: string): void {
    if (Date.now() < this.ticketBackoffUntil) {
      return;
    }

    this.pollTickets()
      .then(() => {
        this.ticketFailureCount = 0;
        this.ticketBackoffUntil = 0;
      })
      .catch((err: unknown) => {
        this.ticketFailureCount += 1;
        this.ticketBackoffUntil = Date.now() + this.computeBackoffDelay(this.config.ticketIntervalMs, this.ticketFailureCount);
        log.error({ err, backoffUntil: this.ticketBackoffUntil }, errorMessage);
      });
  }

  /** Compute the exponential backoff delay for a given failure count (caps at 8× base interval). */
  private computeBackoffDelay(baseIntervalMs: number, failureCount: number): number {
    const multiplier = 2 ** Math.min(failureCount, 3);
    return baseIntervalMs * multiplier;
  }

  /** Dispatch to project-mode polling; a no-op when no project store is configured. */
  private async pollTickets(): Promise<void> {
    log.debug("polling all projects and active tasks");
    const tasks: Array<Promise<void>> = [this.pollInReviewTasks(), this.pollReviewWatchingTasks()];
    if (this.projectStore && this.pluginManager) {
      tasks.push(this.pollProjectTickets(), this.pollReviewProjects());
    }
    await Promise.all(tasks);
  }

  // ─── Project-mode iteration ────────────────────────────────────────────────

  /** Poll each enabled coding project's ticket source and start tasks for newly assigned tickets. */
  async pollProjectTickets(): Promise<void> {
    if (!this.projectStore || !this.pluginManager) return;
    const projects = await this.projectStore.listProjects({ type: "coding", enabled: true });
    log.debug({ count: projects.length }, "polling project tickets");

    for (const project of projects) {
      const ticketSource = await this.projectStore.getProjectTicketSource(project.id);
      if (!ticketSource) {
        log.debug({ projectId: project.id }, "skipping project: no ticket source configured");
        continue;
      }
      const connector = this.pluginManager.createConnectorForIntegration
        ? await this.pluginManager.createConnectorForIntegration<TicketConnector>(
          ticketSource.integrationId,
          { ticketProjectKey: ticketSource.ticketProjectKey }
        )
        : this.pluginManager.getConnectorForIntegration<TicketConnector>(ticketSource.integrationId);
      if (!connector) {
        log.debug(
          { projectId: project.id, integrationId: ticketSource.integrationId },
          "skipping project: ticket source integration not active"
        );
        continue;
      }
      try {
        const tickets = await connector.getAssignedTickets({ projectKey: ticketSource.ticketProjectKey });
        // Source label scheme: <integrationType>:<integrationId> so two projects sharing the same
        // connector type but different integration rows have independent failure counts.
        const integrationType = connector.getSourceLabel();
        const sourceLabel = `${integrationType}:${ticketSource.integrationId}`;

        const orchestratorWithProjectMode = this.orchestrator as unknown as Partial<ProjectAwareOrchestrator>;
        for (const ticket of tickets) {
          const ticketId = makeTicketId(ticket.id);
          const existing = await this.stateStore.getTaskByTicketId(ticketId);
          if (existing && !TERMINAL_STATES.has(existing.state)) {
            continue;
          }
          // FAILED allows retry; all other terminal states skip without a new task.
          if (existing && existing.state !== "FAILED") {
            continue;
          }
          const failedAttemptsCount = await this.stateStore.getFailedAttemptCount(ticketId, sourceLabel);
          if (failedAttemptsCount >= this.config.maxRetryAttempts) {
            log.warn(
              { ticketId, source: sourceLabel, failedAttemptsCount },
              "project ticket exceeded max retry attempts"
            );
            continue;
          }

          if (typeof orchestratorWithProjectMode.startTaskForProject === "function") {
            Promise.resolve()
              .then(() =>
                orchestratorWithProjectMode.startTaskForProject!(
                  { id: ticket.id as string, subject: ticket.subject, description: ticket.description, webUrl: ticket.webUrl },
                  project,
                  sourceLabel
                )
              )
              .catch((err: unknown) =>
                log.error({ ticketId, projectId: project.id, err }, "failed to start project task")
              );
          } else {
            log.warn({ ticketId, projectId: project.id }, "orchestrator missing startTaskForProject; skipping");
          }
        }
      } catch (err) {
        log.warn({ projectId: project.id, err }, "project ticket poll failed");
      }
    }
  }

  // ─── Review assignment polling ─────────────────────────────────────────────

  /**
   * For each enabled review project, poll open PRs/MRs where VE is a
   * requested reviewer and fire the review trigger for each new discovery.
   * Requires `reviewTrigger` to be set; no-op otherwise.
   */
  async pollReviewProjects(): Promise<void> {
    if (!this.projectStore || !this.pluginManager || !this.reviewTrigger) return;
    const projects = await this.projectStore.listProjects({ type: "review", enabled: true });
    log.debug({ count: projects.length }, "polling review project assignments");

    for (const project of projects) {
      const reviewConfig = await this.projectStore.getProjectReviewConfig(project.id);
      if (!reviewConfig) {
        log.debug({ projectId: project.id }, "skipping review project: no review config");
        continue;
      }

      // Stream-events integrations (e.g. Gerrit) receive review assignments
      // via a persistent SSH connection — they never need to be polled.
      if (this.pluginManager.integrationHasStreamEvents?.(reviewConfig.integrationId)) {
        log.trace(
          { projectId: project.id, integrationId: reviewConfig.integrationId },
          "skipping review project poll: integration uses stream events for review discovery"
        );
        continue;
      }

      const connector = this.pluginManager.getConnectorForIntegration<ReviewDiscoveryConnector>(
        reviewConfig.integrationId
      );
      if (!connector || typeof (connector as ReviewDiscoveryConnector).getOpenReviewAssignments !== "function") {
        log.debug(
          { projectId: project.id, integrationId: reviewConfig.integrationId },
          "skipping review project: connector does not support review discovery"
        );
        continue;
      }

      let assignments: ReviewAssignmentDiscovery[];
      try {
        assignments = await connector.getOpenReviewAssignments(reviewConfig.repos);
      } catch (err) {
        log.warn({ projectId: project.id, err }, "review assignment poll failed");
        continue;
      }

      const trigger = this.reviewTrigger;
      const now = Date.now();
      const cooldownMs = this.config.ticketIntervalMs;
      for (const assignment of assignments) {
        const cooldownKey = `${reviewConfig.integrationId}:${assignment.changeId}`;
        const lastTriggered = this.reviewPollCooldowns.get(cooldownKey);
        if (lastTriggered !== undefined && now - lastTriggered < cooldownMs) {
          log.debug({ changeId: assignment.changeId }, "skipping recently triggered review assignment");
          continue;
        }
        this.reviewPollCooldowns.set(cooldownKey, now);
        Promise.resolve()
          .then(() => trigger.triggerReview(reviewConfig.integrationId, assignment.changeId))
          .catch((err: unknown) =>
            log.error(
              { projectId: project.id, changeId: assignment.changeId, err },
              "failed to trigger review for discovered assignment"
            )
          );
      }
    }
  }

  // ─── IN_REVIEW code-gen task polling ──────────────────────────────────────

  /**
   * For each active code-gen task stuck in `IN_REVIEW`, re-check the review
   * system for new CHANGES_REQUESTED feedback. This is the polling equivalent
   * of the Gerrit stream-events trigger for GitHub / GitLab integrations.
   */
  async pollInReviewTasks(): Promise<void> {
    const activeTasks = await this.stateStore.getActiveTasks();
    const inReviewTasks = activeTasks.filter(
      (t) => t.taskType === "code-gen" && t.state === "IN_REVIEW" && t.externalChangeId != null
    );
    log.debug({ count: inReviewTasks.length }, "polling in-review code-gen tasks");

    const now = Date.now();
    const cooldownMs = this.config.ticketIntervalMs;

    // Evict stale cooldown entries for tasks that are no longer IN_REVIEW.
    const activeChangeIds = new Set(inReviewTasks.map((t) => t.externalChangeId!));
    for (const key of this.reviewPollCooldowns.keys()) {
      if (!activeChangeIds.has(key as import("../interfaces.js").ExternalChangeId)) {
        this.reviewPollCooldowns.delete(key);
      }
    }

    for (const task of inReviewTasks) {
      // externalChangeId is guaranteed non-null by the filter above
      const changeId = task.externalChangeId!;

      // Skip tasks already polled within the current interval to avoid
      // flooding the review API when many tasks are IN_REVIEW simultaneously.
      const lastPolled = this.reviewPollCooldowns.get(changeId);
      if (lastPolled !== undefined && now - lastPolled < cooldownMs) {
        log.debug({ taskId: task.taskId, changeId }, "skipping recently polled in-review task");
        continue;
      }
      this.reviewPollCooldowns.set(changeId, now);

      Promise.resolve()
        .then(() => this.orchestrator.handleReviewEvent(changeId))
        .catch((err: unknown) =>
          log.error({ taskId: task.taskId, changeId, err }, "failed to check in-review task progress")
        );
    }
  }

  // ─── REVIEW_WATCHING fallback polling ─────────────────────────────────────

  /**
   * Polling fallback for code-review tasks in REVIEW_WATCHING.
   * Compensates for missed `change-merged` stream events by actively querying
   * the review system for the current change status every polling interval.
   */
  async pollReviewWatchingTasks(): Promise<void> {
    const activeTasks = await this.stateStore.getActiveTasks();
    const watchingTasks = activeTasks.filter(
      (t) => t.taskType === "code-review" && t.state === "REVIEW_WATCHING" && t.externalChangeId != null
    );
    log.debug({ count: watchingTasks.length }, "polling review-watching code-review tasks");

    const now = Date.now();
    const cooldownMs = this.config.ticketIntervalMs;

    for (const task of watchingTasks) {
      const changeId = task.externalChangeId!;

      const lastPolled = this.reviewPollCooldowns.get(changeId);
      if (lastPolled !== undefined && now - lastPolled < cooldownMs) {
        log.debug({ taskId: task.taskId, changeId }, "skipping recently polled review-watching task");
        continue;
      }
      this.reviewPollCooldowns.set(changeId, now);

      Promise.resolve()
        .then(() => this.orchestrator.checkReviewWatchingTask(task.taskId))
        .catch((err: unknown) =>
          log.error({ taskId: task.taskId, changeId, err }, "failed to check review-watching task status")
        );
    }
  }

}

