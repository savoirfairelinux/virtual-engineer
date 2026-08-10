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
import { HostGitExecutor } from "./workspace/hostGitExecutor.js";
import { OpenShellWorkspaceRunner, type OpenShellRunnerDeps } from "./workspace/openShellWorkspaceRunner.js";
import { OpenShellClient } from "./openshell/openShellClient.js";
import { createRuntimePolicyResolver } from "./openshell/runtimePolicyResolver.js";
import { OpenShellSandboxReconciler } from "./openshell/openShellSandboxReconciler.js";
import { resolveOpenShellGateway, startRuntimeRecovery } from "./runtime/runtimeStartup.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { PollingLoop } from "./orchestrator/pollingLoop.js";
import { createConcurrencyTracker } from "./orchestrator/concurrencyTracker.js";
import { TaskLifecycleCoordinator } from "./orchestrator/taskLifecycleCoordinator.js";
import { createAdminServer } from "./admin/adminServer.js";
import { closeAdminServer } from "./admin/closeAdminServer.js";
import { startAdminServer } from "./admin/startAdminServer.js";
import { buildAdminProviderSummaries } from "./admin/providerSummary.js";
import { buildRuntimeDependencies, buildOrchestratorConfig, configureAgentAdapter } from "./bootstrap/runtimeBuilder.js";
import { buildReviewBundle, buildReviewTrigger } from "./review/reviewBootstrap.js";
import { PluginIntegrationStreamEventsManager } from "./connectors/integrationStreamEvents.js";
import { recoverActiveReviews } from "./review/reviewRecovery.js";
import { mkdir } from "fs/promises";
import type { Server } from "node:http";
import type { Integration, ProjectId, ProjectPushTargetRecord, ProjectRecord, ProjectReviewConfig, ProjectTicketSourceRecord, Task } from "./interfaces.js";
import { makeTaskId } from "./interfaces.js";
import { registerBuiltinPlugins } from "./plugins/init.js";
import { PluginManager } from "./plugins/pluginManager.js";

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
  const openShellGateway = resolveOpenShellGateway(process.env);

  log.info({ nodeEnv: config.nodeEnv }, "Virtual Engineer starting");

  // Ensure required directories exist
  await mkdir(config.workspaceBaseDir, { recursive: true });

  // ─── State Store ────────────────────────────────────────────────────────────
  const stateStore = await SqliteStateStore.create(config.databasePath);

  // A previous crash or forced restart can leave a task stuck in an "actively
  // executing" state (AGENT_RUNNING / REVIEW_RUNNING / REVIEW_COMMENTING) even
  // though its Docker workspace is long gone (workspaces never survive a
  // restart). Left alone, the in-flight guards in orchestrator/reviewOrchestrator
  // treat that state as still-running forever. Fail them at boot so normal
  // retry/re-trigger logic picks them back up.
  const orphanedTaskCount = await stateStore.reconcileOrphanedActiveTasks();
  if (orphanedTaskCount > 0) {
    log.warn({ orphanedTaskCount }, "failed tasks orphaned by a previous orchestrator restart");
  }

  // ─── Editable workflow settings ───────────────────────────────────────────────
  // Env/config values are the fallback defaults; persisted overrides (edited from
  // the admin UI and stored in `app_settings`) take precedence and are applied here
  // so the running polling loop / orchestrator honour them from boot.
  const settingsDefaults = {
    pollingIntervalMs: config.pollingIntervalMs,
    maxAgentCycles: config.maxAgentCycles,
    maxRetryAttempts: config.maxRetryAttempts,
    agentTimeoutMs: config.agentTimeoutMs,
    ticketCloseMaxRetries: config.ticketCloseMaxRetries,
    ticketCloseRetryMinTimeoutMs: config.ticketCloseRetryMinTimeoutMs,
  };
  const persistedSettings = await stateStore.getAppSettings();
  config.pollingIntervalMs = persistedSettings.pollingIntervalMs ?? settingsDefaults.pollingIntervalMs;
  config.maxAgentCycles = persistedSettings.maxAgentCycles ?? settingsDefaults.maxAgentCycles;
  config.maxRetryAttempts = persistedSettings.maxRetryAttempts ?? settingsDefaults.maxRetryAttempts;
  config.agentTimeoutMs = persistedSettings.agentTimeoutMs ?? settingsDefaults.agentTimeoutMs;
  config.ticketCloseMaxRetries = persistedSettings.ticketCloseMaxRetries ?? settingsDefaults.ticketCloseMaxRetries;
  config.ticketCloseRetryMinTimeoutMs = persistedSettings.ticketCloseRetryMinTimeoutMs ?? settingsDefaults.ticketCloseRetryMinTimeoutMs;

  registerBuiltinPlugins(config.adminAuthSecret !== undefined ? { adminAuthSecret: config.adminAuthSecret } : undefined);
  // Agent adapters are self-describing: any provider whose descriptor declares
  // an `agent_execution.buildAdapter` hook is instantiated by the plugin
  // manager using this host runtime context. Adding a new agent backend
  // (Copilot, Claude, …) needs no wiring here — only a descriptor.
  const pluginManager = new PluginManager(stateStore, {
    ...(config.adminAuthSecret !== undefined ? { adminAuthSecret: config.adminAuthSecret } : {}),
    agentAdapterContext: {
      maxCommitsPerCycle: config.maxCommitsPerCycle,
    },
  });

  await pluginManager.migrateEncryptCredentials();
  await pluginManager.loadFromDatabase();

  let runtimeDependencies = buildRuntimeDependencies(pluginManager);

  // ─── Workspace runner (OpenShell — the sole agent runtime) ────────────────────
  // Agents run in OpenShell sandboxes. Git plumbing (clone/checkout/cherry-pick/
  // push) stays host-side via HostGitExecutor so push credentials never enter the
  // sandbox. The runner's agent adapter is hot-swapped on integration reload by
  // mutating `openShellRunnerDeps.agentAdapter` (see refreshRuntimeDependencies).
  const openShellClient = new OpenShellClient({
    // Prefer the named OPENSHELL_GATEWAY profile so the CLI can load its OIDC
    // metadata and bearer token. OPENSHELL_GATEWAY_ENDPOINT remains a fallback
    // for legacy direct-endpoint deployments.
    gateway: openShellGateway,
    oidcClientCredentials: process.env["OPENSHELL_OIDC_CLIENT_SECRET"] !== undefined,
    commandTimeoutMs: config.agentTimeoutMs + 30_000,
  });
  const openShellRunnerDeps: OpenShellRunnerDeps = {
    git: new HostGitExecutor({ baseDir: config.workspaceBaseDir }),
    client: openShellClient,
    agentAdapter: runtimeDependencies.agentAdapter,
    resolvePolicy: createRuntimePolicyResolver(stateStore),
    recordDenial: async (denial) => {
      await stateStore.recordPolicyDenial(denial);
    },
    managedProviderStore: stateStore,
    execTimeoutSec: Math.ceil(config.agentTimeoutMs / 1000),
  };
  const workspaceRunner = new OpenShellWorkspaceRunner(openShellRunnerDeps);
  configureAgentAdapter(runtimeDependencies.agentAdapter, stateStore, workspaceRunner);

  // ─── Orchestrator ────────────────────────────────────────────────────────────
  // Phase 6 — single in-process concurrency tracker shared by orchestrator and
  // polling loop. Counters live in memory and reset on process restart.
  const concurrencyTracker = createConcurrencyTracker({
    agentStore: { getAgentById: (id) => stateStore.getAgentById(id) },
  });
  const taskLifecycleCoordinator = new TaskLifecycleCoordinator();
  const projectModeBase = {
    projectStore: stateStore,
    pluginManager,
    concurrencyTracker,
  } satisfies import("./orchestrator/orchestrator.js").ProjectModeDeps
    & NonNullable<Parameters<PollingLoop["setProjectMode"]>[0]>;
  const orchestratorProjectMode: import("./orchestrator/orchestrator.js").ProjectModeDeps = projectModeBase;
  const pollingProjectMode: NonNullable<Parameters<PollingLoop["setProjectMode"]>[0]> = projectModeBase;
  const orchestrator = new Orchestrator(
    await buildOrchestratorConfig(config, pluginManager),
    stateStore,
    workspaceRunner,
    undefined,
    stateStore,
    orchestratorProjectMode,
    taskLifecycleCoordinator,
  );

  // ─── Polling loop ────────────────────────────────────────────────────────────
  // Mutable holder so the review trigger survives hot-reload of the review
  // integration without recreating the stream-events manager.
  const reviewTriggerHolder = {
    current: buildReviewTrigger(
      pluginManager,
      config.workspaceBaseDir,
      workspaceRunner,
      stateStore,
      concurrencyTracker,
      taskLifecycleCoordinator,
    ),
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
    agentTimeoutMs: config.agentTimeoutMs,
    ticketCloseMaxRetries: config.ticketCloseMaxRetries,
    ticketCloseRetryMinTimeoutMs: config.ticketCloseRetryMinTimeoutMs,
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
    // Hot-swap the runner's agent adapter by mutating the shared deps object.
    openShellRunnerDeps.agentAdapter = runtimeDependencies.agentAdapter;
    configureAgentAdapter(runtimeDependencies.agentAdapter, stateStore, workspaceRunner);
    orchestrator.updateRuntime({
      config: await buildOrchestratorConfig(config, pluginManager),
    });
    pollingLoop.resetBackoff();
    reviewTriggerHolder.current = buildReviewTrigger(
      pluginManager,
      config.workspaceBaseDir,
      workspaceRunner,
      stateStore,
      concurrencyTracker,
      taskLifecycleCoordinator,
    );
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
      agentTimeoutMs: config.agentTimeoutMs,
      ticketCloseMaxRetries: config.ticketCloseMaxRetries,
      ticketCloseRetryMinTimeoutMs: config.ticketCloseRetryMinTimeoutMs,
    }),
    update: async (
      patch: import("./admin/adminSettingsRoutes.js").WorkflowSettingsPatch
    ): Promise<import("./admin/adminSettingsRoutes.js").EffectiveWorkflowSettings> => {
      const persisted = await stateStore.updateAppSettings(patch);
      config.pollingIntervalMs = persisted.pollingIntervalMs ?? settingsDefaults.pollingIntervalMs;
      config.maxAgentCycles = persisted.maxAgentCycles ?? settingsDefaults.maxAgentCycles;
      config.maxRetryAttempts = persisted.maxRetryAttempts ?? settingsDefaults.maxRetryAttempts;
      config.agentTimeoutMs = persisted.agentTimeoutMs ?? settingsDefaults.agentTimeoutMs;
      config.ticketCloseMaxRetries = persisted.ticketCloseMaxRetries ?? settingsDefaults.ticketCloseMaxRetries;
      config.ticketCloseRetryMinTimeoutMs = persisted.ticketCloseRetryMinTimeoutMs ?? settingsDefaults.ticketCloseRetryMinTimeoutMs;

      // Hot-apply to running subsystems.
      pollingLoop.updateConfig({
        ticketIntervalMs: config.pollingIntervalMs,
        maxRetryAttempts: config.maxRetryAttempts,
      });
      orchestrator.updateRuntime({ config: await buildOrchestratorConfig(config, pluginManager) });
      adminRuntimeConfig.pollingIntervalMs = config.pollingIntervalMs;
      adminRuntimeConfig.maxAgentCycles = config.maxAgentCycles;
      adminRuntimeConfig.maxRetryAttempts = config.maxRetryAttempts;
      adminRuntimeConfig.agentTimeoutMs = config.agentTimeoutMs;
      adminRuntimeConfig.ticketCloseMaxRetries = config.ticketCloseMaxRetries;
      adminRuntimeConfig.ticketCloseRetryMinTimeoutMs = config.ticketCloseRetryMinTimeoutMs;

      log.info(
        {
          pollingIntervalMs: config.pollingIntervalMs,
          maxAgentCycles: config.maxAgentCycles,
          maxRetryAttempts: config.maxRetryAttempts,
          agentTimeoutMs: config.agentTimeoutMs,
          ticketCloseMaxRetries: config.ticketCloseMaxRetries,
          ticketCloseRetryMinTimeoutMs: config.ticketCloseRetryMinTimeoutMs,
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
            const bundle = await buildReviewBundle(
              pluginManager,
              config.workspaceBaseDir,
              stateStore,
              workspaceRunner,
              concurrencyTracker,
              task,
              taskLifecycleCoordinator,
            );
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
            const bundle = await buildReviewBundle(
              pluginManager,
              config.workspaceBaseDir,
              stateStore,
              workspaceRunner,
              concurrencyTracker,
              task,
              taskLifecycleCoordinator,
            );
            if (bundle.orchestrator) {
              await bundle.orchestrator.runReview(task.taskId);
              return;
            }
          }
          await orchestrator.continueTask(taskId);
        },
        abandonTask: (taskId) => orchestrator.abandonTask(taskId),
        deleteProject: (projectId) => orchestrator.deleteProject(projectId),
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
      runtimePolicyStore: stateStore,
      denialStore: stateStore,
      runtimeGateway: {
        healthy: () => openShellClient.gatewayHealthy(),
        address: openShellGateway,
      },
    });

    await startAdminServer(adminServer, config.adminApiPort, config.adminApiHost);
    log.info({ host: config.adminApiHost, port: config.adminApiPort }, "admin API listening");
  }

  // Resume any tasks that were in-flight before a restart.
  // Must run AFTER the admin server binds successfully so a port conflict
  // does not cause a partially-resumed orchestrator state.
  const sandboxReconciler = new OpenShellSandboxReconciler({
    client: openShellClient,
    store: stateStore,
  });
  const runtimeRecovery = await startRuntimeRecovery({
    recoverReviews: async () => {
      const reviewRecovery = await recoverActiveReviews(stateStore, async (task) => {
        const bundle = await buildReviewBundle(
          pluginManager,
          config.workspaceBaseDir,
          stateStore,
          workspaceRunner,
          concurrencyTracker,
          task,
          taskLifecycleCoordinator,
        );
        return bundle.orchestrator;
      });
      log.info(reviewRecovery, "active review recovery completed");
    },
    resumeCodeGeneration: () => orchestrator.resumeActiveTasks(),
    reconcileSandboxes: async () => {
      const result = await sandboxReconciler.run();
      log.info(result, "initial sandbox reconciliation completed");
    },
    startSandboxReconciler: () => sandboxReconciler.start(),
    stopSandboxReconciler: () => sandboxReconciler.stop(),
    onInitialReconcileError: (err) => log.warn({ err }, "initial sandbox reconciliation failed"),
    checkGatewayHealth: () => openShellClient.gatewayHealthy(),
  });

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
    runtimeRecovery.stop();

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

interface StreamStatusChecker {
  getStatus(integrationId: string): { state: string } | null;
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

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error("Fatal startup error:", err);
  process.exit(1);
});
