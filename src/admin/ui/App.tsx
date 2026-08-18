import { useEffect, useState, useCallback, useMemo, useRef, Component, type ReactNode, type ErrorInfo } from "react";
import { TopBar } from "./shell/TopBar.tsx";
import { AuthScreen } from "./shell/AuthScreen.tsx";
import { ChangePasswordModal } from "./shell/ChangePasswordModal.tsx";
import { TasksView } from "./views/TasksView/index.tsx";
import { OverviewView } from "./views/OverviewView.tsx";
import { ConfigView } from "./views/ConfigView/index.tsx";
import { canViewConfiguration } from "./views/ConfigView/configPermissions.ts";
import { parseConfigHash, type ConfigSectionId } from "./views/ConfigView/configRouting.ts";
import { api, connectSse, getStoredToken, clearStoredToken, getMe, logout, onUnauthorized, fetchSetupStatus, ApiError } from "./api.ts";
import { CurrentUserProvider, makeCan, makeHasPermission, type CurrentUserValue } from "./authContext.tsx";
import { isActiveState } from "./states.ts";
import { applyIfCurrentGeneration } from "./useIdentityReset.ts";
import { GuidedTour } from "./tour/GuidedTour.tsx";
import {
  CONFIG_SECTION_TOURS,
  CONFIG_WORKFLOW_TOUR,
  MAIN_NAV_TOUR,
  contextualTutorialKey,
  selectTutorial,
  type TutorialKey,
} from "./tour/tourSteps.ts";
import type {
  ApiTask, ApiIntegration, ApiPlugin, ApiAgent, ApiProject,
  ApiPrompt, ApiOAuthApp, ApiStatus, ApiConfig, ApiProvider, ApiOverview,
  ApiMe, VeAdminBootstrap,
} from "./types.ts";
import "./theme/global.css";

type ViewId = "overview" | "tasks" | "config";

interface TutorialLaunch {
  key: TutorialKey;
  token: number;
}

function viewFromHash(hash: string): ViewId {
  if (hash.startsWith("#config")) return "config";
  if (hash.startsWith("#tasks")) return "tasks";
  return "overview";
}

export function shouldEnableConfigWorkflow(
  configSection: ConfigSectionId,
  workflowActive: boolean,
  tutorialKey: TutorialKey | null,
): boolean {
  return configSection === "overview" || workflowActive || tutorialKey === "config-workflow";
}

const bootstrap: VeAdminBootstrap = window.__VE_ADMIN_BOOTSTRAP__ ?? {
  requiresAuth: false,
  authMode: "none",
  gerritBaseUrl: null,
  gitlabBaseUrl: null,
  ticketLinkTemplates: {},
};

function useTheme() {
  const [theme, setTheme] = useState<"dark" | "light">(
    () => (localStorage.getItem("ve-theme") as "dark" | "light" | null) ?? "dark"
  );
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("ve-theme", theme);
  }, [theme]);
  return [theme, () => setTheme((t) => (t === "dark" ? "light" : "dark"))] as const;
}

