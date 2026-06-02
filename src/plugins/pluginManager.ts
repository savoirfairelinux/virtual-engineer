/**
 * Runtime plugin manager — loads enabled integrations, instantiates connectors,
 * and supports hot-reload without a process restart.
 */
import type {
  IntegrationBindingContext,
  IntegrationStore,
  Integration,
  IntegrationType,
  PluginCategory,
  PluginInstance,
} from "../interfaces.js";
import { getPluginDescriptor } from "./registry.js";
import type { PluginDescriptor } from "./registry.js";
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

/**
 * Manages active plugin instances.
 * Multiple integrations of the same category can be active simultaneously;
 * per-project routing uses `getConnectorForIntegration(id)`.
 */
export class PluginManager {
  private readonly activeInstances = new Map<IntegrationType, PluginInstance>();
  private readonly activeIntegrations = new Map<IntegrationType, Integration>();
  private readonly activeIntegrationIds = new Map<IntegrationType, string>();
  private readonly activeCategories = new Map<PluginCategory, IntegrationType>();
  /** All currently active integrations indexed by integration id. */
  private readonly activeInstancesById = new Map<string, PluginInstance>();
  /** All currently active integration metadata indexed by integration id. */
  private readonly activeIntegrationsById = new Map<string, Integration>();
  private readonly factories = new Map<IntegrationType, PluginFactory>();
  private readonly testers = new Map<IntegrationType, ConnectionTester>();
  private readonly changeCallbacks: PluginChangeCallback[] = [];

  constructor(
    private readonly integrationStore: IntegrationStore,
    private readonly options: { adminAuthSecret?: string | undefined } = {}
  ) {}

  /** Register a connector factory for an integration type. */
  registerFactory(type: IntegrationType, factory: PluginFactory): void {
    this.factories.set(type, factory);
  }

  /** Register a connection tester for an integration type (used by the admin test-connection endpoint). */
  registerConnectionTester(type: IntegrationType, tester: ConnectionTester): void {
    this.testers.set(type, tester);
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

    // Multiple integrations of the same category can be active simultaneously.
    // The most-recently-updated integration wins for type-level lookups (sort above).
    const claimedTypes = new Set<IntegrationType>();
    for (const integration of enabledIntegrations) {
      const descriptor = this.getDescriptor(integration.type);
      try {
        this.activateIntegration(
          integration,
          descriptor.category,
          this.createPluginInstance(integration),
          { promoteTypeLeader: !claimedTypes.has(integration.type) }
        );
        claimedTypes.add(integration.type);
        log.info({ type: integration.type, name: integration.name }, "plugin loaded from database");
      } catch (err) {
        log.error({ type: integration.type, name: integration.name, err }, "failed to load plugin from database");
      }
    }
  }

  /** Enable the integration with `id`, instantiate its connector, and persist the change. */
  async enablePlugin(id: string): Promise<void> {
    const integration = await this.integrationStore.getIntegration(id);
    if (!integration) throw new Error(`Integration not found: ${id}`);

    const descriptor = this.getDescriptor(integration.type);
    const instance = this.createPluginInstance(integration);

    // Multiple integrations per category are allowed; within the same type the new instance replaces the previous.
    this.activateIntegration(integration, descriptor.category, instance);
    await this.integrationStore.setIntegrationEnabled(id, true);
    log.info({ type: integration.type, name: integration.name }, "plugin enabled");
  }

  /** Disable the integration with `id`, tear down its connector, and persist the change. */
  async disablePlugin(id: string): Promise<void> {
    const integration = await this.integrationStore.getIntegration(id);
    if (!integration) throw new Error(`Integration not found: ${id}`);

    this.deactivateIntegration(integration);
    await this.integrationStore.setIntegrationEnabled(id, false);
    log.info({ type: integration.type, name: integration.name }, "plugin disabled");
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

    const descriptor = this.getDescriptor(integration.type);
    const instance = this.createPluginInstance(integration);

    // Multiple integrations per category are allowed.
    this.activateIntegration(integration, descriptor.category, instance);
    log.info({ type: integration.type, name: integration.name }, "plugin reloaded");
  }

  /** Test the stored config of the integration with `id`. */
  async testConnection(id: string): Promise<ConnectionTestResult> {
    const integration = await this.integrationStore.getIntegration(id);
    if (!integration) throw new Error(`Integration not found: ${id}`);

    return this.testConnectionConfig(integration.type, JSON.parse(integration.configJson));
  }

