/**
 * Review system bootstrap and trigger logic.
 *
 * Handles review-bundle construction (review provider resolution, orchestrator
 * wiring) and building the review trigger used by stream-events and webhooks.
 */
import { getConfig } from "../config.js";
import { getLogger } from "../logger.js";
import { decryptToken } from "../utils/encryption.js";
import { PluginManager } from "../plugins/pluginManager.js";
import { ReviewOrchestrator } from "./reviewOrchestrator.js";
import { DockerWorkspaceRunner } from "../workspace/workspaceRunner.js";
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
  return null;
}

function getDecryptedPasswordField(
  pluginManager: PluginManager,
  integration: Integration,
  field: "token" | "apiKey" | "aiderApiKey"
): string | null {
  try {
    return asOptionalString(pluginManager.decryptIntegrationConfig(integration)[field]) ?? null;
  } catch {
    return null;
  }
}

function decryptManagedSessionToken(
  integration: Integration,
  rawConfig: Record<string, unknown>,
  bundleLog?: ReturnType<typeof getLogger>
): string | null {
  const encrypted = asOptionalString(rawConfig["sessionToken"]);
  if (!encrypted) return null;
  try {
    return decryptToken(encrypted, getConfig().adminAuthSecret);
  } catch (err) {
    bundleLog?.warn(
      { err, integrationId: integration.id, provider: integration.provider },
      "getAgentTokenFromIntegration: failed to decrypt the integration session token"
    );
    return null;
  }
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
    return decryptManagedSessionToken(agentIntegration, rawConfig, bundleLog);
  }

  if (agentIntegration.provider === "claude") {
    const authMode = asOptionalString(rawConfig["authMode"])
      ?? (asOptionalString(rawConfig["apiKey"]) ? "api_key" : "subscription");
    if (authMode === "api_key") {
      return getDecryptedPasswordField(pluginManager, agentIntegration, "apiKey");
    }
    return decryptManagedSessionToken(agentIntegration, rawConfig, bundleLog);
  }

  if (agentIntegration.provider === "aider") {
    const aiderApiKey = getDecryptedPasswordField(pluginManager, agentIntegration, "aiderApiKey");
    if (aiderApiKey) return aiderApiKey;
    if (asOptionalString(rawConfig["aiderBackend"]) === "ollama") return "ollama-keyless";
    return null;
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
  bundleLog: ReturnType<typeof getLogger>
): Promise<{ adapter: AgentAdapter; model: string | undefined; token: string; aiderBackend?: string | undefined; aiderApiBase?: string | undefined } | null> {
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

    // Merge the project's agentOverrideJson on top of the agent's own
    // modelConfigJson so a per-project model override actually applies
    // (same semantics as the coding-agent path in orchestrator.ts).
    const resolved = resolveAgentConfig(agent, project);
    const resolvedModel = resolved.model?.trim() || undefined;

    // Agent-local credentials are accepted only when they match the active
    // provider. This avoids carrying a stale Claude secret into Copilot (or
    // vice versa) after an agent is rebound to another integration.
    let localSessionToken: string | null = null;
    if (resolved.encryptedSessionToken) {
      try {
        localSessionToken = decryptToken(resolved.encryptedSessionToken, getConfig().adminAuthSecret);
      } catch (err) {
        bundleLog.warn(
          { err, projectId: project.id, agentId: agent.id, integrationId: agent.integrationId },
          "resolveReviewAgentForProject: failed to decrypt the project agent token — falling back to the integration token"
        );
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

    return {
      adapter,
      model: resolvedModel,
      token,
      ...(aiderBackend !== undefined ? { aiderBackend } : {}),
      ...(aiderApiBase !== undefined ? { aiderApiBase } : {}),
    };
  } catch (err) {
    bundleLog.warn({ err, projectId: project.id }, "resolveReviewAgentForProject: failed to resolve project agent");
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
export async function buildReviewBundle(
  pluginManager: PluginManager,
  _workspaceBaseDir: string,
  stateStore: StateStore & PromptStore,
  workspaceRunner?: DockerWorkspaceRunner,
  target?: string | Task,
): Promise<ReviewBundle> {
  const bundleLog = getLogger("review-bundle");
  const targetId = typeof target === "string" ? target : target?.taskId ?? "(none)";

  const integration = resolveReviewIntegration(pluginManager, target);
  if (!integration) {
    bundleLog.warn(
      { target: targetId },
      "buildReviewBundle: no active review integration with createReviewer — ensure a Gerrit/GitHub/GitLab review integration is enabled"
    );
    return { integration: null, provider: null, orchestrator: null };
  }

  const descriptor = getProviderDescriptor(integration.provider);
  const createReviewer = descriptor?.capabilities.code_review?.createReviewer;
  if (!createReviewer) {
    bundleLog.warn(
      { integrationId: integration.id, type: integration.provider },
      "buildReviewBundle: plugin descriptor for provider does not implement createReviewer"
    );
    return { integration: null, provider: null, orchestrator: null };
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
    return { integration: null, provider: null, orchestrator: null };
  }

  if (!workspaceRunner) {
    bundleLog.warn(
      { integrationId: integration.id },
      "buildReviewBundle: no DockerWorkspaceRunner available"
    );
    return { integration: null, provider: null, orchestrator: null };
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
    reviewInstructions: await (async (): Promise<string> => {
      const p = await stateStore.getPrompt(reviewer.userPromptId);
      if (!p) throw new Error(`Required prompt '${reviewer.userPromptId}' not found in DB — run db:migrate to seed built-in prompts`);
      return p.content;
    })(),
    reviewSystemPrompt: await (async (): Promise<string> => {
      const p = await stateStore.getPrompt(reviewer.systemPromptId);
      if (!p) throw new Error(`Required prompt '${reviewer.systemPromptId}' not found in DB — run db:migrate to seed built-in prompts`);
      return p.content;
    })(),
    maxDiffChars: getConfig().maxReviewDiffChars,
    maxReviewComments: getConfig().maxReviewComments,
    maxReviewReplies: getConfig().maxReviewReplies,
    reviewMinSeverity: getConfig().reviewMinSeverity,
  });
  return { integration, provider: reviewer.provider, orchestrator };
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
  workspaceRunner: DockerWorkspaceRunner,
  stateStore: StateStore & PromptStore
): import("../connectors/integrationStreamEvents.js").IntegrationEventStreamReviewTrigger | null {
  if (resolveReviewIntegration(pluginManager) === null) return null;

  const log = getLogger("review-trigger");

  return {
    async triggerReviewForChange(integrationId: string, changeId: string, options?: { force?: boolean }): Promise<void> {
      const bundle = await buildReviewBundle(pluginManager, workspaceBaseDir, stateStore, workspaceRunner, integrationId);
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