export function App() {
  const [theme, toggleTheme] = useTheme();
  const configNavigationGuardRef = useRef<(() => boolean) | null>(null);
  const [view, setView] = useState<ViewId>(() => {
    return viewFromHash(window.location.hash);
  });
  const [configSection, setConfigSection] = useState<ConfigSectionId>(
    () => parseConfigHash(window.location.hash).section,
  );
  const handleConfigSectionChange = useCallback((section: ConfigSectionId) => {
    setConfigSection((current) => current === section ? current : section);
  }, []);

  useEffect(() => {
    const onHashChange = () => {
      const nextView = viewFromHash(window.location.hash);
      if (view === "config" && nextView !== "config" && !configNavigationGuardRef.current?.()) return;
      setView(nextView);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [view]);

  const [authenticated, setAuthenticated] = useState(() => !bootstrap.requiresAuth || !!getStoredToken());
  const [currentUser, setCurrentUser] = useState<ApiMe | null>(null);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [tutorialLaunch, setTutorialLaunch] = useState<TutorialLaunch | null>(null);
  const [configWorkflowActive, setConfigWorkflowActive] = useState(false);
  const [pendingTutorialKey, setPendingTutorialKey] = useState<TutorialKey | null>(null);
  const handleConfigWorkflowActiveChange = useCallback((active: boolean) => {
    setConfigWorkflowActive((current) => current === active ? current : active);
  }, []);

  useEffect(() => {
    if (pendingTutorialKey === null || configWorkflowActive) return;
    if (view !== "config") {
      setPendingTutorialKey(null);
      return;
    }
    const currentSelection = selectTutorial("config", configSection);
    if (currentSelection.key !== pendingTutorialKey) {
      setPendingTutorialKey(null);
      return;
    }
    const key = pendingTutorialKey;
    setPendingTutorialKey(null);
    setTutorialLaunch((previous) => ({
      key,
      token: (previous?.token ?? 0) + 1,
    }));
  }, [configSection, configWorkflowActive, pendingTutorialKey, view]);
  const dataGenerationRef = useRef(0);
  // When the server bootstrap data is unavailable (Vite dev mode), requiresAuth defaults to
  // false and authenticated starts as true — skipping the setup screen. This effect catches
  // that case: if the server reports no users exist, force the setup screen regardless.
  const [forcedSetupScreen, setForcedSetupScreen] = useState(false);
  useEffect(() => {
    if (!authenticated || bootstrap.requiresAuth) return;
    fetchSetupStatus()
      .then((s) => { if (s.needsSetup) setForcedSetupScreen(true); })
      .catch(() => { /* server unreachable — stay in open mode */ });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load the authenticated identity for role-aware UI gating.
  useEffect(() => {
    if (!authenticated) return;
    if (currentUser) return;
    const generation = dataGenerationRef.current;
    void getMe().then((user) => {
      applyIfCurrentGeneration(user, generation, dataGenerationRef.current, setCurrentUser);
    }).catch((err: unknown) => {
      // 401 is already handled globally by onUnauthorized → handleLoggedOut.
      // Any other error (503, network failure, etc.) is unexpected; log it so
      // it is visible in the browser console rather than silently swallowed.
      if (err instanceof ApiError && err.status === 401) return;
      console.error("Failed to load current user", err);
    });
  }, [authenticated, currentUser]);

  const currentUserValue = useMemo<CurrentUserValue>(() => ({
    user: currentUser,
    isAdmin: currentUser?.role === "admin",
    canOperate: currentUser !== null && currentUser.role !== "viewer",
    can: makeCan(currentUser),
  }), [currentUser]);

  const canViewConfig = canViewConfiguration(makeHasPermission(currentUser));

  // data state
  const [tasks,        setTasks]        = useState<ApiTask[]>([]);
  const [providers,    setProviders]    = useState<ApiProvider[]>([]);
  const [integrations, setIntegrations] = useState<ApiIntegration[]>([]);
  const [plugins,      setPlugins]      = useState<ApiPlugin[]>([]);
  const [agents,       setAgents]       = useState<ApiAgent[]>([]);
  const [projects,     setProjects]     = useState<ApiProject[]>([]);
  const [prompts,      setPrompts]      = useState<ApiPrompt[]>([]);
  const [oauthApps,    setOauthApps]    = useState<ApiOAuthApp[]>([]);
  const [status,       setStatus]       = useState<ApiStatus | null>(null);
  const [config,       setConfig]       = useState<ApiConfig["config"] | null>(null);
  const [overview,     setOverview]     = useState<ApiOverview | null>(null);

  const resetLoadedData = useCallback(() => {
    dataGenerationRef.current += 1;
    setTasks([]);
    setProviders([]);
    setIntegrations([]);
    setPlugins([]);
    setAgents([]);
    setProjects([]);
    setPrompts([]);
    setOauthApps([]);
    setStatus(null);
    setConfig(null);
    setOverview(null);
  }, []);

  const handleLoggedOut = useCallback(() => {
    clearStoredToken();
    resetLoadedData();
    setCurrentUser(null);
    setShowChangePassword(false);
    setAuthenticated(false);
  }, [resetLoadedData]);

  // Central 401 handling — any expired/revoked session drops back to the login screen.
  useEffect(() => {
    onUnauthorized(handleLoggedOut);
    return () => onUnauthorized(null);
  }, [handleLoggedOut]);

  const loadAll = useCallback(async () => {
    const generation = dataGenerationRef.current;
    // Viewer-safe reads — always fetched.
    const baseResults = await Promise.allSettled([
      api.get<{ tasks:    ApiTask[] }>("/api/admin/tasks"),
      api.get<ApiStatus>("/api/admin/status"),
      api.get<ApiConfig>("/api/admin/config"),
      api.get<ApiOverview>("/api/admin/overview").catch(() => null),
    ]);
    if (generation !== dataGenerationRef.current) return;
    if (baseResults[0].status === "fulfilled") setTasks(baseResults[0].value.tasks);
    if (baseResults[1].status === "fulfilled") setStatus(baseResults[1].value);
    if (baseResults[2].status === "fulfilled") setConfig(baseResults[2].value.config);
    if (baseResults[3].status === "fulfilled" && baseResults[3].value) setOverview(baseResults[3].value);

    if (!canViewConfig) return;
    const results = await Promise.allSettled([
      api.get<{ providers: ApiProvider[] }>("/api/admin/providers"),
      api.get<{ integrations: ApiIntegration[] }>("/api/admin/integrations"),
      api.get<{ plugins: ApiPlugin[] }>("/api/admin/plugins"),
      api.get<{ agents: ApiAgent[] }>("/api/admin/agents"),
      api.get<{ projects: ApiProject[] }>("/api/admin/projects"),
      api.get<{ prompts: ApiPrompt[] }>("/api/admin/prompts"),
      api.get<{ apps: ApiOAuthApp[] }>("/api/admin/oauth-apps"),
    ]);

    if (generation !== dataGenerationRef.current) return;
    if (results[0].status === "fulfilled") setProviders(results[0].value.providers);
    if (results[1].status === "fulfilled") setIntegrations(results[1].value.integrations);
    if (results[2].status === "fulfilled") setPlugins(results[2].value.plugins);
    if (results[3].status === "fulfilled") setAgents(results[3].value.agents);
    if (results[4].status === "fulfilled") setProjects(results[4].value.projects);
    if (results[5].status === "fulfilled") setPrompts(results[5].value.prompts);
    if (results[6].status === "fulfilled") setOauthApps(results[6].value.apps);
  }, [canViewConfig]);

  useEffect(() => {
    if (!authenticated) return;
    void loadAll();
  }, [authenticated, loadAll]);

  // SSE global event stream
  useEffect(() => {
    if (!authenticated) return;
    const generation = dataGenerationRef.current;
    const stop = connectSse("/api/admin/events/stream", (evType, data) => {
      if (generation !== dataGenerationRef.current) return;
      try {
        const payload = JSON.parse(data) as unknown;
        if (evType === "tasks" && Array.isArray(payload)) {
          setTasks(payload as ApiTask[]);
        } else if (evType === "providers" && Array.isArray(payload)) {
          setProviders(payload as ApiProvider[]);
        }
      } catch { /* ignore */ }
    });
    return stop;
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated) return;
    const generation = dataGenerationRef.current;
    const id = setInterval(() => {
      void api.get<{ tasks: ApiTask[] }>("/api/admin/tasks")
        .then((r) => {
          if (generation === dataGenerationRef.current) setTasks(r.tasks);
        })
        .catch(() => { /* ignore — SSE or next poll will recover */ });
    }, 5_000);
    return () => clearInterval(id);
  }, [authenticated]);

  if (!authenticated || forcedSetupScreen) {
    return (
      <div className="app">
        <AuthScreen
          onAuthenticated={(user) => {
            resetLoadedData();
            setCurrentUser(user);
            setAuthenticated(true);
            setForcedSetupScreen(false);
          }}
        />
      </div>
    );
  }

  const activeTasks   = tasks.filter((t) => isActiveState(t.state)).length;
  const enabledIntegrations = integrations.filter((i) => i.enabled).length;

  const configDenied = currentUser !== null && !canViewConfig;
  const effectiveView: ViewId = configDenied && view === "config" ? "overview" : view;
  const mainNavRestartToken = tutorialLaunch?.key === "main-nav" ? tutorialLaunch.token : undefined;
  const configWorkflowRestartToken = tutorialLaunch?.key === "config-workflow" ? tutorialLaunch.token : undefined;
  const configWorkflowEnabled = currentUser !== null
    && shouldEnableConfigWorkflow(configSection, configWorkflowActive, tutorialLaunch?.key ?? null);

  function requestViewChange(nextView: ViewId): boolean {
    if (view === "config" && nextView !== "config" && !configNavigationGuardRef.current?.()) return false;
    setView(nextView);
    window.location.hash = nextView;
    return true;
  }

  function handleNavigate(v: "tasks" | "config") {
    requestViewChange(v);
  }

  function handleStartTutorial() {
    const selection = selectTutorial(effectiveView, configSection);
    if (configWorkflowActive && selection.key !== "config-workflow") {
      setPendingTutorialKey(selection.key);
      return;
    }
    setTutorialLaunch((previous) => ({
      key: selection.key,
      token: (previous?.token ?? 0) + 1,
    }));
  }

  const contextualTourKey: TutorialKey | null = configSection === "overview"
    ? null
    : contextualTutorialKey(configSection);
  const contextualTour = configSection === "overview" ? null : CONFIG_SECTION_TOURS[configSection];
  const contextualTourActive = contextualTourKey !== null && tutorialLaunch?.key === contextualTourKey;

  return (
    <CurrentUserProvider value={currentUserValue}>
      <div className="app">
        {effectiveView !== "config" && (
          <GuidedTour
            tourKey="main-nav"
            steps={MAIN_NAV_TOUR}
            enabled={currentUser !== null}
            {...(mainNavRestartToken === undefined ? {} : { restartToken: mainNavRestartToken })}
          />
        )}
        {effectiveView === "config" && !contextualTourActive && (
          <GuidedTour
            tourKey="config-workflow"
            steps={CONFIG_WORKFLOW_TOUR}
            enabled={configWorkflowEnabled}
            onActiveChange={handleConfigWorkflowActiveChange}
            {...(configWorkflowRestartToken === undefined ? {} : { restartToken: configWorkflowRestartToken })}
          />
        )}
        {effectiveView === "config" && contextualTourKey !== null && contextualTour !== null && (
          <GuidedTour
            key={contextualTourKey}
            tourKey={contextualTourKey}
            steps={contextualTour}
            enabled={currentUser !== null && tutorialLaunch?.key === contextualTourKey}
            {...(tutorialLaunch?.key === contextualTourKey ? { restartToken: tutorialLaunch.token } : {})}
          />
        )}
        <TopBar
          view={effectiveView}
          setView={(nextView) => { requestViewChange(nextView); }}
          theme={theme}
          toggleTheme={toggleTheme}
          user={currentUser}
          canViewConfig={canViewConfig}
          onChangePassword={() => setShowChangePassword(true)}
          onStartTutorial={handleStartTutorial}
          onLogout={() => {
            if (view === "config" && !configNavigationGuardRef.current?.()) return;
            const token = getStoredToken();
            handleLoggedOut();
            void logout(token);
          }}
          taskCount={tasks.length}
          activeCount={activeTasks}
          providerCount={enabledIntegrations}
          pollingRunning={status?.polling.running ?? false}
        />
        <div className="app-workspace" style={{ flex: 1, overflow: "hidden", display: "flex" }}>
          {effectiveView === "overview" && (
            <OverviewView
              overview={overview}
              tasks={tasks}
              providers={providers}
              activeIntegrationCount={enabledIntegrations}
              pollingIntervalMs={status?.polling.intervalMs ?? 30000}
              onNavigate={handleNavigate}
            />
          )}
          {effectiveView === "tasks" && (
            <TasksView tasks={tasks} onRefresh={() => void loadAll()} />
          )}
          {effectiveView === "config" && (
            <ConfigView
              integrations={integrations}
              plugins={plugins}
              agents={agents}
              projects={projects}
              prompts={prompts}
              oauthApps={oauthApps}
              config={config}
              status={status}
              onRefresh={() => void loadAll()}
              onNavigationGuardChange={(guard) => { configNavigationGuardRef.current = guard; }}
              onSectionChange={handleConfigSectionChange}
            />
          )}
        </div>
        {showChangePassword && currentUser && currentUser.id !== null && (
          <ChangePasswordModal
            user={currentUser}
            onClose={() => setShowChangePassword(false)}
            onChanged={handleLoggedOut}
          />
        )}
      </div>
    </CurrentUserProvider>
  );
}

/* ─── Top-level error boundary — prevents full white screen on render errors ─── */
interface EBState { error: Error | null }
export class AppErrorBoundary extends Component<{ children: ReactNode }, EBState> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error): EBState { return { error }; }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[VE] Render error caught by ErrorBoundary:", error, info.componentStack);
  }
  override render() {
    if (this.state.error) {
      return (
        <div style={{ padding: "40px 32px", fontFamily: "var(--font-mono)", color: "var(--danger)" }}>
          <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "12px" }}>
            Something went wrong
          </div>
          <pre style={{ fontSize: "12px", whiteSpace: "pre-wrap", opacity: 0.85, marginBottom: "16px" }}>
            {this.state.error.message}
            {"\n\n"}
            {this.state.error.stack}
          </pre>
          <button className="btn ghost" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
