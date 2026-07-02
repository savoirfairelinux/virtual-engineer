import { Icon } from "../components/Icon.tsx";
import { Tag } from "../components/Tag.tsx";
import type { ApiMe } from "../types.ts";
import logoUrl from "../icons/virtual_engineer.png";

type ViewId = "overview" | "tasks" | "config";

interface TopBarProps {
  view: ViewId;
  setView: (v: ViewId) => void;
  theme: "dark" | "light";
  toggleTheme: () => void;
  user: ApiMe | null;
  onChangePassword: () => void;
  onLogout: () => void;
  taskCount: number;
  activeCount: number;
  providerCount: number;
  pollingRunning: boolean;
}

const ROLE_TONE = { admin: "active", operator: "info", viewer: "muted" } as const;

const NAV: { id: ViewId; label: string; icon: string }[] = [
  { id: "overview", label: "Overview", icon: "grid" },
  { id: "tasks",    label: "Tasks",    icon: "tasks" },
  { id: "config",   label: "Configuration", icon: "config" },
];

export function TopBar({
  view, setView, theme, toggleTheme, user, onChangePassword, onLogout,
  taskCount, activeCount, providerCount, pollingRunning,
}: TopBarProps) {
  return (
    <header
      style={{
        display: "flex", alignItems: "stretch", height: "54px", flex: "none",
        borderBottom: "1px solid var(--border-soft)", background: "var(--rail)",
        paddingLeft: "16px", paddingRight: "14px",
      }}
    >
      {/* brand */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", paddingRight: "18px" }}>
        <img
          src={logoUrl}
          width={34}
          height={34}
          alt="Virtual Engineer"
          style={{ borderRadius: "8px", display: "block", boxShadow: "0 2px 8px var(--accent-soft)" }}
        />
        <div style={{ lineHeight: 1.05 }}>
          <div style={{ fontWeight: 600, fontSize: "14px", letterSpacing: "-0.01em" }}>Virtual Engineer</div>
          <div className="mono" style={{ fontSize: "9.5px", color: "var(--text-faint)", letterSpacing: "0.04em" }}>
            orchestrator
          </div>
        </div>
      </div>

      {/* status cluster */}
      <div
        style={{
          display: "flex", alignItems: "center", gap: "16px",
          paddingLeft: "18px", paddingRight: "18px",
          borderLeft: "1px solid var(--border-soft)",
        }}
      >
        {/* live beacon */}
        <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
          <span style={{ position: "relative", width: 9, height: 9 }}>
            <span
              className={pollingRunning ? "live-dot" : ""}
              style={{
                position: "absolute", inset: 0, borderRadius: "99px",
                background: pollingRunning ? "var(--ok)" : "var(--text-ghost)",
              }}
            />
          </span>
          <span style={{ fontWeight: 600, fontSize: "13px", color: pollingRunning ? "var(--text)" : "var(--text-dim)" }}>
            {pollingRunning ? "Live" : "Polling"}
          </span>
        </span>
        {/* counters */}
        <div style={{ display: "flex", alignItems: "center", gap: "14px", fontSize: "12.5px", color: "var(--text-faint)" }}>
          <span><b className="metric-val" style={{ color: "var(--text)", fontWeight: 600 }}>{taskCount}</b> tasks</span>
          <span><b className="metric-val" style={{ color: "var(--text)", fontWeight: 600 }}>{activeCount}</b> active</span>
          <span><b className="metric-val" style={{ color: "var(--text)", fontWeight: 600 }}>{providerCount}</b> integrations</span>
        </div>
      </div>

      {/* nav */}
      <nav style={{ display: "flex", alignItems: "center", gap: "2px", marginLeft: "24px" }}>
        {NAV.map((n) => {
          const active = view === n.id;
          return (
            <button
              key={n.id}
              onClick={() => setView(n.id)}
              style={{
                position: "relative", display: "inline-flex", alignItems: "center", gap: "8px",
                border: "none", background: "transparent", cursor: "pointer", height: "54px", padding: "0 14px",
                color: active ? "var(--text)" : "var(--text-faint)",
                fontFamily: "var(--font-sans)", fontSize: "13.5px",
                fontWeight: active ? 600 : 500, transition: "color 0.14s var(--ease)",
              }}
            >
              <Icon
                name={n.icon} size={15}
                style={{ color: active ? "var(--accent-strong)" : "inherit" }}
              />
              {n.label}
              {active && (
                <span
                  style={{
                    position: "absolute", left: "12px", right: "12px", bottom: 0,
                    height: "2px", borderRadius: "2px 2px 0 0", background: "var(--accent)",
                  }}
                />
              )}
            </button>
          );
        })}
      </nav>

      <div style={{ flex: 1 }} />

      {/* right controls */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        {user && (
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Icon name="user" size={14} style={{ color: "var(--text-faint)" }} />
            <span style={{ fontSize: "12.5px", fontWeight: 600, color: "var(--text-dim)" }}>
              {user.username}
            </span>
            <Tag tone={ROLE_TONE[user.role]} mono={false}>{user.role}</Tag>
          </div>
        )}
        <div style={{ width: "1px", height: "22px", background: "var(--border-soft)", margin: "0 3px" }} />
        <button className="iconbtn" onClick={toggleTheme} title="Toggle theme">
          <Icon name={theme === "dark" ? "sun" : "moon"} size={16} />
        </button>
        {user && user.id !== null && (
          <button className="iconbtn" title="Change password" onClick={onChangePassword}>
            <Icon name="edit" size={15} />
          </button>
        )}
        <button className="iconbtn" title="Sign out" onClick={onLogout}>
          <Icon name="logout" size={16} />
        </button>
      </div>
    </header>
  );
}
