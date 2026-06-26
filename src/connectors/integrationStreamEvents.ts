import type { Integration, IntegrationType, ReviewComment } from "../interfaces.js";
import { getPluginDescriptor } from "../plugins/registry.js";

export interface IntegrationEventStreamStatus {
  integrationId: string;
  integrationName: string;
  integrationType: IntegrationType;
  state: "connecting" | "connected" | "reconnecting" | "error" | "stopped";
  reconnectCount: number;
  lastEventType: string | null;
  lastEventAt: string | null;
  lastError: string | null;
}

export interface IntegrationEventStreamOrchestrator {
  triggerFeedbackForChange(integrationId: string, changeId: string, streamComments?: ReviewComment[]): Promise<void>;
  markChangeMerged(integrationId: string, changeId: string): Promise<void>;
  markChangeAbandoned(integrationId: string, changeId: string): Promise<void>;
}

export interface IntegrationEventStreamReviewTrigger {
  triggerReviewForChange(integrationId: string, changeId: string, options?: { force?: boolean }): Promise<void>;
}

export interface IntegrationEventStreamDependencies {
  orchestrator: IntegrationEventStreamOrchestrator;
  getReviewTrigger: () => IntegrationEventStreamReviewTrigger | undefined;
}

export interface IntegrationEventStreamManager {
  reconcile(integrations: Integration[]): Promise<void>;
  getStatus(integrationId: string): IntegrationEventStreamStatus | null;
  listStatuses(): IntegrationEventStreamStatus[];
  stopAll(): Promise<void>;
}

export interface IntegrationEventStreamFactory {
  createManager(deps: IntegrationEventStreamDependencies): IntegrationEventStreamManager;
}

export class PluginIntegrationStreamEventsManager implements IntegrationEventStreamManager {
  private readonly managers = new Map<IntegrationType, IntegrationEventStreamManager>();

  constructor(private readonly deps: IntegrationEventStreamDependencies) {}

  /** Sync per-type sub-managers to match the provided integration list, starting or stopping as needed. */
  async reconcile(integrations: Integration[]): Promise<void> {
    const integrationsByType = new Map<IntegrationType, Integration[]>();

    for (const integration of integrations) {
      const descriptor = getPluginDescriptor(integration.type);
      if (!descriptor?.streamEvents) {
        continue;
      }

      const existing = integrationsByType.get(integration.type);
      if (existing) {
        existing.push(integration);
      } else {
        integrationsByType.set(integration.type, [integration]);
      }
    }

    for (const [type, manager] of [...this.managers.entries()]) {
      if (integrationsByType.has(type)) {
        continue;
      }
      await manager.stopAll();
      this.managers.delete(type);
    }

    for (const [type, streamIntegrations] of integrationsByType.entries()) {
      let manager = this.managers.get(type);
      if (!manager) {
        const descriptor = getPluginDescriptor(type);
        if (!descriptor?.streamEvents) {
          continue;
        }
        manager = descriptor.streamEvents.createManager(this.deps);
        this.managers.set(type, manager);
      }
      await manager.reconcile(streamIntegrations);
    }
  }

  /** Return the stream status for a given integration, delegating across all type managers. */
  getStatus(integrationId: string): IntegrationEventStreamStatus | null {
    for (const manager of this.managers.values()) {
      const status = manager.getStatus(integrationId);
      if (status) {
        return status;
      }
    }
    return null;
  }

  /** Return a sorted list of all stream statuses across all type managers. */
  listStatuses(): IntegrationEventStreamStatus[] {
    return [...this.managers.values()]
      .flatMap((manager) => manager.listStatuses())
      .sort((left, right) => left.integrationName.localeCompare(right.integrationName));
  }

  /** Stop all sub-managers and remove their entries from the manager map. */
  async stopAll(): Promise<void> {
    for (const [type, manager] of [...this.managers.entries()]) {
      await manager.stopAll();
      this.managers.delete(type);
    }
  }
}