/**
 * Review system bootstrap and trigger logic.
 *
 * Handles review-bundle construction (review provider resolution, orchestrator
 * wiring) and building the review trigger used by stream-events and webhooks.
 */
import { getConfig } from "../config.js";
import { getLogger } from "../logger.js";
import { decryptManagedCredential, StoredCredentialDecryptionError } from "../utils/encryption.js";
import { assertPromptRole } from "../utils/promptRole.js";
import {
  resolveProviderOptions,
} from "../agents/providerOptions.js";
import { resolveReviewStrategy } from "../agents/reviewStrategy.js";
import { PluginManager } from "../plugins/pluginManager.js";
import { ReviewOrchestrator } from "./reviewOrchestrator.js";
import type { WorkspaceRunner } from "../interfaces.js";
import type { ConcurrencyTracker } from "../orchestrator/concurrencyTracker.js";
import type { TaskLifecycleCoordinator } from "../orchestrator/taskLifecycleCoordinator.js";
import { getProviderDescriptor } from "../plugins/registry.js";
import { buildTicketSourceLabel, parseIntegrationIdFromSourceLabel } from "../utils/ticketSourceLabel.js";
import { makeExternalChangeId } from "../interfaces.js";
import { resolveAgentConfig } from "../state/stateStore.js";
import { asOptionalString } from "../bootstrap/runtimeBuilder.js";
import type {
  AgentAdapter,
  Integration,
  ProviderId,
  ProjectRecord,
  ReviewStrategy,
  Task,
  StateStore,
  PromptStore,
} from "../interfaces.js";

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** Build the `<provider>:<id>` source label persisted on tasks and review bundles. */
function buildIntegrationSourceLabel(integration: Integration): string {
  return buildTicketSourceLabel(integration.provider, integration.id);
}

/** Parse the integration ID out of a `<provider>:<integrationId>` source label string. */
function getIntegrationIdFromSourceLabel(sourceLabel: string | null | undefined): string | null {
  return parseIntegrationIdFromSourceLabel(sourceLabel);
}

// ─── Review integration resolution ───────────────────────────────────────────

/**
 * Resolve an active review integration that has a `createReviewer`
 * descriptor hook.  When `target` is a `Task`, the integration referenced by
 * `ticketSourceLabel` is tried first; when it is a plain string it is treated
 * as an explicit integration id.  Falls back to the most-recently-updated
 * active review-category integration that supports the factory.
 */
export function resolveReviewIntegration(
  pluginManager: PluginManager,
  target?: string | Task
): Integration | null {
  const explicitIntegrationId = typeof target === "string"
    ? target
    : getIntegrationIdFromSourceLabel(target?.ticketSourceLabel);
  const candidates: Integration[] = [];

  if (explicitIntegrationId) {
    const explicitIntegration = pluginManager.getActiveIntegrationById(explicitIntegrationId);
    if (explicitIntegration && getProviderDescriptor(explicitIntegration.provider)?.capabilities.code_review?.createReviewer) {
      candidates.push(explicitIntegration);
    }
  }

  for (const integration of pluginManager.getActiveIntegrationsByCapability("code_review")) {
    if (!candidates.some((c) => c.id === integration.id)) {
      if (getProviderDescriptor(integration.provider)?.capabilities.code_review?.createReviewer) {
        candidates.push(integration);
      }
    }
  }

  return candidates[0] ?? null;
}

// ─── Agent token extraction ───────────────────────────────────────────────────

