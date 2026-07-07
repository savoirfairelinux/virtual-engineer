/**
 * Application entry point.
 *
 * Bootstraps all runtime dependencies — state store, plugin manager, agent
 * adapter, VCS connector, orchestrator, polling loop, review orchestrator,
 * webhook server, and admin HTTP server — then starts the main loop.
 *
 * Hot-reload: `refreshRuntimeDependencies()` is called whenever the admin UI
 * updates an integration, allowing credential and config changes to take
 * effect without a process restart.
 */
import { getConfig } from "./config.js";
import { getLogger } from "./logger.js";
import { SqliteStateStore } from "./state/stateStore.js";
import { MockAgentAdapter } from "./agents/mockAgentAdapter.js";
import { DockerWorkspaceRunner } from "./workspace/workspaceRunner.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { PollingLoop } from "./orchestrator/pollingLoop.js";
import { createConcurrencyTracker } from "./orchestrator/concurrencyTracker.js";
import { createAdminServer } from "./admin/adminServer.js";
import { closeAdminServer } from "./admin/closeAdminServer.js";
import { startAdminServer } from "./admin/startAdminServer.js";

import { PluginIntegrationStreamEventsManager } from "./connectors/integrationStreamEvents.js";
import { ReviewOrchestrator } from "./review/reviewOrchestrator.js";
import { mkdir } from "fs/promises";
import type { Server } from "node:http";
import type { AdminProviderSummary } from "./admin/adminServer.js";
import type { AgentAdapter, ConfigurableAdapter, DomainCapability, Integration, ProviderId, ProjectId, ProjectPushTargetRecord, ProjectRecord, ProjectReviewConfig, ProjectTicketSourceRecord, ReviewProvider, Task } from "./interfaces.js";
import { makeTaskId, makeExternalChangeId } from "./interfaces.js";
import { registerBuiltinPlugins } from "./plugins/init.js";
import { PluginManager } from "./plugins/pluginManager.js";
import type { AppConfig } from "./config.js";
import { getProviderDescriptor, getProviderDomainCapabilities, getCapabilityIntake } from "./plugins/registry.js";
import { buildTicketSourceLabel, parseIntegrationIdFromSourceLabel } from "./utils/ticketSourceLabel.js";

const log = getLogger("main");
const SHUTDOWN_TIMEOUT_MS = 5_000;
/**
 * Debounce window for polling-loop reconciliation triggered by task state
 * changes. Coalesces bursts of transitions (e.g. a task advancing through
 * several states, or many tasks moving at once) into a single
 * `pollingIsRequired()` re-check instead of querying the DB per transition.
 */
const POLLING_RECONCILE_DEBOUNCE_MS = 1_000;

