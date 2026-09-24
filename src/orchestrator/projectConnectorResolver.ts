import type {
  IntegrationBindingContext,
  IntegrationStore,
  Integration,
  ReviewConnector,
  StateStore,
  Task,
  TicketConnector,
} from "../interfaces.js";
import { ProjectReconfigurationIncompatibleError } from "../domain/projectConfiguration.js";
import { selectReviewRepository } from "../domain/reviewRepository.js";
import { getLogger } from "../logger.js";
import type { VcsConnector } from "../vcs/vcsConnector.js";
import { VcsConnectorFactory } from "../vcs/vcsFactory.js";
import { resolveIntegrationConfig } from "./integrationConfig.js";
import type { ProjectModeDeps } from "./projectMode.js";
import { parseIntegrationIdFromSourceLabel } from "../utils/ticketSourceLabel.js";

const log = getLogger("project-connector-resolver");

export interface ProjectConnectorResolverDependencies {
  getProjectMode: () => ProjectModeDeps | null;
  stateStore: StateStore;
  integrationStore?: IntegrationStore;
  vcsConnectorFactory: VcsConnectorFactory;
}

/** Resolves project-bound ticket, review, and VCS connectors. */
export class ProjectConnectorResolver {
  constructor(private readonly dependencies: ProjectConnectorResolverDependencies) {}

  /** Resolve a VCS connector for a push target, tolerating transient failures. */
  async tryResolveVcsConnectorForTarget(
    integrationId: string,
    context?: IntegrationBindingContext,
  ): Promise<VcsConnector | undefined> {
    try {
      const mode = this.dependencies.getProjectMode();
      if (mode?.resolveVcsForIntegration) {
        return (await mode.resolveVcsForIntegration(integrationId, context)) ?? undefined;
      }
      return await this.resolveConnectorForIntegration(integrationId, context);
    } catch (err) {
      log.warn({ integrationId, context, err }, "failed to resolve VCS connector for target");
      return undefined;
    }
  }

  /** Resolve a VCS connector for a push target, throwing when unavailable. */
  async resolveVcsConnectorForTarget(
    integrationId: string,
    context?: IntegrationBindingContext,
  ): Promise<VcsConnector> {
    const connector = await this.tryResolveVcsConnectorForTarget(integrationId, context);
    if (!connector) {
      throw new Error(`No VCS connector available for integration ${integrationId}`);
    }
    return connector;
  }

  /** Resolve a VCS connector through the integration store and factory. */
  async resolveConnectorForIntegration(
    integrationId: string,
    context?: IntegrationBindingContext,
  ): Promise<VcsConnector | undefined> {
    try {
      const store = this.dependencies.integrationStore
        ?? (this.dependencies.stateStore as unknown as IntegrationStore);
      const integration = await store.getIntegration(integrationId);
      if (integration && integration.enabled) {
        return this.dependencies.vcsConnectorFactory.getConnector(integration, context);
      }
    } catch (err) {
      log.warn({ integrationId, err }, "failed to resolve connector for integration");
    }
    return undefined;
  }

  resolveIntegrationConfig(integration: Integration): Record<string, unknown> {
    const mode = this.dependencies.getProjectMode();
    if (!mode) return JSON.parse(integration.configJson) as Record<string, unknown>;
    return resolveIntegrationConfig(mode, integration);
  }

  /** Resolve the ticket connector for a project-bound task. */
  async resolveTicketConnector(
    task: Pick<Task, "taskId" | "projectId" | "ticketSourceIntegrationId" | "ticketSourceProjectKey">,
  ): Promise<TicketConnector> {
    const mode = this.dependencies.getProjectMode();
    if (!task.projectId || !mode) {
      throw new Error(`Task ${task.taskId} is not project-bound; cannot resolve ticket connector`);
    }
    const ticketSource = await mode.projectStore.getProjectTicketSource(task.projectId);
    if (!ticketSource) {
      if (task.ticketSourceIntegrationId != null || task.ticketSourceProjectKey != null) {
        throw new ProjectReconfigurationIncompatibleError(
          `Ticket source was removed from project ${task.projectId} while task ${task.taskId} was active. Manual retry is required.`,
        );
      }
      throw new Error(`No ticket source configured for project ${task.projectId} (task ${task.taskId})`);
    }

    const hasTicketSourceSnapshot =
      task.ticketSourceIntegrationId != null || task.ticketSourceProjectKey != null;
    if (
      hasTicketSourceSnapshot &&
      (task.ticketSourceIntegrationId !== ticketSource.integrationId ||
        task.ticketSourceProjectKey !== ticketSource.ticketProjectKey)
    ) {
      throw new ProjectReconfigurationIncompatibleError(
        `Ticket source changed while task ${task.taskId} was active: it was created from ${task.ticketSourceIntegrationId ?? "an unknown integration"}/${task.ticketSourceProjectKey ?? "an unknown project"}, but project ${task.projectId} now uses ${ticketSource.integrationId}/${ticketSource.ticketProjectKey}. Manual retry is required.`,
      );
    }

    const connector = mode.pluginManager.createConnectorForCapability
      ? await mode.pluginManager.createConnectorForCapability<TicketConnector>(
        ticketSource.integrationId,
        "issue_tracking",
        { ticketProjectKey: ticketSource.ticketProjectKey },
      )
      : mode.pluginManager.createConnectorForIntegration
        ? await mode.pluginManager.createConnectorForIntegration<TicketConnector>(
          ticketSource.integrationId,
          { ticketProjectKey: ticketSource.ticketProjectKey },
        )
        : mode.pluginManager.getConnectorForIntegration<TicketConnector>(ticketSource.integrationId);

    if (!connector) {
      throw new Error(
        `Ticket source integration ${ticketSource.integrationId} is not active (task ${task.taskId})`,
      );
    }
    return connector;
  }

