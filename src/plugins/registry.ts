/**
 * Static plugin descriptor registry.
 *
 * Descriptors define the metadata (fields, schema, category) for each
 * integration type. They are registered once at startup via
 * `registerBuiltinPlugins()` and queried by the admin UI and `PluginManager`.
 */
import { z } from "zod";
import type { DiscoveredResources, OAuthAppStore, Integration, IntegrationBindingContext, IntegrationType, PluginCategory, PluginInstance, ReviewChangeDetails, ReviewProvider, WorkspaceHandle, WorkspaceRunner } from "../interfaces.js";
import type { IntegrationEventStreamFactory } from "../connectors/integrationStreamEvents.js";
import type { VcsConnector } from "../vcs/vcsConnector.js";
import type { ProviderAuthHandler } from "../agents/providerAuthService.js";

// ─── Plugin descriptor types ──────────────────────────────────────────────

export const PLUGIN_CAPABILITIES = [
  "ticketing",
  "review",
  "agent",
  "oauth",
  "discovery",
  "stream-events",
  "vcs",
  "reviewer",
] as const;

export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

export type PluginVisibilityCondition =
  | { field: string; value: string; allOf?: undefined }
  | { allOf: Array<{ field: string; value: string }>; field?: undefined; value?: undefined };

/** Metadata for a single configuration field rendered in the admin UI form. */
export interface PluginField {
  key: string;
  label: string;
  type: "text" | "password" | "url" | "number" | "select";
  required: boolean;
  placeholder?: string;
  /**
   * When `true` this field is not rendered in the admin UI but is still used
   * by the server for secret masking / preservation logic.
   */
  hidden?: boolean | undefined;
  /** Options for `type: "select"` fields. */
  options?: Array<{ value: string; label: string }>;
  /**
   * When set, this field is only shown when the field named `field` has the
   * value `value`. Used for conditional visibility in the admin UI.
   * The controlling field must be a `select` type field in the same form.
   */
  dependsOn?: PluginVisibilityCondition;
  /**
   * When `true` this field is rendered inside a collapsed "Advanced settings"
   * section in the admin UI form rather than at the top level.
   */
  advanced?: boolean | undefined;
}

/** Result shape returned by `PluginDescriptor.testConnection`. */
export interface DescriptorConnectionTestResult {
  success: boolean;
  error: string | null;
  models?: Array<{ id: string; name: string }> | undefined;
}

export interface PluginDeviceOAuthConfig {
  mode: "device";
  tokenField: string;
  dependsOn?: PluginVisibilityCondition | undefined;
  providerName: string;
  heading: string;
  connectLabel: string;
  reconnectLabel: string;
  pendingLabel: string;
  startPath: string;
  completePath: string;
}

export interface PluginRedirectOAuthConfig {
  mode: "redirect";
  tokenField: string;
  dependsOn?: PluginVisibilityCondition | undefined;
  providerName: string;
  heading: string;
  connectLabel: string;
  reconnectLabel: string;
  pendingLabel: string;
  startPath: string;
  completePath: string;
}

export type PluginOAuthConfig = PluginDeviceOAuthConfig | PluginRedirectOAuthConfig;

export interface PluginOAuthConfigResolverContext {
  oAuthAppStore?: OAuthAppStore | undefined;
}