  /** Validate and test an arbitrary config object without persisting it. */
  async testConnectionConfig(type: IntegrationType, config: unknown): Promise<ConnectionTestResult> {
    const descriptor = this.getDescriptor(type);
    const parsed = descriptor.configSchema.safeParse(config);
    if (!parsed.success) {
      return {
        success: false,
        error: `Invalid config for ${type}: ${parsed.error.message}`,
        models: [],
      };
    }

    // Explicit tester registered in index.ts takes precedence.
    const tester = this.testers.get(type);
    if (tester) {
      return this.normalizeConnectionTestResult(await tester(parsed.data));
    }

    // Fall back to the descriptor's own test hook.
    // Strip Zod-applied defaults so the tester sees the same config the connector
    // will receive at runtime (keys absent in the raw row are not filled in).
    // This prevents a successful test with a Zod-default path from masking a
    // missing required value that would fail at connector instantiation.
    if (descriptor.testConnection) {
      const strippedConfig = this.stripSchemaDefaults(parsed.data, config);
      return this.normalizeConnectionTestResult(await descriptor.testConnection(strippedConfig));
    }

    return { success: true, error: null, models: [] };
  }

  /** Return the active type-level connector instance cast to T, or null if not active. */
  getActiveConnector<T extends PluginInstance>(type: IntegrationType): T | null {
    return (this.activeInstances.get(type) as T) ?? null;
  }

  /** Returns the active connector for a specific integration id. Callers must narrow the result. */
  getConnectorForIntegration<T>(integrationId: string): T | null {
    return (this.activeInstancesById.get(integrationId) as unknown as T) ?? null;
  }

  /** Build a connector instance for a specific integration id, optionally specialized by VE project binding context. */
  async createConnectorForIntegration<T>(integrationId: string, context?: IntegrationBindingContext): Promise<T | null> {
    if (context === undefined) {
      return this.getConnectorForIntegration<T>(integrationId);
    }

    const activeIntegration = this.activeIntegrationsById.get(integrationId);
    if (!activeIntegration) {
      return null;
    }

    return this.createPluginInstance(activeIntegration, context) as unknown as T;
  }

  /** Return true if the given integration id currently has an active connector. */
  isIntegrationActive(integrationId: string): boolean {
    return this.activeIntegrationsById.has(integrationId);
  }

  /** Return all currently active integrations whose type matches the given type. */
  getActiveIntegrationsByType(type: IntegrationType): Integration[] {
    const out: Integration[] = [];
    for (const integration of this.activeIntegrationsById.values()) {
      if (integration.type === type) {
        out.push(integration);
      }
    }
    return out;
  }

  /** Return all currently active integrations across all types. */
  getActiveIntegrations(): Integration[] {
    return [...this.activeIntegrationsById.values()];
  }

  /** Returns the stored Integration record for an active integration id. */
  getActiveIntegrationById(integrationId: string): Integration | null {
    return this.activeIntegrationsById.get(integrationId) ?? null;
  }

  /**
   * Returns true when the integration's descriptor declares a `streamEvents`
   * factory.  Stream-backed integrations deliver review events via a persistent
   * connection and must not be polled for review assignment discovery.
   */
  integrationHasStreamEvents(integrationId: string): boolean {
    const integration = this.activeIntegrationsById.get(integrationId);
    if (!integration) return false;
    return getPluginDescriptor(integration.type)?.streamEvents != null;
  }

  /** Returns all currently active integrations of the given category. */
  getActiveIntegrationsByCategory(category: PluginCategory): Integration[] {
    const out: Integration[] = [];
    for (const integration of this.activeIntegrationsById.values()) {
      const descriptor = getPluginDescriptor(integration.type);
      if (descriptor && descriptor.category === category) out.push(integration);
    }
    return out;
  }

  /** All currently active integration types. */
  getActiveIntegrationTypes(): IntegrationType[] {
    const types = new Set<IntegrationType>();
    for (const integration of this.activeIntegrationsById.values()) {
      types.add(integration.type);
    }
    return [...types];
  }

  /** Returns the stored Integration record for the active instance of `type`, or null. */
  getActiveIntegration(type: IntegrationType): Integration | null {
    return this.activeIntegrations.get(type) ?? null;
  }

  /** Instantiate the connector for an integration using a registered factory or descriptor hook. */
  private createPluginInstance(integration: Integration, context?: IntegrationBindingContext): PluginInstance {
    const descriptor = this.getDescriptor(integration.type);

    const rawConfig = JSON.parse(integration.configJson) as Record<string, unknown>;
    // Decrypt password fields — OAuth tokens are stored via encryptToken (either
    // AES-256-GCM or a plain:-prefixed base64 when no ADMIN_AUTH_SECRET is set).
    const config = this.decryptPasswordFields(rawConfig, descriptor);
    const parsed = descriptor.configSchema.safeParse(config);
    if (!parsed.success) {
      throw new Error(`Invalid config for ${integration.type}: ${parsed.error.message}`);
    }

    const strippedConfig = this.stripSchemaDefaults(parsed.data, config);

    // Explicit factory registered in index.ts takes precedence (needed when
    // construction depends on AppConfig values, e.g. agentDockerNetwork).
    const factory = this.factories.get(integration.type);
    if (factory) {
      return factory(strippedConfig, integration);
    }

    // Fall back to the descriptor's own factory hook.
    if (descriptor.createInstance) {
      return descriptor.createInstance(strippedConfig, integration, context);
    }

    throw new Error(`No factory registered for type: ${integration.type}`);
  }

