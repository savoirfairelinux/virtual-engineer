import type { IntegrationBindingContext } from "../interfaces.js";
import type { VcsConnector } from "../vcs/vcsConnector.js";
import type { ConcurrencyTracker } from "./concurrencyTracker.js";

/**
 * Project-mode dependencies. When provided, the orchestrator resolves
 * agent + VCS connectors via project relations rather than env-var fallback.
 */
export interface ProjectModeDeps {
  projectStore: {
    getProjectById(id: import("../interfaces.js").ProjectId): Promise<import("../interfaces.js").ProjectRecord | null>;
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
   * must acquire a slot before running and release it on terminal states.
   */
  concurrencyTracker?: ConcurrencyTracker;
}