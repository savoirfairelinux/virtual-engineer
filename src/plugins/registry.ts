/**
 * Static plugin descriptor registry.
 *
 * Descriptors define the metadata (fields, schema, capabilities) for each
 * provider. They are registered once at startup via
 * `registerBuiltinPlugins()` and queried by the admin UI and `PluginManager`.
 */
import { z } from "zod";
import type { DiscoveredResources, OAuthAppStore, Integration, IntegrationBindingContext, ProviderId, DomainCapability, PluginInstance, ReviewChangeDetails, ReviewProvider, WorkspaceHandle, WorkspaceRunner } from "../interfaces.js";
import { DOMAIN_CAPABILITIES } from "../interfaces.js";
import type { IntegrationEventStreamFactory } from "../connectors/integrationStreamEvents.js";
import type { VcsConnector } from "../vcs/vcsConnector.js";
import type { ProviderAuthHandler } from "../agents/providerAuthService.js";

// ─── Plugin descriptor types ──────────────────────────────────────────────

/**
 * Technical (non-domain) capabilities derived from descriptor hooks. These are
 * surfaced to the admin UI alongside the domain capabilities.
 */
export const TECHNICAL_CAPABILITIES = [
  "oauth",
  "discovery",
  "stream-events",
  "reviewer",
] as const;

export type TechnicalCapability = (typeof TECHNICAL_CAPABILITIES)[number];

/** Combined capability label as shown in the admin UI. */
export type PluginCapability = DomainCapability | TechnicalCapability;

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

/** Reviewer factory result: the provider plus its workspace setup hooks. */
export interface ReviewerBundle {
  provider: ReviewProvider;
  buildCloneTarget: (details: ReviewChangeDetails) => { cloneUrl: string; sshKeyPath: string | null; sshKnownHostsPath: string | null };
  applyPatchset?: (handle: WorkspaceHandle, details: ReviewChangeDetails) => Promise<void>;
  /** DB key for the system prompt passed to the review agent. */
  systemPromptId: string;
  /** DB key for the user instructions prompt injected into the review prompt. */
  userPromptId: string;
}

/**
 * Event-intake mechanism a capability uses to learn about new work.
 *
 * - `polling`  — the polling loop periodically queries the provider API.
 * - `webhook`  — the provider POSTs events to the VE webhook server.
 * - `stream`   — VE holds a long-lived stream (e.g. Gerrit `ssh stream-events`).
 */
export type IntakeMechanism = "polling" | "webhook" | "stream";

/** `issue_tracking` capability: poll and update work items. */
export interface IssueTrackingCapability {
  /** Factory for the runtime ticket connector (a `TicketConnector`). */
  createConnector: (config: unknown, integration: Integration, context?: IntegrationBindingContext) => PluginInstance;
  /** How new work items reach VE for this provider. */
  intake?: IntakeMechanism[] | undefined;
}

/** `code_review` capability: read diffs, post review comments, watch changes. */
export interface CodeReviewCapability {
  /** Factory for the runtime review connector (a `ReviewConnector`). */
  createConnector?: ((config: unknown, integration: Integration, context?: IntegrationBindingContext) => PluginInstance) | undefined;
  /** Optional live event-stream factory (e.g. Gerrit `stream-events`). */
  streamEvents?: IntegrationEventStreamFactory | undefined;
  /** ID of the system prompt used when running code-review sessions. */
  systemPromptId?: string | undefined;
  /** ID of the user prompt (instructions) used when running code-review sessions. */
  userPromptId?: string | undefined;
  /** Optional reviewer factory (VE reads diffs and posts comments). */
  createReviewer?: ((config: Record<string, unknown>, integration: Integration, workspaceRunner: WorkspaceRunner) => ReviewerBundle) | undefined;
  /** How review events reach VE for this provider. */
  intake?: IntakeMechanism[] | undefined;
}

/** `source_control` capability: clone, commit, and push to a repository. */
export interface SourceControlCapability {
  createVcsConnector: (config: Record<string, unknown>, integration: Integration, context?: IntegrationBindingContext) => VcsConnector;
}

/** `agent_execution` capability: run a coding agent inside a workspace. */
export interface AgentExecutionCapability {
  /**
   * Factory for the runtime agent adapter. Optional because some agents (e.g.
   * Copilot) are registered via `PluginManager.registerFactory` in `index.ts`
   * when construction needs `AppConfig` values.
   */
  createAdapter?: ((config: unknown, integration: Integration, context?: IntegrationBindingContext) => PluginInstance) | undefined;
}

/** The domain capabilities a provider exposes. */
export interface ProviderCapabilities {
  issue_tracking?: IssueTrackingCapability | undefined;
  code_review?: CodeReviewCapability | undefined;
  source_control?: SourceControlCapability | undefined;
  agent_execution?: AgentExecutionCapability | undefined;
}

