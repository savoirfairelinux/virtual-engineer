import { useEffect, useState } from "react";
import { Icon } from "../../components/Icon.tsx";
import type { ApiIntegration, ApiAgent, ApiProject, ApiPrompt, ApiOAuthApp, ApiConfig, ApiPlugin, ApiStatus } from "../../types.ts";

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
import { useCurrentUser }       from "../../authContext.tsx";

/* ─── Nav items ────────────────────────────────────────────────────────── */
const CONFIG_NAV = [
  { id: "overview",      label: "Overview",         sub: "Summary",           icon: "grid",   adminOnly: false },
  { id: "integrations",  label: "Integrations",     sub: "Providers",         icon: "server", adminOnly: false },
  { id: "oauth",         label: "OAuth Apps",       sub: "Provider registry", icon: "link",   adminOnly: false },
  { id: "agents",        label: "Agents Library",   sub: "Reusable agents",   icon: "spark",  adminOnly: false },
  { id: "projects",      label: "Projects",         sub: "Execution units",   icon: "box",    adminOnly: false },
  { id: "prompts",       label: "Prompts",          sub: "System & custom",   icon: "edit",   adminOnly: false },
  { id: "users",         label: "Users",            sub: "Accounts & roles",  icon: "user",   adminOnly: true },
  { id: "groups",        label: "Groups",           sub: "User collections",  icon: "layers", adminOnly: true },
  { id: "policies",      label: "Policies",         sub: "Access control",    icon: "config", adminOnly: true },
  { id: "audit",         label: "Audit",            sub: "Change history",    icon: "clock",  adminOnly: true },
  { id: "system",        label: "System Settings",  sub: "Runtime settings",  icon: "config", adminOnly: false },
] as const;

type SectionId = typeof CONFIG_NAV[number]["id"];

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
}

export function ConfigView(props: ConfigViewData) {
  const { isAdmin } = useCurrentUser();
  const visibleNav = CONFIG_NAV.filter((n) => !n.adminOnly || isAdmin);

  const [sec, setSec] = useState<SectionId>(() => {
    const part = window.location.hash.split("/")[1] ?? "";
    return (CONFIG_NAV.find((n) => n.id === part)?.id) ?? "overview";
  });

  useEffect(() => {
    const onHashChange = () => {
      const part = window.location.hash.split("/")[1] ?? "";
      const id = CONFIG_NAV.find((n) => n.id === part)?.id ?? "overview";
      setSec(id);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Non-admins cannot land on admin-only sections (deep link / role change).
  const effectiveSec: SectionId =
    !isAdmin && CONFIG_NAV.some((n) => n.id === sec && n.adminOnly) ? "overview" : sec;

  function handleSectionChange(id: SectionId) {
    setSec(id);
    window.location.hash = `config/${id}`;
  }

  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
      {/* sidebar nav */}
      <div
        style={{
          width: "248px", flex: "none",
          borderRight: "1px solid var(--border-soft)", background: "var(--rail)",
          padding: "20px 14px", overflowY: "auto",
        }}
      >
        <div className="eyebrow" style={{ padding: "0 8px", marginBottom: "4px" }}>Admin</div>
        <div style={{ padding: "0 8px 16px", fontSize: "16px", fontWeight: 600 }}>Configuration</div>
        <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
          {visibleNav.map((n) => {
            const active = effectiveSec === n.id;
            return (
              <button
                key={n.id}
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
      </div>

      {/* main content */}
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        <div
          key={effectiveSec}
          className="fade-up"
          style={{ maxWidth: "920px", margin: "0 auto", padding: "26px 28px 40px" }}
        >
          {effectiveSec === "overview"     && <ConfigOverview {...props} />}
          {effectiveSec === "integrations" && <IntegrationsSection {...props} />}
          {effectiveSec === "oauth"        && <OAuthSection {...props} />}
          {effectiveSec === "agents"       && <AgentsSection {...props} />}
          {effectiveSec === "projects"     && <ProjectsSection {...props} />}
          {effectiveSec === "prompts"      && <PromptsSection {...props} />}
          {effectiveSec === "users"        && isAdmin && <UsersSection />}
          {effectiveSec === "groups"       && isAdmin && <GroupsSection />}
          {effectiveSec === "policies"     && isAdmin && <PoliciesSection />}
          {effectiveSec === "audit"        && isAdmin && <AuditSection />}
          {effectiveSec === "system"       && <SystemSection config={props.config} status={props.status} onRefresh={props.onRefresh} />}
        </div>
      </div>
    </div>
  );
}