  /** Resolve the review connector from review config or push targets. */
  async resolveReviewConnector(
    task: Pick<Task, "taskId" | "projectId" | "externalChangeId"> &
      Partial<Pick<Task, "taskType" | "ticketSourceLabel">>,
  ): Promise<ReviewConnector> {
    const mode = this.dependencies.getProjectMode();
    if (!task.projectId || !mode) {
      throw new Error(`Task ${task.taskId} is not project-bound; cannot resolve review connector`);
    }

    const sourceReviewIntegrationId = task.taskType === "code-review"
      ? parseIntegrationIdFromSourceLabel(task.ticketSourceLabel)
      : null;
    const assertReviewIntegrationCompatible = (integrationId: string): void => {
      if (sourceReviewIntegrationId && sourceReviewIntegrationId !== integrationId) {
        throw new ProjectReconfigurationIncompatibleError(
          `Review integration changed while task ${task.taskId} was active: it was created from ${sourceReviewIntegrationId}, but project ${task.projectId} now uses ${integrationId}. Manual retry is required.`,
        );
      }
    };

    const reviewConfig = await mode.projectStore.getProjectReviewConfig(task.projectId);
    if (reviewConfig) {
      assertReviewIntegrationCompatible(reviewConfig.integrationId);
      const selection = selectReviewRepository(task.externalChangeId, reviewConfig.repos);
      if (selection.hasQualifiedRepository && selection.repoKey === undefined) {
        const message =
          `Review change ${task.externalChangeId ?? ""} does not match a repository bound to project ${task.projectId}`;
        throw task.taskType === "code-review"
          ? new ProjectReconfigurationIncompatibleError(`${message}. Manual retry is required.`)
          : new Error(message);
      }
      const connector = await this.resolveReviewCapabilityConnector(
        reviewConfig.integrationId,
        selection.repoKey,
      );
      if (connector) return connector;
    }

    const pushTargets = await mode.projectStore.listProjectPushTargets(task.projectId);
    const selection = selectReviewRepository(task.externalChangeId, pushTargets.map((target) => target.repoKey));
    if (selection.hasQualifiedRepository && selection.repoKey === undefined) {
      const message =
        `Review change ${task.externalChangeId ?? ""} does not match a repository push target for project ${task.projectId}`;
      throw task.taskType === "code-review"
        ? new ProjectReconfigurationIncompatibleError(`${message}. Manual retry is required.`)
        : new Error(message);
    }

    if (selection.repoKey !== undefined) {
      const target = pushTargets.find((candidate) => candidate.repoKey === selection.repoKey);
      if (target) {
        assertReviewIntegrationCompatible(target.integrationId);
        const connector = await this.resolveReviewCapabilityConnector(target.integrationId, target.repoKey);
        if (connector) return connector;
      }
    } else if (pushTargets.length === 1) {
      const target = pushTargets[0];
      if (target) {
        assertReviewIntegrationCompatible(target.integrationId);
        const connector = await this.resolveReviewCapabilityConnector(target.integrationId, target.repoKey);
        if (connector) return connector;
      }
    } else {
      const integrationIds = [...new Set(pushTargets.map((target) => target.integrationId))];
      if (integrationIds.length === 1) {
        const integrationId = integrationIds[0];
        if (integrationId !== undefined) {
          assertReviewIntegrationCompatible(integrationId);
          const connector = await this.resolveReviewCapabilityConnector(integrationId);
          if (connector) return connector;
        }
      }
    }

    throw new Error(`No active review connector found for project ${task.projectId} (task ${task.taskId})`);
  }

  private async resolveReviewCapabilityConnector(
    integrationId: string,
    repoKey?: string,
  ): Promise<ReviewConnector | null> {
    const pluginManager = this.dependencies.getProjectMode()?.pluginManager;
    if (!pluginManager) return null;

    if (repoKey !== undefined && pluginManager.createConnectorForCapability) {
      const contextualized = await pluginManager.createConnectorForCapability<ReviewConnector>(
        integrationId,
        "code_review",
        { repoKey },
      );
      if (contextualized) return contextualized;
    }

    const integration = pluginManager.getActiveIntegrationById?.(integrationId);
    if (
      repoKey === undefined
      && (integration?.provider === "github" || integration?.provider === "gitlab")
    ) {
      return null;
    }

    if (pluginManager.getConnectorForCapability) {
      const byCapability = pluginManager.getConnectorForCapability<ReviewConnector>(integrationId, "code_review");
      if (byCapability) return byCapability;
    }
    return pluginManager.getConnectorForIntegration<ReviewConnector>(integrationId);
  }
}