/** Static descriptor for one integration type registered with the plugin system. */
export interface PluginDescriptor {
  type: IntegrationType;
  name: string;
  category: PluginCategory;
  /**
   * Optional explicit capabilities. Keep `category` for legacy call sites,
   * but prefer this list when a descriptor must participate in multiple admin
   * sections (for example a future unified GitLab integration).
   */
  capabilities?: readonly PluginCapability[] | undefined;
  configSchema: z.ZodSchema;
  requiredFields: PluginField[];
  /**
   * Optional OAuth metadata used by the admin UI to render a provider-specific
   * auth flow without hardcoding provider types in the dashboard.
   */
  oauth?: PluginOAuthConfig | undefined;
  /**
   * Optional provider-auth handler used by the admin server's generic plugin
   * OAuth routes. Descriptors that expose `oauth` should provide the matching
   * runtime handler rather than relying on admin-side provider branching.
   */
  createOAuthHandler?: ((config?: Record<string, unknown>) => ProviderAuthHandler) | undefined;
  /**
   * Optional config-resolution hook used by the generic admin OAuth routes
   * before creating the runtime handler.
   */
  resolveOAuthConfig?: ((config: Record<string, unknown>, context: PluginOAuthConfigResolverContext) => Promise<Record<string, unknown>>) | undefined;
  /**
   * Optional resource-discovery hook. When defined, the admin
   * `POST /api/admin/integrations/:id/discover` endpoint will call it with the
   * integration's parsed config and persist the resulting snapshot on the
   * integration row. Connectors with nothing to discover simply omit it.
   */
  discoverResources?: (config: unknown) => Promise<DiscoveredResources>;
  /**
   * Optional live event-stream capability. When defined, the runtime creates a
   * provider-specific stream manager for active integrations of this type.
   */
  streamEvents?: IntegrationEventStreamFactory;
  /**
   * Optional connector factory. When defined, `PluginManager` uses this to
   * instantiate the runtime connector without requiring a `registerFactory`
   * call in `index.ts`. The config has Zod defaults stripped (same as the
   * `registerFactory` path) so values absent in the DB row are not silently
   * overwritten on re-save.
   *
   * `index.ts`-registered factories always take precedence (useful when
   * construction needs AppConfig values, e.g. `agentDockerNetwork`).
   */
  createInstance?: (config: unknown, integration: Integration, context?: IntegrationBindingContext) => PluginInstance;
  /**
   * Optional connection tester. When defined, `PluginManager.testConnectionConfig`
   * uses this instead of requiring a `registerConnectionTester` call in `index.ts`.
   *
   * `index.ts`-registered testers always take precedence.
   */
  testConnection?: (config: unknown) => Promise<DescriptorConnectionTestResult>;
  /**
   * Optional VCS push-target factory. When defined, `createVcsConnectorForIntegration`
   * in `vcsFactory.ts` uses this to build a `VcsConnector` without any type-specific
   * dispatch in that file.
   *
   * The config is fully parsed (Zod defaults applied) before being passed here.
   */
  createVcsConnector?: (config: Record<string, unknown>, integration: Integration, context?: IntegrationBindingContext) => VcsConnector;
  /**
   * ID of the system prompt used when running code-review sessions for this
   * integration (e.g. `"system_gerrit_review"`).
   */
  reviewSystemPromptId?: string | undefined;
  /**
   * ID of the user prompt (instructions) used when running code-review sessions
   * for this integration (e.g. `"user_gerrit_review"`).
   */
  reviewUserPromptId?: string | undefined;
  /**
   * Optional reviewer factory. When defined, the descriptor supports acting as
   * a code reviewer (VE reads diffs and posts comments). Returns the provider
   * and the workspace setup hooks as a single unit so one cannot exist without
   * the other.
   */
  createReviewer?: (
    config: Record<string, unknown>,
    integration: Integration,
    workspaceRunner: WorkspaceRunner
  ) => {
    provider: ReviewProvider;
    buildCloneTarget: (details: ReviewChangeDetails) => { cloneUrl: string; sshKeyPath: string | null; sshKnownHostsPath: string | null };
    applyPatchset?: (handle: WorkspaceHandle, details: ReviewChangeDetails) => Promise<void>;
    /** DB key for the system prompt passed to the review agent. */
    systemPromptId: string;
    /** DB key for the user instructions prompt injected into the review prompt. */
    userPromptId: string;
  };
  /**
   * Returns the integration-specific detail lines shown in the admin provider
   * summary panel. The caller appends category-level details (e.g. polling
   * interval for ticketing integrations) after this array.
   */
  getSummaryDetails(config: Record<string, unknown>): string[];
}

// ─── Registry ───────────────────────────────────────────────────────────────

const descriptors = new Map<IntegrationType, PluginDescriptor>();

/** Register a plugin descriptor. Called once per type at startup. */
export function registerPlugin(descriptor: PluginDescriptor): void {
  descriptors.set(descriptor.type, descriptor);
}

/** Look up a descriptor by integration type. Returns `undefined` if not registered. */
export function getPluginDescriptor(type: IntegrationType): PluginDescriptor | undefined {
  return descriptors.get(type);
}

/** All registered plugin descriptors as an array. */
export function getAllPluginDescriptors(): PluginDescriptor[] {
  return [...descriptors.values()];
}

/** Return the merged capability list for a descriptor. */
export function getPluginCapabilities(descriptor: PluginDescriptor): PluginCapability[] {
  const capabilities = new Set<PluginCapability>();

  for (const capability of descriptor.capabilities ?? []) {
    capabilities.add(capability);
  }

  capabilities.add(descriptor.category);
  if (descriptor.oauth) capabilities.add("oauth");
  if (descriptor.discoverResources) capabilities.add("discovery");
  if (descriptor.streamEvents) capabilities.add("stream-events");
  if (descriptor.createVcsConnector) capabilities.add("vcs");
  if (descriptor.createReviewer) capabilities.add("reviewer");

  return [...capabilities];
}
