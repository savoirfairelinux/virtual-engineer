import type { Orchestrator } from "./orchestrator.js";
import type { TicketConnector } from "../interfaces.js";
import type { StateStore } from "../interfaces.js";
import type {
  IntegrationBindingContext,
  ProjectRecord,
  ProjectTicketSourceRecord,
  ProjectId,
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
}

/**
 * Minimal plugin manager contract used by the polling loop.
 */
export interface ProjectAwarePluginManager {
  getConnectorForIntegration<T>(integrationId: string): T | null;
  createConnectorForIntegration?<T>(integrationId: string, context?: IntegrationBindingContext): Promise<T | null>;
}

/** Minimal concurrency tracker contract used by the polling loop. */
export interface PollingConcurrencyTracker {
  canStart(projectId: ProjectId, agentId: import("../interfaces.js").AgentId): Promise<boolean>;
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
  private concurrencyTracker: PollingConcurrencyTracker | null = null;
  /**
   * Projects deferred because a concurrency limit was hit on the current tick.
   * Logged at most once per tick to avoid log spam.
   */
  private deferredFullProjects = new Set<string>();

  constructor(
    private readonly config: PollingConfig,
    private readonly orchestrator: Orchestrator,
    private readonly stateStore: StateStore,
    projectMode?: {
      projectStore: ProjectAwareStore;
      pluginManager: ProjectAwarePluginManager;
      concurrencyTracker?: PollingConcurrencyTracker;
    }
  ) {
    if (projectMode) {
      this.projectStore = projectMode.projectStore;
      this.pluginManager = projectMode.pluginManager;
      this.concurrencyTracker = projectMode.concurrencyTracker ?? null;
    }
  }

  /** Enable or refresh project-mode polling at runtime without a restart. */
  setProjectMode(mode: {
    projectStore: ProjectAwareStore;
    pluginManager: ProjectAwarePluginManager;
    concurrencyTracker?: PollingConcurrencyTracker;
  } | null): void {
    if (mode) {
      this.projectStore = mode.projectStore;
      this.pluginManager = mode.pluginManager;
      this.concurrencyTracker = mode.concurrencyTracker ?? null;
    } else {
      this.projectStore = null;
      this.pluginManager = null;
      this.concurrencyTracker = null;
    }
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
    log.debug("polling ticket system for assigned tickets");
    // Project-mode polling is the only supported path. When no projects are
    // configured the loop is effectively idle.
    if (this.projectStore && this.pluginManager) {
      await this.pollProjectTickets();
    }
  }

  // ─── Project-mode iteration ────────────────────────────────────────────────

  /** Poll each enabled coding project's ticket source and start tasks for newly assigned tickets. */
  async pollProjectTickets(): Promise<void> {
    if (!this.projectStore || !this.pluginManager) return;
    const projects = await this.projectStore.listProjects({ type: "coding", enabled: true });
    log.debug({ count: projects.length }, "polling project tickets");
    // Reset the deferred-log debounce each tick so each tick logs at most once.
    this.deferredFullProjects.clear();

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
            // Short-circuit when concurrency limits are reached.
            // Avoids creating a task row that would immediately defer.
            if (this.concurrencyTracker) {
              const canStart = await this.concurrencyTracker.canStart(project.id, project.agentId);
              if (!canStart) {
                if (!this.deferredFullProjects.has(project.id)) {
                  log.info(
                    { projectId: project.id, agentId: project.agentId },
                    "project full (concurrency limit reached), deferred"
                  );
                  this.deferredFullProjects.add(project.id);
                }
                continue;
              }
            }
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

}

