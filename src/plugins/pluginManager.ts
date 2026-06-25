/**
 * Runtime plugin manager — loads enabled integrations, instantiates connectors,
 * and supports hot-reload without a process restart.
 */
import type {
  IntegrationBindingContext,
  IntegrationStore,
  Integration,
  ProviderId,
  DomainCapability,
  PluginInstance,
} from "../interfaces.js";
import { getProviderDescriptor, getProviderDomainCapabilities, getCapabilityIntake } from "./registry.js";
import type { ProviderDescriptor, IntakeMechanism } from "./registry.js";
import { getLogger } from "../logger.js";
import { decryptToken } from "../utils/encryption.js";

const log = getLogger("plugin-manager");

export type { PluginInstance };

export type PluginFactory = (config: unknown, integration: Integration) => PluginInstance;
export interface ConnectionTestModel {
  id: string;
  name: string;
}

export interface ConnectionTestResult {
  success: boolean;
  error: string | null;
  models?: ConnectionTestModel[] | undefined;
}

export type ConnectionTester = (config: unknown) => Promise<ConnectionTestResult>;

export type PluginChangeCallback = () => void;

/** Capabilities that produce a runtime `PluginInstance` (cached per integration). */
const INSTANCE_CAPABILITIES: readonly DomainCapability[] = ["issue_tracking", "code_review", "agent_execution"];

function instanceKey(integrationId: string, capability: DomainCapability): string {
  return `${integrationId}::${capability}`;
}

/**
 * Manages active plugin instances.
 * Multiple integrations of the same provider can be active simultaneously;
 * per-project routing uses `getConnectorForCapability(id, capability)`.
 */
export class PluginManager {
  /** All currently active integration metadata indexed by integration id. */
  private readonly activeIntegrationsById = new Map<string, Integration>();
  /** Runtime connector instances keyed by `${integrationId}::${capability}`. */
  private readonly instancesByCapability = new Map<string, PluginInstance>();
  /** Agent-execution factories registered in index.ts (need AppConfig values). */
  private readonly factories = new Map<ProviderId, PluginFactory>();
  private readonly testers = new Map<ProviderId, ConnectionTester>();
  private readonly changeCallbacks: PluginChangeCallback[] = [];

  constructor(
    private readonly integrationStore: IntegrationStore,
    private readonly options: { adminAuthSecret?: string | undefined } = {}
  ) {}

  /** Register a connector factory for a provider (used for agent_execution instantiation). */
  registerFactory(provider: ProviderId, factory: PluginFactory): void {
    this.factories.set(provider, factory);
  }

  /** Register a connection tester for a provider (used by the admin test-connection endpoint). */
  registerConnectionTester(provider: ProviderId, tester: ConnectionTester): void {
    this.testers.set(provider, tester);
  }

  /** Subscribe to plugin activation/deactivation events. */
  onPluginChange(callback: PluginChangeCallback): void {
    this.changeCallbacks.push(callback);
  }

  /**
   * Load all enabled integrations from the database and instantiate their connectors.
   */
  async loadFromDatabase(): Promise<void> {
    this.resetActiveState();
    const enabledIntegrations = (await this.integrationStore.getIntegrations())
      .filter((integration) => integration.enabled)
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());

