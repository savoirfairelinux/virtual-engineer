import { useEffect, useState, useCallback, useMemo, Component, type ReactNode, type ErrorInfo } from "react";
import { TopBar } from "./shell/TopBar.tsx";
import { AuthScreen } from "./shell/AuthScreen.tsx";
import { ChangePasswordModal } from "./shell/ChangePasswordModal.tsx";
import { TasksView } from "./views/TasksView/index.tsx";
import { OverviewView } from "./views/OverviewView.tsx";
import { ConfigView } from "./views/ConfigView/index.tsx";
import { api, connectSse, getStoredToken, clearStoredToken, getMe, logout, onUnauthorized, ApiError } from "./api.ts";
import { CurrentUserProvider, makeCan, type CurrentUserValue } from "./authContext.tsx";
import { isActiveState } from "./states.ts";
import type {
  ApiTask, ApiIntegration, ApiPlugin, ApiAgent, ApiProject,
  ApiPrompt, ApiOAuthApp, ApiStatus, ApiConfig, ApiProvider, ApiOverview,
  ApiMe, VeAdminBootstrap,
} from "./types.ts";
import "./theme/global.css";

type ViewId = "overview" | "tasks" | "config";

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
  const [view, setView] = useState<ViewId>(() => {
    const hash = window.location.hash;
    if (hash.startsWith("#config")) return "config";
    if (hash === "#overview") return "overview";
    return "tasks";
  });

  useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash;
      setView(hash.startsWith("#config") ? "config" : hash === "#overview" ? "overview" : "tasks");
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const [authenticated, setAuthenticated] = useState(() => !bootstrap.requiresAuth || !!getStoredToken());
  const [currentUser, setCurrentUser] = useState<ApiMe | null>(null);
  const [showChangePassword, setShowChangePassword] = useState(false);

  const handleLoggedOut = useCallback(() => {
    clearStoredToken();
    setCurrentUser(null);
    setShowChangePassword(false);
    setAuthenticated(false);
  }, []);

  // Central 401 handling — any expired/revoked session drops back to the login screen.
  useEffect(() => {
    onUnauthorized(handleLoggedOut);
    return () => onUnauthorized(null);
  }, [handleLoggedOut]);

  // Load the authenticated identity for role-aware UI gating.
  useEffect(() => {
    if (!authenticated) return;
    if (currentUser) return;
    void getMe().then(setCurrentUser).catch((err: unknown) => {
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

  // Viewers may only read overview + tasks; the config area and its data
  // (integrations, agents, projects, prompts, oauth apps, providers) require
  // operator+. Until the identity resolves, treat the user as a viewer so we
  // never fire a config request the server would 403.
  const canOperate = currentUserValue.canOperate;

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

  const loadAll = useCallback(async () => {
    // Viewer-safe reads — always fetched.
    const baseResults = await Promise.allSettled([
      api.get<{ tasks:    ApiTask[] }>("/api/admin/tasks"),
      api.get<ApiStatus>("/api/admin/status"),
      api.get<ApiConfig>("/api/admin/config"),
      api.get<ApiOverview>("/api/admin/overview").catch(() => null),
    ]);
    if (baseResults[0].status === "fulfilled") setTasks(baseResults[0].value.tasks);
    if (baseResults[1].status === "fulfilled") setStatus(baseResults[1].value);
    if (baseResults[2].status === "fulfilled") setConfig(baseResults[2].value.config);
    if (baseResults[3].status === "fulfilled" && baseResults[3].value) setOverview(baseResults[3].value);

    // Operator+ config-area reads — skipped for viewers (would 403).
    if (!canOperate) return;
    const results = await Promise.allSettled([
      api.get<{ providers: ApiProvider[] }>("/api/admin/providers"),
      api.get<{ integrations: ApiIntegration[] }>("/api/admin/integrations"),
      api.get<{ plugins: ApiPlugin[] }>("/api/admin/plugins"),
      api.get<{ agents: ApiAgent[] }>("/api/admin/agents"),
      api.get<{ projects: ApiProject[] }>("/api/admin/projects"),
      api.get<{ prompts: ApiPrompt[] }>("/api/admin/prompts"),
      api.get<{ apps: ApiOAuthApp[] }>("/api/admin/oauth-apps"),
    ]);

    if (results[0].status === "fulfilled") setProviders(results[0].value.providers);
    if (results[1].status === "fulfilled") setIntegrations(results[1].value.integrations);
    if (results[2].status === "fulfilled") setPlugins(results[2].value.plugins);
    if (results[3].status === "fulfilled") setAgents(results[3].value.agents);
    if (results[4].status === "fulfilled") setProjects(results[4].value.projects);
    if (results[5].status === "fulfilled") setPrompts(results[5].value.prompts);
    if (results[6].status === "fulfilled") setOauthApps(results[6].value.apps);
  }, [canOperate]);

  useEffect(() => {
    if (!authenticated) return;
    void loadAll();
  }, [authenticated, loadAll]);

  // SSE global event stream
  useEffect(() => {
    if (!authenticated) return;
    const stop = connectSse("/api/admin/events/stream", (evType, data) => {
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
    const id = setInterval(() => {
      void api.get<{ tasks: ApiTask[] }>("/api/admin/tasks")
        .then((r) => setTasks(r.tasks))
        .catch(() => { /* ignore — SSE or next poll will recover */ });
    }, 5_000);
    return () => clearInterval(id);
  }, [authenticated]);

  if (!authenticated) {
    return (
      <div className="app">
        <AuthScreen
          onAuthenticated={(user) => { setCurrentUser(user); setAuthenticated(true); }}
        />
      </div>
    );
  }

  const activeTasks   = tasks.filter((t) => isActiveState(t.state)).length;
  const enabledIntegrations = integrations.filter((i) => i.enabled).length;

  // Viewers have no Config view — fall back to Overview if they deep-link to it.
  const configDenied = currentUser !== null && !canOperate;
  const effectiveView: ViewId = configDenied && view === "config" ? "overview" : view;

  function handleNavigate(v: "tasks" | "config") {
    setView(v);
    window.location.hash = v;
  }

  return (
    <CurrentUserProvider value={currentUserValue}>
      <div className="app">
        <TopBar
          view={effectiveView}
          setView={(v) => { setView(v); window.location.hash = v; }}
          theme={theme}
          toggleTheme={toggleTheme}
          user={currentUser}
          canOperate={canOperate}
          onChangePassword={() => setShowChangePassword(true)}
          onLogout={() => { void logout().finally(handleLoggedOut); }}
          taskCount={tasks.length}
          activeCount={activeTasks}
          providerCount={enabledIntegrations}
          pollingRunning={status?.polling.running ?? false}
        />
        <div style={{ flex: 1, overflow: "hidden", display: "flex" }}>
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