function getProviderCompatibleAgentToken(
  provider: ProviderId,
  sessionToken: string | null,
  apiKey: string | undefined
): string | null {
  if (provider === "claude") {
    const claudeSession = sessionToken?.trim();
    if (claudeSession?.startsWith("sk-ant-oat")) return claudeSession;
    const claudeApiKey = apiKey?.trim();
    return claudeApiKey?.startsWith("sk-ant-api") ? claudeApiKey : null;
  }
  if (provider === "copilot") {
    const copilotToken = sessionToken?.trim();
    if (copilotToken && !copilotToken.startsWith("sk-ant-")) return copilotToken;
    // `apiKey` carries a GitHub PAT when no OAuth session token is present
    // (same convention as the coding path — resolveAgentConfig stores the PAT
    // in the `apiKey` field, not in `sessionToken`/`encryptedSessionToken`).
    const copilotApiKey = apiKey?.trim();
    return copilotApiKey && !copilotApiKey.startsWith("sk-ant-") ? copilotApiKey : null;
  }
  if (provider === "codex") {
    // Codex API keys are OpenAI keys (`sk-…`, never `sk-ant-…`); a subscription
    // access token is any other opaque string.
    const codexSession = sessionToken?.trim();
    if (codexSession && !codexSession.startsWith("sk-")) return codexSession;
    const codexApiKey = apiKey?.trim();
    return codexApiKey?.startsWith("sk-") ? codexApiKey : null;
  }
  return null;
}

function getDecryptedPasswordField(
  pluginManager: PluginManager,
  integration: Integration,
  field: "token" | "apiKey" | "aiderApiKey" | "openCodeApiKey"
): string | null {
  return asOptionalString(pluginManager.decryptIntegrationConfig(integration)[field]) ?? null;
}

function decryptManagedSessionToken(
  rawConfig: Record<string, unknown>,
  field: "sessionToken" | "accessToken" = "sessionToken"
): string | null {
  const encrypted = asOptionalString(rawConfig[field]);
  if (!encrypted) return null;
  return decryptManagedCredential(encrypted, getConfig().adminAuthSecret, field);
}

/** Extract the agent token selected by provider + auth mode. */
function getAgentTokenFromIntegration(
  pluginManager: PluginManager,
  agentIntegration: Integration,
  bundleLog?: ReturnType<typeof getLogger>
): string | null {
  let rawConfig: Record<string, unknown>;
  try {
    rawConfig = JSON.parse(agentIntegration.configJson) as Record<string, unknown>;
  } catch (err) {
    bundleLog?.warn(
      { err, integrationId: agentIntegration.id, provider: agentIntegration.provider },
      "getAgentTokenFromIntegration: invalid integration config"
    );
    return null;
  }

  if (agentIntegration.provider === "copilot") {
    const authMode = asOptionalString(rawConfig["authMode"])
      ?? (asOptionalString(rawConfig["token"]) ? "pat" : "oauth");
    if (authMode === "pat") {
      return getDecryptedPasswordField(pluginManager, agentIntegration, "token");
    }
    return decryptManagedSessionToken(rawConfig);
  }

  if (agentIntegration.provider === "claude") {
    const authMode = asOptionalString(rawConfig["authMode"])
      ?? (asOptionalString(rawConfig["apiKey"]) ? "api_key" : "subscription");
    if (authMode === "api_key") {
      return getDecryptedPasswordField(pluginManager, agentIntegration, "apiKey");
    }
    return decryptManagedSessionToken(rawConfig);
  }

  if (agentIntegration.provider === "aider") {
    const aiderApiKey = getDecryptedPasswordField(pluginManager, agentIntegration, "aiderApiKey");
    if (aiderApiKey) return aiderApiKey;
    if (asOptionalString(rawConfig["aiderBackend"]) === "ollama") return "ollama-keyless";
    return null;
  }

  if (agentIntegration.provider === "opencode") {
    const openCodeApiKey = getDecryptedPasswordField(pluginManager, agentIntegration, "openCodeApiKey");
    if (openCodeApiKey) return openCodeApiKey;
    const provider = asOptionalString(rawConfig["openCodeProvider"]);
    if (provider === "ollama" || provider === "bedrock") return "opencode-keyless";
    return null;
  }

  if (agentIntegration.provider === "codex") {
    const authMode = asOptionalString(rawConfig["authMode"])
      ?? (asOptionalString(rawConfig["apiKey"]) ? "api_key" : "subscription");
    if (authMode === "api_key") {
      return getDecryptedPasswordField(pluginManager, agentIntegration, "apiKey");
    }
    // Codex stores its subscription credential under `accessToken`, not `sessionToken`.
    return decryptManagedSessionToken(rawConfig, "accessToken");
  }

  if (agentIntegration.provider === "gemini") {
    // Both auth modes (api_key, vertex_ai) authenticate with the same `apiKey`
    // field; review always treats it as a Gemini Developer API key (Vertex
    // AI-mode review is not yet supported).
    return getDecryptedPasswordField(pluginManager, agentIntegration, "apiKey");
  }

  if (agentIntegration.provider === "cursor") {
    // Cursor authenticates with a single plaintext apiKey — no auth mode.
    return getDecryptedPasswordField(pluginManager, agentIntegration, "apiKey");
  }

  return null;
}