/** Bootstrap all runtime dependencies and start the Virtual Engineer main loop. */
async function main(): Promise<void> {
  const config = getConfig();

  log.info({ nodeEnv: config.nodeEnv }, "Virtual Engineer starting");

  // Ensure required directories exist
  await mkdir(config.workspaceBaseDir, { recursive: true });

  // ─── State Store ────────────────────────────────────────────────────────────
  const stateStore = await SqliteStateStore.create(config.databasePath);

  // ─── Editable workflow settings ───────────────────────────────────────────────
  // Env/config values are the fallback defaults; persisted overrides (edited from
  // the admin UI and stored in `app_settings`) take precedence and are applied here
  // so the running polling loop / orchestrator honour them from boot.
  const settingsDefaults = {
    pollingIntervalMs: config.pollingIntervalMs,
    maxAgentCycles: config.maxAgentCycles,
    maxRetryAttempts: config.maxRetryAttempts,
  };
  const persistedSettings = await stateStore.getAppSettings();
  config.pollingIntervalMs = persistedSettings.pollingIntervalMs ?? settingsDefaults.pollingIntervalMs;
  config.maxAgentCycles = persistedSettings.maxAgentCycles ?? settingsDefaults.maxAgentCycles;
  config.maxRetryAttempts = persistedSettings.maxRetryAttempts ?? settingsDefaults.maxRetryAttempts;

  registerBuiltinPlugins(config.adminAuthSecret !== undefined ? { adminAuthSecret: config.adminAuthSecret } : undefined);
  // Agent adapters are self-describing: any provider whose descriptor declares
  // an `agent_execution.buildAdapter` hook is instantiated by the plugin
  // manager using this host runtime context. Adding a new agent backend
  // (Copilot, Claude, …) needs no wiring here — only a descriptor.
  const pluginManager = new PluginManager(stateStore, {
    ...(config.adminAuthSecret !== undefined ? { adminAuthSecret: config.adminAuthSecret } : {}),
    agentAdapterContext: {
      maxCommitsPerCycle: config.maxCommitsPerCycle,
      dockerNetwork: config.agentDockerNetwork,
    },
  });

  await pluginManager.loadFromDatabase();

  let runtimeDependencies = buildRuntimeDependencies(pluginManager);

  // ─── Workspace runner ────────────────────────────────────────────────────────
  const workspaceRunner = new DockerWorkspaceRunner(
    {
      agentContainerImage: config.agentContainerImage,
      agentTimeoutMs: config.agentTimeoutMs,
    },
    runtimeDependencies.agentAdapter
  );
  configureAgentAdapter(runtimeDependencies.agentAdapter, stateStore, workspaceRunner);

  // ─── Orchestrator ────────────────────────────────────────────────────────────
  // Phase 6 — single in-process concurrency tracker shared by orchestrator and
  // polling loop. Counters live in memory and reset on process restart.
  const concurrencyTracker = createConcurrencyTracker({
    agentStore: { getAgentById: (id) => stateStore.getAgentById(id) },
  });
  const projectModeBase = {
    projectStore: stateStore,
    pluginManager,
    concurrencyTracker,
  } satisfies import("./orchestrator/orchestrator.js").ProjectModeDeps
    & NonNullable<Parameters<PollingLoop["setProjectMode"]>[0]>;
  const orchestratorProjectMode: import("./orchestrator/orchestrator.js").ProjectModeDeps = projectModeBase;
  const pollingProjectMode: NonNullable<Parameters<PollingLoop["setProjectMode"]>[0]> = projectModeBase;
  const orchestrator = new Orchestrator(
    buildOrchestratorConfig(config, pluginManager),
    stateStore,
    workspaceRunner,
    undefined,
    stateStore,
    orchestratorProjectMode
  );

  // ─── Polling loop ────────────────────────────────────────────────────────────
  // Mutable holder so the review trigger survives hot-reload of the review
  // integration without recreating the stream-events manager.
  const reviewTriggerHolder = {
    current: buildReviewTrigger(pluginManager, config.workspaceBaseDir, workspaceRunner, stateStore),
  };

  /** Thin wrapper that forwards to the stream-events review trigger. Used by the polling loop. */
  const pollingReviewTrigger: import("./orchestrator/pollingLoop.js").ReviewAssignmentTrigger = {
    async triggerReview(integrationId: string, changeId: string): Promise<void> {
      await reviewTriggerHolder.current?.triggerReviewForChange(integrationId, changeId);
    },
  };

  const pollingLoop = new PollingLoop(
    {
      ticketIntervalMs: config.pollingIntervalMs,
      maxRetryAttempts: config.maxRetryAttempts,
    },
    orchestrator,
    stateStore,
    { ...pollingProjectMode, reviewTrigger: pollingReviewTrigger }
  );

  /**
   * Start or stop the polling loop to match current need. Idempotent: only
   * acts when the running state disagrees with `pollingIsRequired()`.
   */
  async function reconcilePollingLoop(): Promise<void> {
    const required = await pollingIsRequired(stateStore, pluginManager, integrationStreamEvents);
    if (required && !pollingLoop.isRunning()) {
      log.info("polling required — starting polling loop");
      pollingLoop.start();
    } else if (!required && pollingLoop.isRunning()) {
      log.info("polling no longer required — stopping polling loop");
      pollingLoop.stop();
    }
  }

  // Debounced reconcile trigger for task state changes. A single timer
  // coalesces bursts so we run one `pollingIsRequired()` re-check per window.
  let pollingReconcileTimer: ReturnType<typeof setTimeout> | null = null;
  function schedulePollingReconcile(): void {
    if (pollingReconcileTimer) return;
    pollingReconcileTimer = setTimeout(() => {
      pollingReconcileTimer = null;
      reconcilePollingLoop().catch((err: unknown) => {
        log.error({ err }, "polling loop reconcile failed");
      });
    }, POLLING_RECONCILE_DEBOUNCE_MS);
  }

  // Reconcile the polling loop whenever a task changes state. This starts the
  // loop when a task enters a state whose only recovery path (on a missed
  // stream event) is a fallback poller (`pollInReviewTasks` /
  // `pollReviewWatchingTasks`) — even in an otherwise stream-only setup — and
  // stops it again once no project or active task requires polling, so we
  // don't leave background work running indefinitely.
  stateStore.onTaskTransition(() => {
    schedulePollingReconcile();
  });

  const integrationStreamEvents = new PluginIntegrationStreamEventsManager({
    orchestrator,
    getReviewTrigger: (): import("./connectors/integrationStreamEvents.js").IntegrationEventStreamReviewTrigger | undefined => reviewTriggerHolder.current ?? undefined,
  });

  /**
   * Return the active integrations with their `configJson` augmented by the
   * SSH key-resolution extras (`_resolvedSshKeyPath` / `_agentPubKeyPath`) that
   * `preprocessConfig` produces. The stream-events listeners parse `configJson`
   * directly, so without this a generated-key (encrypted) or agent-identity
   * integration would never resolve its key to a temp file and would silently
   * fall back to plain SSH agent mode — matching the review/clone paths that
   * already run `preprocessConfig`.
   */
  function resolveStreamIntegrations(): Integration[] {
    return pluginManager.getActiveIntegrations().map((integration) => {
      let extras: Record<string, unknown>;
      try {
        extras = pluginManager.resolveConfigRuntimeExtras(integration);
      } catch (err) {
        log.warn({ integrationId: integration.id, err }, "failed to resolve SSH key material for stream integration");
        return integration;
      }
      if (Object.keys(extras).length === 0) {
        return integration;
      }
      const merged = { ...(JSON.parse(integration.configJson) as Record<string, unknown>), ...extras };
      return { ...integration, configJson: JSON.stringify(merged) };
    });
  }

  await integrationStreamEvents.reconcile(resolveStreamIntegrations());

  const adminRuntimeConfig = {
    nodeEnv: config.nodeEnv,
    logLevel: config.logLevel,
    maxAgentCycles: config.maxAgentCycles,
    maxRetryAttempts: config.maxRetryAttempts,
    pollingIntervalMs: config.pollingIntervalMs,
    adminAuthSecret: config.adminAuthSecret,
  };

  /**
   * Rebuild all runtime dependencies from the current plugin manager state
   * and push the updated connectors into the orchestrator, polling loop, and
   * workspace runner without stopping them. Called after any admin integration
   * change.
   */
  async function refreshRuntimeDependencies(): Promise<void> {
    runtimeDependencies = buildRuntimeDependencies(pluginManager);
    workspaceRunner.updateRuntime({
      agentAdapter: runtimeDependencies.agentAdapter,
    });
    configureAgentAdapter(runtimeDependencies.agentAdapter, stateStore, workspaceRunner);
    orchestrator.updateRuntime({
      config: buildOrchestratorConfig(config, pluginManager),
    });
    pollingLoop.resetBackoff();
    reviewTriggerHolder.current = buildReviewTrigger(pluginManager, config.workspaceBaseDir, workspaceRunner, stateStore);
    await integrationStreamEvents.reconcile(resolveStreamIntegrations());
    log.info("runtime dependencies refreshed");
    await reconcilePollingLoop();
  }

  if (typeof pluginManager.onPluginChange === "function") {
    pluginManager.onPluginChange(() => {
      refreshRuntimeDependencies().catch((err: unknown) => {
        log.error({ err }, "hot-reload of runtime dependencies failed");
      });
    });
  }

  /**
   * Editable-settings controller for the admin API. Persists overrides to
   * `app_settings` and hot-applies them to the running polling loop, orchestrator,
   * and the admin runtime config — no process restart required.
   */
  const settingsController = {
    get: (): import("./admin/adminSettingsRoutes.js").EffectiveWorkflowSettings => ({
      pollingIntervalMs: config.pollingIntervalMs,
      maxAgentCycles: config.maxAgentCycles,
      maxRetryAttempts: config.maxRetryAttempts,
    }),
    update: async (
      patch: import("./admin/adminSettingsRoutes.js").WorkflowSettingsPatch
    ): Promise<import("./admin/adminSettingsRoutes.js").EffectiveWorkflowSettings> => {
      const persisted = await stateStore.updateAppSettings(patch);
      config.pollingIntervalMs = persisted.pollingIntervalMs ?? settingsDefaults.pollingIntervalMs;
      config.maxAgentCycles = persisted.maxAgentCycles ?? settingsDefaults.maxAgentCycles;
      config.maxRetryAttempts = persisted.maxRetryAttempts ?? settingsDefaults.maxRetryAttempts;

      // Hot-apply to running subsystems.
      pollingLoop.updateConfig({
        ticketIntervalMs: config.pollingIntervalMs,
        maxRetryAttempts: config.maxRetryAttempts,
      });
      orchestrator.updateRuntime({ config: buildOrchestratorConfig(config, pluginManager) });
      adminRuntimeConfig.pollingIntervalMs = config.pollingIntervalMs;
      adminRuntimeConfig.maxAgentCycles = config.maxAgentCycles;
      adminRuntimeConfig.maxRetryAttempts = config.maxRetryAttempts;

      log.info(
        {
          pollingIntervalMs: config.pollingIntervalMs,
          maxAgentCycles: config.maxAgentCycles,
          maxRetryAttempts: config.maxRetryAttempts,
        },
        "workflow settings updated"
      );
      return settingsController.get();
    },
  };

  let adminServer: Server | null = null;
  if (config.adminApiEnabled) {
    if (!config.adminAuthSecret) {
      log.warn("admin API is enabled without authentication configured");
    }
    adminServer = createAdminServer({
      stateStore,
      config: adminRuntimeConfig,
      polling: pollingLoop,
      providers: () => buildAdminProviderSummaries(config, pluginManager),
      agentStore: stateStore,
      projectStore: stateStore,
      integrationStore: stateStore,
      oAuthAppStore: stateStore,
      promptStore: stateStore,
      pluginManager,
      taskControl: {
        resumeTask: async (taskId) => {
          const task = await stateStore.getTask(makeTaskId(String(taskId)));
          if (task?.taskType === "code-review") {
            const bundle = await buildReviewBundle(pluginManager, config.workspaceBaseDir, stateStore, workspaceRunner, task);
            if (bundle.orchestrator) {
              await bundle.orchestrator.runReview(task.taskId);
              return;
            }
          }
          await orchestrator.continueTask(taskId);
        },
        retryTask: async (taskId) => {
          const task = await stateStore.getTask(makeTaskId(String(taskId)));
          if (task?.taskType === "code-review") {
            const bundle = await buildReviewBundle(pluginManager, config.workspaceBaseDir, stateStore, workspaceRunner, task);
            if (bundle.orchestrator) {
              await bundle.orchestrator.runReview(task.taskId);
              return;
            }
          }
          await orchestrator.continueTask(taskId);
        },
      },
      onIntegrationUpdated: (id) => {
        orchestrator.invalidateVcsConnector(id);
      },
      onProjectChange: () => {
        refreshRuntimeDependencies().catch((err: unknown) => {
          log.error({ err }, "hot-reload of runtime dependencies failed");
        });
      },
      webhooks: {
        projectStore: stateStore,
        orchestrator: Object.assign(orchestrator, {
          triggerReviewForChange: async (integrationId: string, changeId: string) => {
            const trigger = reviewTriggerHolder.current;
            if (!trigger) {
              log.debug({ integrationId, changeId }, "webhook review trigger: no review-capable integration configured");
              return;
            }
            await trigger.triggerReviewForChange(integrationId, changeId);
          },
        }),
      },
      integrationStreams: integrationStreamEvents,
      concurrency: {
        snapshot: () => concurrencyTracker.snapshot(),
      },
      settings: settingsController,
    });

    await startAdminServer(adminServer, config.adminApiPort, config.adminApiHost);
    log.info({ host: config.adminApiHost, port: config.adminApiPort }, "admin API listening");
  }

  // Resume any tasks that were in-flight before a restart.
  // Must run AFTER the admin server binds successfully so a port conflict
  // does not cause a partially-resumed orchestrator state.
  await orchestrator.resumeActiveTasks();

  // ─── Graceful shutdown ────────────────────────────────────────────────────────
  let shuttingDown = false;

  /** Stop all subsystems and exit cleanly on SIGINT or SIGTERM. */
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    log.info({ signal }, "shutting down");
    if (pollingReconcileTimer) {
      clearTimeout(pollingReconcileTimer);
      pollingReconcileTimer = null;
    }
    pollingLoop.stop();

    await closeAdminServer(adminServer, SHUTDOWN_TIMEOUT_MS);

    await integrationStreamEvents.stopAll();

    try {
      await Promise.resolve(stateStore.close());
    } catch (err) {
      log.error({ err }, "failed to close state store cleanly during shutdown");
    }

    process.exit(0);
  }

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  if (await pollingIsRequired(stateStore, pluginManager, integrationStreamEvents)) {
    pollingLoop.start();
  } else {
    log.info(
      "Polling loop not started: no enabled project currently requires polling. " +
      "This only affects ticket-discovery polling (coding projects) and fallback " +
      "polling for in-review tasks; stream-based review intake (e.g., Gerrit) " +
      "continues to work. The loop will start automatically when a polling-based " +
      "project is configured or a task needs the fallback poller, and stop again " +
      "once neither is the case."
    );
  }
  log.info("Virtual Engineer running — press Ctrl+C to stop");
}

