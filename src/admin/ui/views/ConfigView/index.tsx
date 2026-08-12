import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../components/Icon.tsx";
import type { ApiIntegration, ApiAgent, ApiProject, ApiPrompt, ApiOAuthApp, ApiConfig, ApiPlugin, ApiStatus } from "../../types.ts";
import { ConfigPageSurface } from "./ConfigPageSurface.tsx";
import {
  formatConfigHash,
  parseConfigHash,
  type ConfigRoute,
  type ConfigSectionId,
} from "./configRouting.ts";
import { canAccessConfigRoute, canAccessConfigSection } from "./configPermissions.ts";

/* ─── Local sub-component imports ─────────────────────────────────────── */
import { ConfigOverview }       from "./ConfigOverview.tsx";
import { IntegrationsSection }  from "./IntegrationsSection.tsx";
import { AgentsSection }        from "./AgentsSection.tsx";
import { ProjectsSection }      from "./ProjectsSection.tsx";
import { PromptsSection }       from "./PromptsSection.tsx";
import { OAuthSection }         from "./OAuthSection.tsx";
import { SystemSection }        from "./SystemSection.tsx";
import { UsersSection }         from "./UsersSection.tsx";
import { GroupsSection }        from "./GroupsSection.tsx";
import { PoliciesSection }      from "./PoliciesSection.tsx";
import { AuditSection }         from "./AuditSection.tsx";
import { RuntimePoliciesSection } from "./RuntimePoliciesSection.tsx";
import { DenialsSection }       from "./DenialsSection.tsx";
import { makeHasPermission, useCurrentUser } from "../../authContext.tsx";

/* ─── Nav items ────────────────────────────────────────────────────────── */
const CONFIG_NAV = [
  { id: "overview",      label: "Overview",         sub: "Summary",           icon: "grid" },
  { id: "integrations",  label: "Integrations",     sub: "Providers",         icon: "server" },
  { id: "oauth",         label: "OAuth Apps",       sub: "Provider registry", icon: "link" },
  { id: "agents",        label: "Agents Library",   sub: "Reusable agents",   icon: "spark" },
  { id: "projects",      label: "Projects",         sub: "Execution units",   icon: "box" },
  { id: "prompts",       label: "Prompts",          sub: "System & custom",   icon: "edit" },
  { id: "runtime-policies", label: "Runtime Policies", sub: "Sandbox governance", icon: "layers" },
  { id: "denials",       label: "Policy Denials",   sub: "Audit log",         icon: "alert" },
  { id: "users",         label: "Users",            sub: "Accounts & roles",  icon: "user" },
  { id: "groups",        label: "Groups",           sub: "User collections",  icon: "layers" },
  { id: "policies",      label: "Policies",         sub: "Access control",    icon: "config" },
  { id: "audit",         label: "Audit",            sub: "Change history",    icon: "clock" },
  { id: "system",        label: "System Settings",  sub: "Runtime settings",  icon: "config" },
] as const;

type ConfigNavItem = typeof CONFIG_NAV[number];

const CONFIG_GROUPS: ReadonlyArray<{
  id: string;
  label: string;
  sections: readonly ConfigSectionId[];
}> = [
  {
    id: "workflow",
    label: "Workflow & automation",
    sections: ["overview", "projects", "prompts"],
  },
  {
    id: "integrations",
    label: "Integrations & agents",
    sections: ["integrations", "oauth", "agents"],
  },
  {
    id: "governance",
    label: "Execution governance",
    sections: ["runtime-policies", "denials", "system"],
  },
  {
    id: "access",
    label: "Access & accountability",
    sections: ["users", "groups", "policies", "audit"],
  },
];

export interface ConfigViewData {
  integrations: ApiIntegration[];
  plugins: ApiPlugin[];
  agents: ApiAgent[];
  projects: ApiProject[];
  prompts: ApiPrompt[];
  oauthApps: ApiOAuthApp[];
  config: ApiConfig["config"] | null;
  status: ApiStatus | null;
  onRefresh: () => void;
  onNavigationGuardChange?: ((guard: (() => boolean) | null) => void) | undefined;
}

export interface ConfigSectionRouting {
  route: ConfigRoute;
  navigate: (route: ConfigRoute) => void;
  markClean: () => void;
  setDirty: (dirty: boolean) => void;
}

export type ConfigSectionProps = ConfigViewData & ConfigSectionRouting;

