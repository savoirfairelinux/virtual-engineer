import { useState } from "react";
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

/* ─── Nav items ────────────────────────────────────────────────────────── */
const CONFIG_NAV = [
  { id: "overview",      label: "Overview",         sub: "Summary",           icon: "grid" },
  { id: "integrations",  label: "Integrations",     sub: "Providers",         icon: "server" },
  { id: "oauth",         label: "OAuth Apps",       sub: "Provider registry", icon: "link" },
  { id: "agents",        label: "Agents Library",   sub: "Reusable agents",   icon: "spark" },
  { id: "projects",      label: "Projects",         sub: "Execution units",   icon: "box" },
  { id: "prompts",       label: "Prompts",          sub: "System & custom",   icon: "edit" },
  { id: "system",        label: "System Settings",  sub: "Read-only",         icon: "config" },
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
  const [sec, setSec] = useState<SectionId>("integrations");

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
          {CONFIG_NAV.map((n) => {
            const active = sec === n.id;
            return (
              <button
                key={n.id}
                onClick={() => setSec(n.id)}
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
          key={sec}
          className="fade-up"
          style={{ maxWidth: "920px", margin: "0 auto", padding: "26px 28px 40px" }}
        >
          {sec === "overview"     && <ConfigOverview {...props} />}
          {sec === "integrations" && <IntegrationsSection {...props} />}
          {sec === "oauth"        && <OAuthSection {...props} />}
          {sec === "agents"       && <AgentsSection {...props} />}
          {sec === "projects"     && <ProjectsSection {...props} />}
          {sec === "prompts"      && <PromptsSection {...props} />}
          {sec === "system"       && <SystemSection config={props.config} status={props.status} />}
        </div>
      </div>
    </div>
  );
}