/** Return all active integrations of `provider`, sorted newest-first. */
function getActiveIntegrationsByType(pluginManager: PluginManager, provider: ProviderId): Integration[] {
  return pluginManager
    .getActiveIntegrationsByProvider(provider)
    .slice()
    .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
}

/** Return the most-recently-updated active integration of `provider`, or null. */
function getPrimaryActiveIntegration(pluginManager: PluginManager, provider: ProviderId): Integration | null {
  return getActiveIntegrationsByType(pluginManager, provider)[0] ?? null;
}

/** Build the `<provider>:<id>` source label persisted on tasks and review bundles. */
function buildIntegrationSourceLabel(integration: Integration): string {
  return buildTicketSourceLabel(integration.provider, integration.id);
}

/** Parse the integration ID out of a `<provider>:<integrationId>` source label string. */
function getIntegrationIdFromSourceLabel(sourceLabel: string | null | undefined): string | null {
  return parseIntegrationIdFromSourceLabel(sourceLabel);
}

/**
 * Resolve an active review integration that has a `createReviewer`
 * descriptor hook.  When `target` is a `Task`, the integration referenced by
 * `ticketSourceLabel` is tried first; when it is a plain string it is treated
 * as an explicit integration id.  Falls back to the most-recently-updated
 * active review-category integration that supports the factory.
 */