export function ConfigView(props: ConfigViewData) {
  const { onNavigationGuardChange } = props;
  const { can, user } = useCurrentUser();
  const hasPermission = useMemo(() => makeHasPermission(user), [user]);
  const visibleNav = CONFIG_NAV.filter((item) => canAccessConfigSection(hasPermission, item.id));
  const visibleNavById = useMemo(
    () => new Map(visibleNav.map((item) => [item.id, item] as const)),
    [visibleNav],
  );
  const visibleGroups = useMemo(() => CONFIG_GROUPS.map((group) => ({
    ...group,
    items: group.sections.flatMap((section) => {
      const item: ConfigNavItem | undefined = visibleNavById.get(section);
      return item ? [item] : [];
    }),
  })).filter((group) => group.items.length > 0), [visibleNavById]);

  const [route, setRoute] = useState<ConfigRoute>(() => parseConfigHash(window.location.hash));
  const [isDirty, setIsDirty] = useState(false);
  const routeRef = useRef(route);
  const dirtyRef = useRef(isDirty);
  const historyIndexRef = useRef(0);
  const restoringHistoryRef = useRef(false);

  const commitRoute = useCallback((nextRoute: ConfigRoute) => {
    routeRef.current = nextRoute;
    dirtyRef.current = false;
    setIsDirty(false);
    setRoute(nextRoute);
  }, []);

  const confirmDiscard = useCallback((restoreUrl = true): boolean => {
    if (!dirtyRef.current) return true;
    if (!window.confirm("Discard unsaved changes?")) {
      if (restoreUrl) {
        window.history.replaceState(
          { ...window.history.state, veConfigIndex: historyIndexRef.current },
          "",
          formatConfigHash(routeRef.current),
        );
      }
      return false;
    }
    dirtyRef.current = false;
    setIsDirty(false);
    return true;
  }, []);

  useEffect(() => {
    const existingIndex = typeof window.history.state?.veConfigIndex === "number"
      ? window.history.state.veConfigIndex as number
      : 0;
    historyIndexRef.current = existingIndex;
    window.history.replaceState({ ...window.history.state, veConfigIndex: existingIndex }, "", window.location.href);

    const onPopState = (event: PopStateEvent) => {
      if (restoringHistoryRef.current) {
        restoringHistoryRef.current = false;
        return;
      }
      const nextRoute = parseConfigHash(window.location.hash);
      const nextIndex = typeof event.state?.veConfigIndex === "number"
        ? event.state.veConfigIndex as number
        : historyIndexRef.current - 1;
      if (!confirmDiscard(false)) {
        const delta = historyIndexRef.current - nextIndex;
        if (delta === 0) {
          window.history.replaceState(
            { ...window.history.state, veConfigIndex: historyIndexRef.current },
            "",
            formatConfigHash(routeRef.current),
          );
        } else {
          restoringHistoryRef.current = true;
          window.history.go(delta);
        }
        return;
      }
      historyIndexRef.current = nextIndex;
      commitRoute(nextRoute);
    };

    const onHashChange = () => {
      if (restoringHistoryRef.current || !window.location.hash.startsWith("#config")) return;
      const nextRoute = parseConfigHash(window.location.hash);
      if (formatConfigHash(nextRoute) === formatConfigHash(routeRef.current)) return;
      if (!confirmDiscard()) return;
      historyIndexRef.current += 1;
      window.history.replaceState(
        { ...window.history.state, veConfigIndex: historyIndexRef.current },
        "",
        window.location.href,
      );
      commitRoute(nextRoute);
    };

    window.addEventListener("popstate", onPopState);
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("hashchange", onHashChange);
    };
  }, [commitRoute, confirmDiscard]);

  useEffect(() => {
    onNavigationGuardChange?.(confirmDiscard);
    return () => onNavigationGuardChange?.(null);
  }, [confirmDiscard, onNavigationGuardChange]);

  useEffect(() => {
    if (!isDirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDirty]);

  useEffect(() => {
    routeRef.current = route;
  }, [route]);

  useEffect(() => {
    dirtyRef.current = isDirty;
  }, [isDirty]);

  const effectiveRoute = useMemo<ConfigRoute>(() => {
    if (canAccessConfigRoute(can, hasPermission, route)) return route;
    return { section: visibleNav[0]?.id ?? "overview", mode: "list" };
  }, [can, hasPermission, route, visibleNav]);

  const effectiveSec = effectiveRoute.section;

  const navigate = useCallback((nextRoute: ConfigRoute) => {
    if (!confirmDiscard()) return;
    commitRoute(nextRoute);
    const nextHash = formatConfigHash(nextRoute);
    if (window.location.hash !== nextHash) {
      historyIndexRef.current += 1;
      window.history.pushState(
        { ...window.history.state, veConfigIndex: historyIndexRef.current },
        "",
        nextHash,
      );
    }
  }, [commitRoute, confirmDiscard]);

  const markClean = useCallback(() => {
    dirtyRef.current = false;
    setIsDirty(false);
  }, []);

  const setDirty = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
    setIsDirty(dirty);
  }, []);

  function handleSectionChange(id: ConfigSectionId) {
    navigate({ section: id, mode: "list" });
  }

  const routedProps: ConfigSectionProps = {
    ...props,
    route: effectiveRoute,
    navigate,
    markClean,
    setDirty,
  };

  useEffect(() => {
    const heading = document.querySelector<HTMLElement>(".config-main h1");
    if (!heading) return;
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }, [effectiveRoute]);

  const content = (
    <>
      {effectiveSec === "overview"     && <ConfigOverview {...props} />}
      {effectiveSec === "integrations" && <IntegrationsSection {...routedProps} />}
      {effectiveSec === "oauth"        && <OAuthSection {...routedProps} />}
      {effectiveSec === "agents"       && <AgentsSection {...routedProps} />}
      {effectiveSec === "projects"     && <ProjectsSection {...routedProps} />}
      {effectiveSec === "prompts"      && <PromptsSection {...routedProps} />}
      {effectiveSec === "runtime-policies" && <RuntimePoliciesSection />}
      {effectiveSec === "denials"      && <DenialsSection />}
      {effectiveSec === "users"        && <UsersSection {...routedProps} />}
      {effectiveSec === "groups"       && <GroupsSection {...routedProps} />}
      {effectiveSec === "policies"     && <PoliciesSection {...routedProps} />}
      {effectiveSec === "audit"        && <AuditSection />}
      {effectiveSec === "system"       && <SystemSection config={props.config} status={props.status} onRefresh={props.onRefresh} onDirtyChange={routedProps.setDirty} />}
    </>
  );

  return (
    <div className="config-view">
      {/* sidebar nav */}
      <aside className="config-nav" aria-label="Configuration sections">
        <div className="eyebrow" style={{ padding: "0 8px", marginBottom: "4px" }}>Admin</div>
        <div style={{ padding: "0 8px 16px", fontSize: "16px", fontWeight: 600 }}>Configuration</div>
        <div className="config-nav-groups">
          {visibleGroups.map((group) => (
            <section className="config-nav-group" key={group.id} aria-labelledby={`config-nav-group-${group.id}`}>
              <h2 className="config-nav-group-title" id={`config-nav-group-${group.id}`}>{group.label}</h2>
              <div className="config-nav-items">
                {group.items.map((n) => {
                  const active = effectiveSec === n.id;
                  return (
                    <button
                      key={n.id}
                      aria-current={active ? "page" : undefined}
                      onClick={() => handleSectionChange(n.id)}
                      style={{
                        display: "flex", alignItems: "center", gap: "11px", padding: "9px 10px",
                        borderRadius: "var(--radius-sm)",
                        border: `1px solid ${active ? "var(--border-soft)" : "transparent"}`,
                        background: active ? "var(--panel-2)" : "transparent",
                        cursor: "pointer", textAlign: "left", width: "100%", color: "inherit",
                        transition: "background 0.12s var(--ease)",
                      }}
                      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "color-mix(in oklab,var(--panel-2) 55%, transparent)"; }}
                      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
                    >
                      <Icon name={n.icon} size={16} style={{ color: active ? "var(--accent-strong)" : "var(--text-faint)" }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: "13px", fontWeight: active ? 600 : 500, color: active ? "var(--text)" : "var(--text-dim)" }}>
                          {n.label}
                        </div>
                        <div style={{ fontSize: "10.5px", color: "var(--text-ghost)" }}>{n.sub}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </aside>

      {/* main content */}
      <main className="config-main">
        <div
          key={`${effectiveSec}:${effectiveRoute.mode}`}
          className="config-content fade-up"
          onChangeCapture={(event) => {
            if (event.target instanceof Element && event.target.closest("[data-config-ignore-dirty]")) return;
            if (effectiveRoute.mode === "create" || effectiveRoute.mode === "edit" || effectiveRoute.mode === "password") setDirty(true);
          }}
          onInputCapture={(event) => {
            if (event.target instanceof Element && event.target.closest("[data-config-ignore-dirty]")) return;
            if (effectiveRoute.mode === "create" || effectiveRoute.mode === "edit" || effectiveRoute.mode === "password") setDirty(true);
          }}
          onClickCapture={(event) => {
            if (effectiveRoute.mode !== "create" && effectiveRoute.mode !== "edit" && effectiveRoute.mode !== "password") return;
            const target = event.target;
            if (target instanceof Element && target.closest("[data-config-dirty]")) setDirty(true);
          }}
        >
          {effectiveRoute.mode === "list" ? content : <ConfigPageSurface>{content}</ConfigPageSurface>}
        </div>
      </main>
    </div>
  );
}