/**
 * Extract the agent token from the provided agent-execution integration.
 * Provider-agnostic: works for Copilot (OAuth `sessionToken` or PAT `token`)
 * and Claude (OAuth `sessionToken` or `apiKey`).
 * Returns null when the integration is null or has no valid token.
 */
export function getAgentTokenForReview(
  pluginManager: PluginManager,
  agentIntegration: Integration | null,
  bundleLog?: ReturnType<typeof getLogger>
): string | null {
  if (!agentIntegration) return null;
  return getAgentTokenFromIntegration(pluginManager, agentIntegration, bundleLog);
}

// ─── Per-project agent resolution ────────────────────────────────────────────

function parseConfigRecord(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  const parsed: unknown = JSON.parse(json);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Agent configuration must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function resolveReviewProjectConfig(
  agent: import("../interfaces.js").AgentRecord,
  project: ProjectRecord,
): { project: ProjectRecord; reviewStrategy: ReviewStrategy } {
  const agentConfig = parseConfigRecord(agent.modelConfigJson);
  const reviewStrategy = resolveReviewStrategy(agentConfig);
  if (reviewStrategy === "ve_direct") return { project, reviewStrategy };

  const override = parseConfigRecord(project.agentOverrideJson);
  const providerOptions = {
    ...resolveProviderOptions(agentConfig),
    ...resolveProviderOptions(override),
  };
  delete providerOptions["reviewStrategy"];
  delete providerOptions["reasoningEffort"];
  delete override["model"];
  delete override["systemPromptId"];
  delete override["reviewStrategy"];
  delete override["reasoningEffort"];
  override["providerOptions"] = providerOptions;

  return {
    project: { ...project, agentOverrideJson: JSON.stringify(override) },
    reviewStrategy,
  };
}

/**
 * Resolve the adapter/model/token bound to a specific VE project, for use by
 * `ReviewOrchestrator.runReview()`. Returns `null` when the project has no
 * bound agent, or when a token cannot be resolved for that agent — in either
 * case `runReview()` throws and the task transitions to `REVIEW_FAILED`,
 * rather than pairing the project's model with an unrelated integration's
 * token (which caused unexpected model-selection failures).
 */
async function resolveReviewAgentForProject(
  pluginManager: PluginManager,
  store: StateStore & PromptStore,
  project: ProjectRecord,
  bundleLog: ReturnType<typeof getLogger>,
): Promise<{
  adapter: AgentAdapter;
  reviewStrategy: ReviewStrategy;
  model: string | undefined;
  token: string;
  systemPrompt: string;
  instructionsPrompt: string;
  providerOptions?: Record<string, unknown> | undefined;
  aiderBackend?: string | undefined;
  aiderApiBase?: string | undefined;
  openCodeProvider?: string | undefined;
  openCodeApiBase?: string | undefined;
} | null> {
  if (!project.agentId) return null;

  try {
    const agents = await store.listAgents({ type: "review", enabled: true });
    const agent = agents.find((candidate) => candidate.id === project.agentId);
    // agent is undefined when the project's agentId doesn't match any enabled
    // review agent (not found, disabled, or wrong type — all filtered out above).
    if (!agent?.integrationId) {
      return null;
    }

    const agentIntegration = pluginManager.getActiveIntegrationById(agent.integrationId);
    const adapter = pluginManager.getConnectorForIntegration<AgentAdapter>(agent.integrationId);
    if (!agentIntegration || !adapter) {
      bundleLog.warn(
        { projectId: project.id, agentId: agent.id, integrationId: agent.integrationId },
        "resolveReviewAgentForProject: project agent integration is not active"
      );
      return null;
    }

    const strategyConfig = resolveReviewProjectConfig(agent, project);
    const resolved = resolveAgentConfig(agent, strategyConfig.project);
    const providerOptions = resolveProviderOptions(resolved.extra);
    delete providerOptions["reviewStrategy"];
    if (strategyConfig.reviewStrategy === "copilot_native") {
      delete providerOptions["reasoningEffort"];
    }
    const resolvedModel = strategyConfig.reviewStrategy === "copilot_native"
      ? undefined
      : resolved.model?.trim() || undefined;
    const systemPromptId = strategyConfig.reviewStrategy === "copilot_native"
      ? agent.systemPromptId
      : resolved.systemPromptId;
    const [resolvedSystemPrompt, resolvedInstructionsPrompt] = await Promise.all([
      systemPromptId ? store.getPrompt(systemPromptId) : Promise.resolve(null),
      resolved.instructionsPromptId ? store.getPrompt(resolved.instructionsPromptId) : Promise.resolve(null),
    ]);
    if (!resolvedSystemPrompt) {
      throw new Error(`System prompt '${systemPromptId}' not found`);
    }
    if (!resolvedInstructionsPrompt) {
      throw new Error(`Instructions prompt '${resolved.instructionsPromptId}' not found`);
    }
    assertPromptRole(resolvedSystemPrompt, "system");
    assertPromptRole(resolvedInstructionsPrompt, "instructions");

    // Agent-local credentials are accepted only when they match the active
    // provider. This avoids carrying a stale Claude secret into Copilot (or
    // vice versa) after an agent is rebound to another integration.
    let localSessionToken: string | null = null;
    if (resolved.encryptedSessionToken) {
      try {
        localSessionToken = decryptManagedCredential(
          resolved.encryptedSessionToken,
          getConfig().adminAuthSecret,
          "sessionToken",
        );
      } catch (err) {
        bundleLog.warn(
          { err, projectId: project.id, agentId: agent.id, integrationId: agent.integrationId },
          "resolveReviewAgentForProject: failed to decrypt the project agent token"
        );
        throw err;
      }
    }
    const token = getProviderCompatibleAgentToken(
      agentIntegration.provider,
      localSessionToken,
      resolved.apiKey
    ) ?? getAgentTokenForReview(pluginManager, agentIntegration, bundleLog);

    // No usable token for this exact agent means the task cannot run.
    if (!token) return null;

    // For Aider integrations, extract the backend selector and API base URL.
    let aiderBackend: string | undefined;
    let aiderApiBase: string | undefined;
    if (agentIntegration.provider === "aider") {
      try {
        const aiderCfg = pluginManager.decryptIntegrationConfig(agentIntegration);
        aiderBackend = asOptionalString(aiderCfg["aiderBackend"]);
        aiderApiBase = asOptionalString(aiderCfg["aiderApiBase"]);
      } catch {
        // non-fatal — adapter falls back to defaults
      }
    }

    // For OpenCode integrations, extract the provider selector and API base URL.
    let openCodeProvider: string | undefined;
    let openCodeApiBase: string | undefined;
    if (agentIntegration.provider === "opencode") {
      try {
        const openCodeCfg = pluginManager.decryptIntegrationConfig(agentIntegration);
        openCodeProvider = asOptionalString(openCodeCfg["openCodeProvider"]);
        openCodeApiBase = asOptionalString(openCodeCfg["openCodeApiBase"]);
      } catch {
        // non-fatal — adapter falls back to defaults
      }
    }

    return {
      adapter,
      reviewStrategy: strategyConfig.reviewStrategy,
      model: resolvedModel,
      token,
      systemPrompt: resolvedSystemPrompt.content,
      instructionsPrompt: resolvedInstructionsPrompt.content,
      ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
      ...(aiderBackend !== undefined ? { aiderBackend } : {}),
      ...(aiderApiBase !== undefined ? { aiderApiBase } : {}),
      ...(openCodeProvider !== undefined ? { openCodeProvider } : {}),
      ...(openCodeApiBase !== undefined ? { openCodeApiBase } : {}),
    };
  } catch (err) {
    bundleLog.warn({ err, projectId: project.id }, "resolveReviewAgentForProject: failed to resolve project agent");
    if (err instanceof StoredCredentialDecryptionError) throw err;
    return null;
  }
}

// ─── Review bundle ───────────────────────────────────────────────────────────

export interface ReviewBundle {
  integration: Integration | null;
  provider: import("../interfaces.js").ReviewProvider | null;
  orchestrator: ReviewOrchestrator | null;
}

/**
 * Resolve the optional code-review orchestrator for the best-matching review
 * integration. When `target` is provided it prefers that integration id (or
 * a review task tagged with `ticketSourceLabel = <provider>:<integrationId>`),
 * then falls back to the next active review integration that declares
 * `createReviewer` in its descriptor.
 */
export function buildReviewBundle(
  pluginManager: PluginManager,
  _workspaceBaseDir: string,
  stateStore: StateStore & PromptStore,
  workspaceRunner?: WorkspaceRunner,
  concurrencyTracker?: ConcurrencyTracker,
  target?: string | Task,
  lifecycleCoordinator?: TaskLifecycleCoordinator,
): Promise<ReviewBundle> {
  const bundleLog = getLogger("review-bundle");
  const targetId = typeof target === "string" ? target : target?.taskId ?? "(none)";

  const integration = resolveReviewIntegration(pluginManager, target);
  if (!integration) {
    bundleLog.warn(
      { target: targetId },
      "buildReviewBundle: no active review integration with createReviewer — ensure a Gerrit/GitHub/GitLab review integration is enabled"
    );
    return Promise.resolve({ integration: null, provider: null, orchestrator: null });
  }

  const descriptor = getProviderDescriptor(integration.provider);
  const createReviewer = descriptor?.capabilities.code_review?.createReviewer;
  if (!createReviewer) {
    bundleLog.warn(
      { integrationId: integration.id, type: integration.provider },
      "buildReviewBundle: plugin descriptor for provider does not implement createReviewer"
    );
    return Promise.resolve({ integration: null, provider: null, orchestrator: null });
  }

  let rawConfig: Record<string, unknown>;
  try {
    rawConfig = pluginManager.decryptIntegrationConfig(integration);
    // Run preprocessConfig so that generated/encrypted SSH keys are resolved
    // to temp files (sets _resolvedSshKeyPath / _agentPubKeyPath) before the
    // reviewer factory reads them via buildSshArgs.
    if (descriptor?.preprocessConfig) {
      Object.assign(rawConfig, descriptor.preprocessConfig(rawConfig, getConfig().adminAuthSecret, integration.id));
    }
  } catch (err) {
    bundleLog.warn(
      { integrationId: integration.id, err },
      "buildReviewBundle: failed to decrypt integration config — check ADMIN_AUTH_SECRET and integration credentials"
    );
    return Promise.resolve({ integration: null, provider: null, orchestrator: null });
  }

  if (!workspaceRunner) {
    bundleLog.warn(
      { integrationId: integration.id },
      "buildReviewBundle: no workspace runner available"
    );
    return Promise.resolve({ integration: null, provider: null, orchestrator: null });
  }

  const reviewer = createReviewer(rawConfig, integration, workspaceRunner);
  const orchestrator = new ReviewOrchestrator({
    stateStore,
    reviewProvider: reviewer.provider,
    integrationId: integration.id,
    workspaceRunner,
    buildCloneTarget: reviewer.buildCloneTarget,
    ...(reviewer.applyPatchset !== undefined ? { applyPatchset: reviewer.applyPatchset } : {}),
    sourceLabel: buildIntegrationSourceLabel(integration),
    // Resolved per-task in runReview() — this orchestrator instance is shared
    // across every VE project matching this review integration (a single
    // webhook/stream trigger can spawn tasks for several projects at once via
    // startReviewTask), so the project's own agent/model/token can only be
    // determined once the task (and thus its project) is known.
    resolveAgentForProject: (project: ProjectRecord): ReturnType<typeof resolveReviewAgentForProject> =>
      resolveReviewAgentForProject(pluginManager, stateStore, project, bundleLog),
    agentContainerImage: getConfig().agentContainerImage,
    maxDiffChars: getConfig().maxReviewDiffChars,
    maxReviewComments: getConfig().maxReviewComments,
    maxReviewReplies: getConfig().maxReviewReplies,
    reviewMinSeverity: getConfig().reviewMinSeverity,
    agentTimeoutMs: getConfig().agentTimeoutMs,
    ...(concurrencyTracker !== undefined ? { concurrencyTracker } : {}),
    ...(lifecycleCoordinator !== undefined ? { lifecycleCoordinator } : {}),
  });
  return Promise.resolve({ integration, provider: reviewer.provider, orchestrator });
}

// ─── Review trigger ───────────────────────────────────────────────────────────

/**
 * Build a review trigger that creates and immediately runs a code-review task
 * when a Gerrit stream-events connection receives a relevant event.
 *
 * Flow:
 *  1. Ask the review provider whether VE is an active reviewer on the change
 *     (using `isReviewer()` when available; falls back to always-true).
 *  2. Call `ReviewOrchestrator.startReviewTask()` — idempotent, returns null if
 *     a task already exists for this patchset.
 *  3. Fire-and-forget `runReview()` on the new task.
 *
 * Returns null when no active review integration exposes `createReviewer`.
 */
export function buildReviewTrigger(
  pluginManager: PluginManager,
  workspaceBaseDir: string,
  workspaceRunner: WorkspaceRunner,
  stateStore: StateStore & PromptStore,
  concurrencyTracker?: ConcurrencyTracker,
  lifecycleCoordinator?: TaskLifecycleCoordinator,
): import("../connectors/integrationStreamEvents.js").IntegrationEventStreamReviewTrigger | null {
  if (resolveReviewIntegration(pluginManager) === null) return null;

  const log = getLogger("review-trigger");

  return {
    async triggerReviewForChange(integrationId: string, changeId: string, options?: { force?: boolean }): Promise<void> {
      const bundle = await buildReviewBundle(pluginManager, workspaceBaseDir, stateStore, workspaceRunner, concurrencyTracker, integrationId, lifecycleCoordinator);
      if (!bundle.orchestrator || !bundle.provider || !bundle.integration) {
        log.warn({ integrationId, changeId }, "review trigger: integration not configured for review routing");
        return;
      }

      const gerritChangeId = makeExternalChangeId(changeId);
      const force = options?.force === true;

      // 1. Self-review + assignment guard.
      if (typeof bundle.provider.isReviewer === "function") {
        const assigned = await bundle.provider.isReviewer(gerritChangeId);
        if (!assigned) {
          log.debug({ integrationId, changeId }, "review trigger: VE is not a reviewer — skipping review task creation");
          return;
        }
      }

      // 2. Create review tasks — one per matching VE project (idempotent).
      //    `force` propagates the manual-trigger intent so an already-reviewed
      //    patchset is re-reviewed instead of skipped.
      let reviewTasks: import("../interfaces.js").Task[];
      try {
        reviewTasks = await bundle.orchestrator.startReviewTask({
          changeId: gerritChangeId,
          ...(force ? { force: true } : {}),
        });
      } catch (err) {
        log.error({ err, integrationId, changeId }, "review trigger: failed to create review task");
        return;
      }
      if (reviewTasks.length === 0) {
        log.debug({ integrationId, changeId }, "review trigger: no tasks created — change not OPEN or no matching project");
        return;
      }

      // 3. Run each review immediately (fire-and-forget with error logging).
      for (const task of reviewTasks) {
        log.info({ integrationId, taskId: task.taskId, changeId, force }, "review trigger: task created, starting review");
        bundle.orchestrator.runReview(task.taskId, force ? { force: true } : undefined).catch((err: unknown) => {
          log.error({ err, integrationId, taskId: task.taskId, changeId }, "review trigger: review run failed");
        });
      }
    },
  };
}