/** Static descriptor for one provider registered with the plugin system. */
export interface ProviderDescriptor {
  provider: ProviderId;
  name: string;
  /**
   * Optional brand icon metadata used by the admin UI to render the provider
   * logo. `slug` is the simpleicons.org slug and `hex` is the brand hex colour
   * without the leading `#`. The UI renders it via
   * `https://cdn.simpleicons.org/{slug}/{hex}`. Omit for providers without a
   * brand logo (the UI falls back to a monogram).
   */
  icon?: { slug: string; hex: string } | undefined;
  /** The domain capabilities this provider can fulfil. */
  capabilities: ProviderCapabilities;
  configSchema: z.ZodSchema;
  requiredFields: PluginField[];
  /**
   * When `true`, the admin `POST /api/admin/integrations` route validates the
   * config against the full (non-partial) schema on create instead of the
   * default partial validation. Used by providers (e.g. Copilot) whose config
   * must be complete before the integration is usable.
   */
  validateFullConfigOnCreate?: boolean | undefined;
  /**
   * Optional OAuth metadata used by the admin UI to render a provider-specific
   * auth flow without hardcoding provider types in the dashboard.
   */
  oauth?: PluginOAuthConfig | undefined;
  /**
   * Optional provider-auth handler used by the admin server's generic plugin
   * OAuth routes.
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
   * integration's parsed config and persist the resulting snapshot.
   */
  discoverResources?: (config: unknown) => Promise<DiscoveredResources>;
  /**
   * Optional connection tester used by `PluginManager.testConnectionConfig`.
   * `index.ts`-registered testers always take precedence.
   */
  testConnection?: (config: unknown) => Promise<DescriptorConnectionTestResult>;
  /**
   * Optional model-discovery hook. When defined, the admin
   * `POST /api/admin/integrations/:id/discover` endpoint delegates to it
   * (instead of the generic resource-discovery path) to fetch the available
   * agent models for the integration's parsed config.
   */
  discoverModels?: (config: unknown) => Promise<Array<{ id: string; name: string }>>;
  /**
   * Optional read-time config normalisation hook. When defined, the admin
   * routes call it with the masked config before returning it to the browser,
   * letting providers inject defaults or strip transport-only fields without
   * the route hardcoding provider checks.
   */
  normalizeConfigForRead?: (maskedConfig: Record<string, unknown>) => Record<string, unknown>;
  /**
   * Returns the provider-specific detail lines shown in the admin provider
   * summary panel.
   */
  getSummaryDetails(config: Record<string, unknown>): string[];
}

// ─── Registry ───────────────────────────────────────────────────────────────

/**
 * Error thrown by a descriptor's `discoverModels` hook when the integration is
 * not configured for model discovery (e.g. missing token). The admin route maps
 * this to HTTP 400; any other error maps to HTTP 502.
 */
export class ModelDiscoveryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelDiscoveryConfigError";
  }
}

const descriptors = new Map<ProviderId, ProviderDescriptor>();

/** Register a provider descriptor. Called once per provider at startup. */
export function registerPlugin(descriptor: ProviderDescriptor): void {
  descriptors.set(descriptor.provider, descriptor);
}

/** Look up a descriptor by provider id. Returns `undefined` if not registered. */
export function getProviderDescriptor(provider: ProviderId): ProviderDescriptor | undefined {
  return descriptors.get(provider);
}

/** All registered provider descriptors as an array. */
export function getAllProviderDescriptors(): ProviderDescriptor[] {
  return [...descriptors.values()];
}

/** Return the domain capabilities a descriptor declares. */
export function getProviderDomainCapabilities(descriptor: ProviderDescriptor): DomainCapability[] {
  return DOMAIN_CAPABILITIES.filter((capability) => descriptor.capabilities[capability] !== undefined);
}

/**
 * Return the event-intake mechanisms a descriptor declares for a domain
 * capability. Only `issue_tracking` and `code_review` carry intake metadata;
 * other capabilities (or undeclared intake) yield an empty array.
 */
export function getCapabilityIntake(
  descriptor: ProviderDescriptor,
  capability: DomainCapability
): IntakeMechanism[] {
  if (capability === "issue_tracking") {
    return [...(descriptor.capabilities.issue_tracking?.intake ?? [])];
  }
  if (capability === "code_review") {
    return [...(descriptor.capabilities.code_review?.intake ?? [])];
  }
  return [];
}

/** Return the technical (non-domain) capabilities derived from descriptor hooks. */
export function getProviderTechnicalCapabilities(descriptor: ProviderDescriptor): TechnicalCapability[] {
  const technical: TechnicalCapability[] = [];
  if (descriptor.oauth) technical.push("oauth");
  if (descriptor.discoverResources) technical.push("discovery");
  if (descriptor.capabilities.code_review?.streamEvents) technical.push("stream-events");
  if (descriptor.capabilities.code_review?.createReviewer) technical.push("reviewer");
  return technical;
}

/** Return the combined capability list (domain + technical) for a descriptor. */
export function getPluginCapabilities(descriptor: ProviderDescriptor): PluginCapability[] {
  return [
    ...getProviderDomainCapabilities(descriptor),
    ...getProviderTechnicalCapabilities(descriptor),
  ];
}