function resolveReviewIntegration(
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

/**
 * Returns true when polling is actually required.
 *
 * Polling is needed when:
 * - There is at least one enabled coding project with active ticket source +
 *   push target integrations (ticket discovery always relies on polling).
 * - There is at least one enabled review project whose active review
 *   integration does NOT deliver events via a stream (e.g. GitHub/GitLab
 *   MRs need polling; Gerrit with stream-events does not).
 * - There is at least one active task whose progression depends on the
 *   polling-loop fallbacks (`pollInReviewTasks` / `pollReviewWatchingTasks`).
 *   Those fallbacks compensate for missed stream events, so a stream-only
 *   setup (e.g. Gerrit) that restarted with an `IN_REVIEW` code-gen or
 *   `REVIEW_WATCHING` code-review task still needs polling to avoid
 *   stranding it.
 */
interface StreamStatusChecker {
  getStatus(integrationId: string): { state: string } | null;
}

async function pollingIsRequired(
  store: {
    listProjects(filter?: { enabled?: boolean }): Promise<ProjectRecord[]>;
    getProjectTicketSource(id: ProjectId): Promise<ProjectTicketSourceRecord | null>;
    listProjectPushTargets(id: ProjectId): Promise<ProjectPushTargetRecord[]>;
    getProjectReviewConfig(id: ProjectId): Promise<ProjectReviewConfig | null>;
    getActiveTasks(): Promise<Task[]>;
  },
  pluginManager: PluginManager,
  streamEvents?: StreamStatusChecker
): Promise<boolean> {
  // Active tasks whose only progression path (when their stream event is
  // missed) is the polling-loop fallback keep polling alive regardless of
  // project configuration.
  const activeTasks = await store.getActiveTasks();
  const needsFallbackPoll = activeTasks.some(
    (t) =>
      t.externalChangeId != null &&
      ((t.taskType === "code-gen" && t.state === "IN_REVIEW") ||
        (t.taskType === "code-review" && t.state === "REVIEW_WATCHING"))
  );
  if (needsFallbackPoll) return true;

  const projects = await store.listProjects({ enabled: true });
  for (const project of projects) {
    if (project.type === "coding") {
      const ts = await store.getProjectTicketSource(project.id);
      if (!ts || !pluginManager.isIntegrationActive(ts.integrationId)) continue;
      const pts = await store.listProjectPushTargets(project.id);
      if (pts.some(pt => pluginManager.isIntegrationActive(pt.integrationId))) return true;
    } else if (project.type === "review") {
      const rc = await store.getProjectReviewConfig(project.id);
      if (!rc || !pluginManager.isIntegrationActive(rc.integrationId)) continue;
      if (!pluginManager.integrationHasStreamEvents(rc.integrationId)) {
        // Only start polling if the provider implements polling-based
        // assignment discovery (e.g. GitHub).  Webhook-only providers
        // (e.g. GitLab) do not implement getOpenReviewAssignments, so
        // starting the loop would achieve nothing.
        const intake = pluginManager.getIntegrationCapabilityIntake(rc.integrationId, "code_review");
        if (intake.includes("polling")) return true;
        continue;
      }
      // Stream-backed (e.g. Gerrit): fall back to polling when the stream
      // connection is degraded so in-progress tasks are not stranded.
      if (streamEvents) {
        const status = streamEvents.getStatus(rc.integrationId);
        if (status?.state === "error" || status?.state === "stopped") return true;
      }
    }
  }
  return false;
}

interface ReviewBundle {
  integration: Integration | null;
  provider: ReviewProvider | null;
  orchestrator: ReviewOrchestrator | null;
}

/**
 * Resolve the optional code-review orchestrator for the best-matching review
 * integration. When `target` is provided it prefers that integration id (or
 * a review task tagged with `ticketSourceLabel = <provider>:<integrationId>`),
 * then falls back to the next active review integration that declares
 * `createReviewer` in its descriptor.
 */
async function buildReviewBundle(
  pluginManager: PluginManager,
  _workspaceBaseDir: string,
  stateStore: import("./interfaces.js").StateStore & import("./interfaces.js").PromptStore,
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

  const store = stateStore;

  if (!workspaceRunner) {
    bundleLog.warn(
      { integrationId: integration.id },
      "buildReviewBundle: no DockerWorkspaceRunner available"
    );
    return { integration: null, provider: null, orchestrator: null };
  }

  // Resolve the agent-execution integration linked to an enabled review agent.
  // Using a deterministic lookup avoids Map-insertion-order sensitivity when
  // multiple agent_execution integrations (e.g. Copilot + Claude) are active.
  const agentIntegration = await resolveAgentIntegrationForReview(pluginManager, store);

  // Extract the agent token from the resolved agent-execution integration.
  const agentToken = getAgentTokenForReview(pluginManager, agentIntegration);
  if (!agentToken) {
    bundleLog.warn(
      { integrationId: integration.id },
      "buildReviewBundle: no agent token available — ensure an agent integration (Copilot or Claude) is enabled with a configured token/key"
    );
    return { integration: null, provider: null, orchestrator: null };
  }

  // Resolve the model from the enabled review agent linked to the selected integration.
  // This honours the model chosen in the agents library rather than the global default.
  let model: string | undefined;
  if (agentIntegration) {
    try {
      const agentList = await store.listAgents({ type: "review", enabled: true });
      const agent = agentList.find((a) => a.integrationId === agentIntegration.id);
      if (agent) {
        const cfg = JSON.parse(agent.modelConfigJson) as Record<string, unknown>;
        const m = typeof cfg["model"] === "string" ? cfg["model"].trim() : "";
        if (m) model = m;
      }
    } catch {
      // non-fatal — fall back to the adapter's default model
    }
  }

  const reviewer = createReviewer(rawConfig, integration, workspaceRunner);

  const orchestrator = new ReviewOrchestrator({
    stateStore: store,
    reviewProvider: reviewer.provider,
    integrationId: integration.id,
    agentToken: agentToken,
    workspaceRunner,
    buildCloneTarget: reviewer.buildCloneTarget,
    ...(reviewer.applyPatchset !== undefined ? { applyPatchset: reviewer.applyPatchset } : {}),
    sourceLabel: buildIntegrationSourceLabel(integration),
    ...(model !== undefined ? { model } : {}),
    reviewInstructions: await (async (): Promise<string> => {
      const p = await store.getPrompt(reviewer.userPromptId);
      if (!p) throw new Error(`Required prompt '${reviewer.userPromptId}' not found in DB — run db:migrate to seed built-in prompts`);
      return p.content;
    })(),
    reviewSystemPrompt: await (async (): Promise<string> => {
      const p = await store.getPrompt(reviewer.systemPromptId);
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
function buildReviewTrigger(
  pluginManager: PluginManager,
  workspaceBaseDir: string,
  workspaceRunner: DockerWorkspaceRunner,
  stateStore: import("./interfaces.js").StateStore & import("./interfaces.js").PromptStore
): import("./connectors/integrationStreamEvents.js").IntegrationEventStreamReviewTrigger | null {
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
      let reviewTasks: import("./interfaces.js").Task[];
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

/**
 * Find the agent-execution integration most appropriate for the review flow.
 * Prefers an integration explicitly linked to an enabled review agent (which
 * is deterministic and semantically correct); falls back to any active
 * agent_execution integration sorted by ID to avoid Map-insertion-order
 * sensitivity when multiple integrations (e.g. Copilot + Claude) are active.
 */
async function resolveAgentIntegrationForReview(
  pluginManager: PluginManager,
  store: import("./interfaces.js").StateStore
): Promise<Integration | null> {
  try {
    const reviewAgents = await store.listAgents({ type: "review", enabled: true });
    for (const agent of reviewAgents) {
      if (!agent.integrationId) continue;
      const integration = pluginManager.getActiveIntegrationById(agent.integrationId);
      if (integration) return integration;
    }
  } catch {
    // non-fatal — fall through to stable fallback
  }
  // Stable fallback: sort by ID so the selection is reproducible across restarts.
  const all = pluginManager
    .getActiveIntegrationsByCapability("agent_execution")
    .sort((a, b) => a.id.localeCompare(b.id));
  return all[0] ?? null;
}

/**
 * Extract the agent token from the provided agent-execution integration.
 * Provider-agnostic: works for Copilot (OAuth `sessionToken` or PAT `token`)
 * and Claude (OAuth `sessionToken` or `apiKey`).
 * Returns null when the integration is null or has no valid token.
 */
function getAgentTokenForReview(pluginManager: PluginManager, agentIntegration: Integration | null): string | null {
  if (!agentIntegration) return null;

  let agentConfig: Record<string, unknown>;
  try {
    // decryptIntegrationConfig handles AES-256-GCM encrypted tokens (OAuth
    // sessionToken) and plaintext fields, leaving unknown strings as-is.
    agentConfig = pluginManager.decryptIntegrationConfig(agentIntegration);
  } catch {
    return null;
  }

  // OAuth session token (Copilot OAuth, Claude subscription interactive flow).
  const sessionToken = asOptionalString(agentConfig["sessionToken"]);
  if (sessionToken) return sessionToken;
  // Claude API key.
  const apiKey = asOptionalString(agentConfig["apiKey"]);
  if (apiKey) return apiKey;
  // Copilot PAT (plaintext or decrypted).
  return asOptionalString(agentConfig["token"]) ?? null;
}

/** Return the first active agent-adapter connector found in the plugin manager, or null. */
function getDatabaseAgentAdapter(pluginManager: PluginManager): AgentAdapter | null {
  // Resolve the first active integration with the agent_execution capability.
  // Any provider that declares agent_execution qualifies —
  // copilot, mock, and future AI providers are all picked up automatically.
  for (const integration of pluginManager.getActiveIntegrationsByCapability("agent_execution")) {
    const connector = pluginManager.getConnectorForCapability<AgentAdapter>(integration.id, "agent_execution");
    if (connector) {
      return connector;
    }
  }
  return null;
}

interface RuntimeDependencies {
  agentAdapter: AgentAdapter;
}

/** Assemble the mutable runtime dependencies (agent adapter) from the current plugin state. */
function buildRuntimeDependencies(pluginManager: PluginManager): RuntimeDependencies {
  return {
    agentAdapter: getDatabaseAgentAdapter(pluginManager) ?? new MockAgentAdapter(),
  };
}

/** Build the `OrchestratorConfig` by merging app config with VCS integration settings. */
function buildOrchestratorConfig(
  config: AppConfig,
  pluginManager: PluginManager
): import("./orchestrator/orchestrator.js").OrchestratorConfig {
  // Resolve gitAuthorName/gitAuthorEmail through the descriptor Zod schemas so
  // that defaults declared in the schema apply even for DB rows that predate
  // this field (i.e. rows stored without the key).
  const gitLabIntegration = getPrimaryActiveIntegration(pluginManager, "gitlab");
  const gerritIntegration = getPrimaryActiveIntegration(pluginManager, "gerrit");

  let gitAuthorName: string | undefined;
  let gitAuthorEmail: string | undefined;

  for (const integration of [gitLabIntegration, gerritIntegration]) {
    if (!integration || (gitAuthorName && gitAuthorEmail)) break;
    const raw = parseIntegrationConfig(integration);
    const descriptor = getProviderDescriptor(integration.provider);
    const result = descriptor?.configSchema.safeParse(raw ?? {});
    if (result?.success) {
      const data = result.data as Record<string, unknown>;
      gitAuthorName ??= typeof data["gitAuthorName"] === "string" ? data["gitAuthorName"] : undefined;
      gitAuthorEmail ??= typeof data["gitAuthorEmail"] === "string" ? data["gitAuthorEmail"] : undefined;
    }
  }

  return {
    maxAgentCycles: config.maxAgentCycles,
    maxRetryAttempts: config.maxRetryAttempts,
    agentTimeoutMs: config.agentTimeoutMs,
    gitAuthorName: gitAuthorName ?? "Virtual Engineer",
    gitAuthorEmail: gitAuthorEmail ?? "ve@virtual-engineer.local",
    agentContainerImage: config.agentContainerImage,
    ...(config.adminAuthSecret !== undefined ? { adminAuthSecret: config.adminAuthSecret } : {}),
  };
}

/** Parse an integration's `configJson` into a plain-object record; returns null on error or non-object. */
function parseIntegrationConfig(integration: Integration | null): Record<string, unknown> | null {
  if (!integration) {
    return null;
  }

  try {
    const parsed = JSON.parse(integration.configJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}


/** Return `value` as a string if it is a non-empty string, otherwise undefined. */
function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Wire the adapter to its runtime dependencies if it implements ConfigurableAdapter. */
function configureAgentAdapter(
  agentAdapter: AgentAdapter,
  stateStore: SqliteStateStore,
  workspaceRunner: DockerWorkspaceRunner
): void {
  if ("configure" in agentAdapter && typeof (agentAdapter as ConfigurableAdapter).configure === "function") {
    (agentAdapter as ConfigurableAdapter).configure({ store: stateStore, runner: workspaceRunner });
  }
}

/** Build the list of `AdminProviderSummary` entries shown in the admin UI's provider panel. */
function buildAdminProviderSummaries(config: ReturnType<typeof getConfig>, pluginManager?: PluginManager): AdminProviderSummary[] {
  const summaries: AdminProviderSummary[] = [
    {
      id: "admin-api",
      name: "Admin API",
      category: "runtime",
      domainCapabilities: [],
      intake: {},
      enabled: config.adminApiEnabled,
      configured: true,
      status: config.adminApiEnabled ? "ready" : "disabled",
      details: [`Bound to ${config.adminApiHost}:${config.adminApiPort}`],
    },
  ];

  if (!pluginManager) {
    return summaries;
  }

  const activeIntegrations = [
    ...pluginManager.getActiveIntegrationsByCapability("issue_tracking"),
    ...pluginManager.getActiveIntegrationsByCapability("code_review"),
    ...pluginManager.getActiveIntegrationsByCapability("agent_execution"),
  ];

  for (const integration of activeIntegrations) {
    if (summaries.some((s) => s.id === integration.id)) continue;
    summaries.push(buildAdminProviderSummaryForIntegration(integration, config));
  }

  return summaries;
}

/** Build a single `AdminProviderSummary` for an active integration, with type-specific detail lines. */
function buildAdminProviderSummaryForIntegration(
  integration: Integration,
  config: ReturnType<typeof getConfig>
): AdminProviderSummary {
  const parsed = parseIntegrationConfig(integration) ?? {};
  const descriptor = getProviderDescriptor(integration.provider);
  if (!descriptor) {
    throw new Error(`No descriptor registered for active integration provider '${integration.provider}' (id: ${integration.id})`);
  }
  const domainCapabilities = getProviderDomainCapabilities(descriptor);
  const intake: Partial<Record<DomainCapability, Array<"polling" | "webhook" | "stream">>> = {};
  for (const capability of domainCapabilities) {
    const mechanisms = getCapabilityIntake(descriptor, capability);
    if (mechanisms.length > 0) {
      intake[capability] = mechanisms;
    }
  }
  const summaryCategory: AdminProviderSummary["category"] = domainCapabilities.includes("issue_tracking")
    ? "ticketing"
    : domainCapabilities.includes("code_review")
      ? "review"
      : "agent";
  return {
    id: integration.id,
    name: integration.name,
    category: summaryCategory,
    domainCapabilities,
    intake,
    enabled: integration.enabled,
    configured: true,
    status: "ready",
    details: [
      ...descriptor.getSummaryDetails(parsed),
      ...(domainCapabilities.includes("issue_tracking") ? [`Polling every ${config.pollingIntervalMs} ms`] : []),
    ],
  };
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error("Fatal startup error:", err);
  process.exit(1);
});