    for (const integration of enabledIntegrations) {
      try {
        this.activateIntegration(integration);
        log.info({ provider: integration.provider, name: integration.name }, "plugin loaded from database");
      } catch (err) {
        log.error({ provider: integration.provider, name: integration.name, err }, "failed to load plugin from database");
      }
    }
  }

  /** Enable the integration with `id`, instantiate its connector, and persist the change. */
  async enablePlugin(id: string): Promise<void> {
    const integration = await this.integrationStore.getIntegration(id);
    if (!integration) throw new Error(`Integration not found: ${id}`);

    this.activateIntegration(integration);
    await this.integrationStore.setIntegrationEnabled(id, true);
    log.info({ provider: integration.provider, name: integration.name }, "plugin enabled");
  }

  /** Disable the integration with `id`, tear down its connector, and persist the change. */
  async disablePlugin(id: string): Promise<void> {
    const integration = await this.integrationStore.getIntegration(id);
    if (!integration) throw new Error(`Integration not found: ${id}`);

    this.deactivateIntegration(integration);
    await this.integrationStore.setIntegrationEnabled(id, false);
    log.info({ provider: integration.provider, name: integration.name }, "plugin disabled");
  }

  /** Re-instantiate the connector for an already-enabled integration (e.g. after config edits). */
  async reloadIntegration(id: string): Promise<void> {
    const integration = await this.integrationStore.getIntegration(id);
    if (!integration) {
      throw new Error(`Integration not found: ${id}`);
    }
    if (!integration.enabled) {
      return;
    }

    this.deactivateIntegration(integration);
    this.activateIntegration(integration);
    log.info({ provider: integration.provider, name: integration.name }, "plugin reloaded");
  }

  /** Test the stored config of the integration with `id`. */
  async testConnection(id: string): Promise<ConnectionTestResult> {
    const integration = await this.integrationStore.getIntegration(id);
    if (!integration) throw new Error(`Integration not found: ${id}`);

    return this.testConnectionConfig(integration.provider, JSON.parse(integration.configJson));
  }

  /** Validate and test an arbitrary config object without persisting it. */
  async testConnectionConfig(provider: ProviderId, config: unknown): Promise<ConnectionTestResult> {
    const descriptor = this.getDescriptor(provider);
    const parsed = descriptor.configSchema.safeParse(config);
    if (!parsed.success) {
      return {
        success: false,
        error: `Invalid config for ${provider}: ${parsed.error.message}`,
        models: [],
      };
    }

    // Explicit tester registered in index.ts takes precedence.
    const tester = this.testers.get(provider);
    if (tester) {
      return this.normalizeConnectionTestResult(await tester(parsed.data));
    }

    // Fall back to the descriptor's own test hook.
    if (descriptor.testConnection) {
      const strippedConfig = this.stripSchemaDefaults(parsed.data, config);
      return this.normalizeConnectionTestResult(await descriptor.testConnection(strippedConfig));
    }

    return { success: true, error: null, models: [] };
  }

  /** Return the connector for a specific integration + capability, cast to T, or null. */
  getConnectorForCapability<T>(integrationId: string, capability: DomainCapability): T | null {
    return (this.instancesByCapability.get(instanceKey(integrationId, capability)) as unknown as T) ?? null;
  }

  /**
   * Return the active connector for a specific integration id, picking the
   * first available instance-producing capability. Callers must narrow the
   * result; prefer `getConnectorForCapability` when the capability is known.
   */
  getConnectorForIntegration<T>(integrationId: string): T | null {
    for (const capability of INSTANCE_CAPABILITIES) {
      const instance = this.instancesByCapability.get(instanceKey(integrationId, capability));
      if (instance) {
        return instance as unknown as T;
      }
    }
    return null;
  }

  /**
   * Build a connector instance for a specific integration id + capability,
   * optionally specialized by VE project binding context.
   */
  async createConnectorForCapability<T>(
    integrationId: string,
    capability: DomainCapability,
    context?: IntegrationBindingContext
  ): Promise<T | null> {
    const activeIntegration = this.activeIntegrationsById.get(integrationId);
    if (!activeIntegration) {
      return null;
    }
    if (context === undefined) {
      return this.getConnectorForCapability<T>(integrationId, capability);
    }
    const instance = this.buildCapabilityInstance(activeIntegration, capability, context);
    return (instance as unknown as T) ?? null;
  }

  /** Return true if the given integration id currently has any active connector. */
  isIntegrationActive(integrationId: string): boolean {
    return this.activeIntegrationsById.has(integrationId);
  }

  /** Return all currently active integrations for the given provider. */
  getActiveIntegrationsByProvider(provider: ProviderId): Integration[] {
    const out: Integration[] = [];
    for (const integration of this.activeIntegrationsById.values()) {
      if (integration.provider === provider) {
        out.push(integration);
      }
    }
    return out;
  }

  /** Return all currently active integrations across all providers. */
  getActiveIntegrations(): Integration[] {
    return [...this.activeIntegrationsById.values()];
  }

  /** Returns the stored Integration record for an active integration id. */
  getActiveIntegrationById(integrationId: string): Integration | null {
    return this.activeIntegrationsById.get(integrationId) ?? null;
  }

  /**
   * Returns true when the integration's provider declares a `code_review`
   * `streamEvents` factory. Stream-backed integrations deliver review events
   * via a persistent connection and must not be polled for review discovery.
   */
  integrationHasStreamEvents(integrationId: string): boolean {
    const integration = this.activeIntegrationsById.get(integrationId);
    if (!integration) return false;
    return getProviderDescriptor(integration.provider)?.capabilities.code_review?.streamEvents != null;
  }

  /** Returns all currently active integrations that expose the given capability. */
  getActiveIntegrationsByCapability(capability: DomainCapability): Integration[] {
    const out: Integration[] = [];
    for (const integration of this.activeIntegrationsById.values()) {
      if (this.providerSupportsCapability(integration.provider, capability)) {
        out.push(integration);
      }
    }
    return out;
  }

  /** Returns true when the given provider's descriptor declares `capability`. */
  providerSupportsCapability(provider: ProviderId, capability: DomainCapability): boolean {
    const descriptor = getProviderDescriptor(provider);
    return descriptor !== undefined && descriptor.capabilities[capability] !== undefined;
  }

  /**
   * Returns true when a *specific active integration* can serve `capability`:
   * the integration is active and its provider's descriptor declares the
   * capability. Use this (rather than `providerSupportsCapability`) when gating
   * a binding or runtime path on a concrete integration id.
   */
  integrationSupportsCapability(integrationId: string, capability: DomainCapability): boolean {
    const integration = this.activeIntegrationsById.get(integrationId);
    if (!integration) return false;
    return this.providerSupportsCapability(integration.provider, capability);
  }

  /**
   * Returns the event-intake mechanisms (`polling` | `webhook` | `stream`) an
   * active integration uses for `capability`, as declared by its descriptor.
   * Returns an empty array when the integration is inactive or the capability
   * declares no intake metadata.
   */
  getIntegrationCapabilityIntake(integrationId: string, capability: DomainCapability): IntakeMechanism[] {
    const integration = this.activeIntegrationsById.get(integrationId);
    if (!integration) return [];
    const descriptor = getProviderDescriptor(integration.provider);
    if (!descriptor) return [];
    return getCapabilityIntake(descriptor, capability);
  }

  /** All currently active providers. */
  getActiveProviders(): ProviderId[] {
    const providers = new Set<ProviderId>();
    for (const integration of this.activeIntegrationsById.values()) {
      providers.add(integration.provider);
    }
    return [...providers];
  }

  /**
   * Parse and decrypt an integration's configJson, returning a plain-object
   * record with all password-typed fields decrypted.
   */
  public decryptIntegrationConfig(integration: Integration): Record<string, unknown> {
    const descriptor = this.getDescriptor(integration.provider);
    const rawConfig = JSON.parse(integration.configJson) as Record<string, unknown>;
    return this.decryptPasswordFields(rawConfig, descriptor);
  }

  /** Build and register all instance-producing capability connectors for an integration. */
  private activateIntegration(integration: Integration): void {
    const descriptor = this.getDescriptor(integration.provider);
    this.activeIntegrationsById.set(integration.id, integration);

    for (const capability of getProviderDomainCapabilities(descriptor)) {
      if (!INSTANCE_CAPABILITIES.includes(capability)) {
        continue;
      }
      try {
        const instance = this.buildCapabilityInstance(integration, capability);
        if (instance) {
          this.instancesByCapability.set(instanceKey(integration.id, capability), instance);
        }
      } catch (err) {
        log.error(
          { provider: integration.provider, capability, name: integration.name, err },
          "failed to instantiate capability connector"
        );
      }
    }

    this.notifyChange();
  }

  /** Remove an integration and all its capability connectors from the active registry. */
  private deactivateIntegration(integration: Integration): boolean {
    const hadIntegration = this.activeIntegrationsById.delete(integration.id);
    let removed = false;
    for (const capability of INSTANCE_CAPABILITIES) {
      if (this.instancesByCapability.delete(instanceKey(integration.id, capability))) {
        removed = true;
      }
    }
    if (!hadIntegration && !removed) {
      return false;
    }
    this.notifyChange();
    return true;
  }

  /**
   * Instantiate the connector for one capability of an integration using a
   * registered factory (agent_execution) or the descriptor capability hook.
   * Returns null when the capability declares no instance factory.
   */
  private buildCapabilityInstance(
    integration: Integration,
    capability: DomainCapability,
    context?: IntegrationBindingContext
  ): PluginInstance | null {
    const descriptor = this.getDescriptor(integration.provider);
    const rawConfig = JSON.parse(integration.configJson) as Record<string, unknown>;
    const config = this.decryptPasswordFields(rawConfig, descriptor);
    const parsed = descriptor.configSchema.safeParse(config);
    if (!parsed.success) {
      throw new Error(`Invalid config for ${integration.provider}: ${parsed.error.message}`);
    }
    const strippedConfig = this.stripSchemaDefaults(parsed.data, config);

    if (capability === "agent_execution") {
      // Explicit factory registered in index.ts takes precedence (needs AppConfig).
      const factory = this.factories.get(integration.provider);
      if (factory) {
        return factory(strippedConfig, integration);
      }
      const createAdapter = descriptor.capabilities.agent_execution?.createAdapter;
      return createAdapter ? createAdapter(strippedConfig, integration, context) : null;
    }

    if (capability === "issue_tracking") {
      const createConnector = descriptor.capabilities.issue_tracking?.createConnector;
      return createConnector ? createConnector(strippedConfig, integration, context) : null;
    }

    if (capability === "code_review") {
      const createConnector = descriptor.capabilities.code_review?.createConnector;
      return createConnector ? createConnector(strippedConfig, integration, context) : null;
    }

    return null;
  }

  /**
   * Decrypt password-typed fields in a raw integration config.
   */
  private decryptPasswordFields(
    config: Record<string, unknown>,
    descriptor: ProviderDescriptor
  ): Record<string, unknown> {
    const result: Record<string, unknown> = { ...config };
    for (const field of descriptor.requiredFields.filter((f) => f.type === "password")) {
      const raw = result[field.key];
      if (typeof raw === "string" && raw.length > 0) {
        try {
          result[field.key] = decryptToken(raw, this.options.adminAuthSecret);
        } catch {
          // Not a managed encrypted token (e.g. a raw PAT typed by the user) — leave as-is.
        }
      }
    }
    return result;
  }

  /**
   * Strip Zod-injected defaults before passing config to a factory or tester,
   * so optional keys absent in the raw DB row are not silently filled in.
   */
  private stripSchemaDefaults(parsed: unknown, raw: unknown): unknown {
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return parsed;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return parsed;
    }

    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value !== undefined && Object.prototype.hasOwnProperty.call(raw, key)) {
        normalized[key] = value;
      }
    }
    return normalized;
  }

  /** Normalize a raw connection-test result, ensuring error and models are never undefined. */
  private normalizeConnectionTestResult(result: ConnectionTestResult): ConnectionTestResult {
    return {
      success: result.success,
      error: result.error ?? null,
      models: result.models ?? [],
    };
  }

  /** Clear all active instance and integration maps. */
  private resetActiveState(): void {
    this.activeIntegrationsById.clear();
    this.instancesByCapability.clear();
  }

  /** Look up a registered provider descriptor, throwing if not found. */
  private getDescriptor(provider: ProviderId): ProviderDescriptor {
    const descriptor = getProviderDescriptor(provider);
    if (!descriptor) {
      throw new Error(`Unknown provider: ${provider}`);
    }
    return descriptor;
  }

  /** Invoke all registered plugin-change callbacks, swallowing errors. */
  private notifyChange(): void {
    for (const cb of this.changeCallbacks) {
      try {
        cb();
      } catch (err) {
        log.error({ err }, "plugin change callback error");
      }
    }
  }
}