  /**
   * Parse and decrypt an integration's configJson, returning a plain-object
   * record with all password-typed fields decrypted.  Used by callers that
   * need the live config without going through `createInstance` (e.g. the
   * review-bundle builder in src/index.ts).
   */
  public decryptIntegrationConfig(integration: Integration): Record<string, unknown> {
    const descriptor = this.getDescriptor(integration.type);
    const rawConfig = JSON.parse(integration.configJson) as Record<string, unknown>;
    return this.decryptPasswordFields(rawConfig, descriptor);
  }

  /**
   * Decrypt password-typed fields in a raw integration config.
   * Tokens stored via encryptToken use a `plain:` prefix (no secret) or AES-256-GCM.
   * Fields that are raw PATs or unknown strings are left as-is when decryption fails.
   */
  private decryptPasswordFields(
    config: Record<string, unknown>,
    descriptor: PluginDescriptor
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

  /** Register an integration and its connector as active, optionally promoting it to type leader. */
  private activateIntegration(
    integration: Integration,
    category: PluginCategory,
    instance: PluginInstance,
    options?: { promoteTypeLeader?: boolean }
  ): void {
    this.activeInstancesById.set(integration.id, instance);
    this.activeIntegrationsById.set(integration.id, integration);

    if (options?.promoteTypeLeader ?? true) {
      this.setTypeLeader(integration, category, instance);
    }

    this.notifyChange(integration.type, this.activeInstances.get(integration.type) ?? null);
  }

  /** Remove an integration and its connector from the active registry; returns true if it was present. */
  private deactivateIntegration(integration: Integration): boolean {
    const descriptor = this.getDescriptor(integration.type);
    const hadInstance = this.activeInstancesById.delete(integration.id);
    const hadIntegration = this.activeIntegrationsById.delete(integration.id);
    if (!hadInstance && !hadIntegration) {
      return false;
    }

    if (this.activeIntegrationIds.get(integration.type) === integration.id) {
      const fallback = this.findMostRecentActiveIntegrationOfType(integration.type);
      if (fallback) {
        const fallbackInstance = this.activeInstancesById.get(fallback.id);
        if (fallbackInstance) {
          this.setTypeLeader(fallback, descriptor.category, fallbackInstance);
        }
      } else {
        this.activeInstances.delete(integration.type);
        this.activeIntegrations.delete(integration.type);
        this.activeIntegrationIds.delete(integration.type);
        if (this.activeCategories.get(descriptor.category) === integration.type) {
          this.activeCategories.delete(descriptor.category);
        }
      }
    }

    this.notifyChange(integration.type, this.activeInstances.get(integration.type) ?? null);
    return true;
  }

  /** Clear all active instance, integration, and category maps. */
  private resetActiveState(): void {
    this.activeInstances.clear();
    this.activeIntegrations.clear();
    this.activeIntegrationIds.clear();
    this.activeCategories.clear();
    this.activeInstancesById.clear();
    this.activeIntegrationsById.clear();
  }

  /** Promote an integration to the type-level leader in all active lookup maps. */
  private setTypeLeader(
    integration: Integration,
    category: PluginCategory,
    instance: PluginInstance
  ): void {
    this.activeInstances.set(integration.type, instance);
    this.activeIntegrations.set(integration.type, integration);
    this.activeIntegrationIds.set(integration.type, integration.id);
    this.activeCategories.set(category, integration.type);
  }

  /** Find and return the most-recently-updated active integration of the given type. */
  private findMostRecentActiveIntegrationOfType(type: IntegrationType): Integration | null {
    let candidate: Integration | null = null;
    for (const integration of this.activeIntegrationsById.values()) {
      if (integration.type !== type) {
        continue;
      }
      if (!candidate || integration.updatedAt.getTime() > candidate.updatedAt.getTime()) {
        candidate = integration;
      }
    }
    return candidate;
  }

  /** Look up a registered plugin descriptor by type, throwing if not found. */
  private getDescriptor(type: IntegrationType): PluginDescriptor {
    const descriptor = getPluginDescriptor(type);
    if (!descriptor) {
      throw new Error(`Unknown integration type: ${type}`);
    }
    return descriptor;
  }

  /** Invoke all registered plugin-change callbacks, swallowing errors to avoid disrupting callers. */
  private notifyChange(_type: IntegrationType, _instance: PluginInstance | null): void {
    for (const cb of this.changeCallbacks) {
      try {
        cb();
      } catch (err) {
        log.error({ err }, "plugin change callback error");
      }
    }
  }
}
