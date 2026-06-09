/**
 * Unified detail drawers for the Configuration view.
 * One drawer per entity type: Integration, OAuthApp, Agent, Project.
 */
import { Drawer, DetailSection, DetailRow, StatusBanner } from "../../components/Drawer.tsx";
import { ProviderGlyph } from "../../components/ProviderGlyph.tsx";
import { Tag } from "../../components/Tag.tsx";
import { Icon } from "../../components/Icon.tsx";
import type { ApiIntegration, ApiOAuthApp, ApiAgent, ApiProject, ApiPrompt } from "../../types.ts";

/* ─── Shared footer ──────────────────────────────────────────────────── */

interface DrawerActionsProps {
  enabled: boolean;
  onClose: () => void;
  onToggle?: (() => void) | undefined;
  onDelete?: (() => void) | undefined;
  onEdit?: (() => void) | undefined;
}

function DrawerActions({ enabled, onClose, onToggle, onDelete, onEdit }: DrawerActionsProps) {
  return (
    <>
      <button className="btn" onClick={onClose}>Close</button>
      <span className="spacer" />
      {onDelete && (
        <button className="btn danger sm" onClick={onDelete}>
          <Icon name="trash" size={13} /> Delete
        </button>
      )}
      {onToggle && (
        <button className="btn" onClick={onToggle}>
          {enabled ? "Disable" : "Enable"}
        </button>
      )}
      {onEdit && (
        <button className="btn primary" onClick={onEdit}>
          <Icon name="edit" size={13} /> Edit
        </button>
      )}
    </>
  );
}

/* ─── 1. Integration drawer ──────────────────────────────────────────── */

interface IntegrationDrawerProps {
  item: ApiIntegration;
  onClose: () => void;
  onEdit?: () => void;
  onToggle?: () => void;
  onDelete?: () => void;
}

export function IntegrationDrawer({ item, onClose, onEdit, onToggle, onDelete }: IntegrationDrawerProps) {
  const categoryTone = item.category === "agent" ? "active" : item.category === "ticketing" ? "info" : "warn";

  const banner = item.enabled
    ? { tone: "ok" as const, icon: "check", title: "Enabled", sub: "Integration is active and routing traffic." }
    : { tone: "muted" as const, icon: "pause", title: "Disabled", sub: "Integration is not active — not routing." };

  return (
    <Drawer
      eyebrow={"Integration · " + item.category}
      title={item.name}
      glyph={<ProviderGlyph provider={item.type} size={40} />}
      onClose={onClose}
      footer={
        <DrawerActions
          enabled={item.enabled}
          onClose={onClose}
          onEdit={onEdit}
          onToggle={onToggle}
          onDelete={onDelete}
        />
      }
    >
      <StatusBanner {...banner} />

      <DetailSection label="Provider">
        <DetailRow k="Type">{item.type}</DetailRow>
        <DetailRow k="Category">
          <Tag tone={categoryTone} mono={false}>{item.category}</Tag>
        </DetailRow>
        <DetailRow k="Status">
          <Tag tone={item.enabled ? "ok" : "muted"}>
            <span
              className={item.enabled ? "live-dot" : undefined}
              style={{ width: 5, height: 5, borderRadius: "50%", background: "currentColor", flex: "none", display: "inline-block" }}
            />
            {item.enabled ? "enabled" : "disabled"}
          </Tag>
        </DetailRow>
      </DetailSection>

      <DetailSection label="Identity">
        <DetailRow k="Integration ID" mono>{item.id}</DetailRow>
        <DetailRow k="Name">{item.name}</DetailRow>
      </DetailSection>
    </Drawer>
  );
}

/* ─── 2. OAuth App drawer ────────────────────────────────────────────── */

interface OAuthDrawerProps {
  item: ApiOAuthApp;
  onClose: () => void;
}

export function OAuthDrawer({ item, onClose }: OAuthDrawerProps) {
  return (
    <Drawer
      eyebrow="OAuth app"
      title={`${item.provider} · ${item.baseUrl}`}
      glyph={
        <span
          style={{
            width: 40, height: 40, borderRadius: "8px", flex: "none",
            display: "grid", placeItems: "center",
            background: "var(--panel-2)", color: "var(--text-faint)",
            border: "1px solid var(--border-soft)",
          }}
        >
          <Icon name="link" size={18} />
        </span>
      }
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Close</button>
        </>
      }
    >
      <StatusBanner tone="ok" icon="check" title="Linked" sub="OAuth registration active." />

      <DetailSection label="Registration">
        <DetailRow k="Provider">{item.provider}</DetailRow>
        <DetailRow k="Base URL" mono>{item.baseUrl}</DetailRow>
        <DetailRow k="Client ID" mono>{item.clientId}</DetailRow>
      </DetailSection>
    </Drawer>
  );
}

/* ─── 3. Agent drawer ────────────────────────────────────────────────── */

interface AgentDrawerProps {
  item: ApiAgent;
  prompts: ApiPrompt[];
  onClose: () => void;
  onEdit?: () => void;
  onToggle?: () => void;
  onDelete?: () => void;
}

export function AgentDrawer({ item, prompts, onClose, onEdit, onToggle, onDelete }: AgentDrawerProps) {
  function promptLabel(id: string | null | undefined): string {
    if (!id) return "—";
    return prompts.find((p) => p.id === id)?.label ?? id.slice(0, 12);
  }

  const banner = item.enabled
    ? {
        tone: "active" as const,
        icon: "spark",
        title: "Enabled",
        sub: `Available to projects · max ${item.maxConcurrent ?? "∞"} concurrent`,
      }
    : { tone: "muted" as const, icon: "pause", title: "Disabled", sub: "Not assignable to projects" };

  return (
    <Drawer
      eyebrow={"Agent · " + item.type}
      title={item.name}
      glyph={
        <span
          style={{
            width: 40, height: 40, borderRadius: "8px", flex: "none",
            display: "grid", placeItems: "center",
            background: "var(--accent-soft)", color: "var(--accent-strong)",
          }}
        >
          <Icon name="spark" size={19} />
        </span>
      }
      onClose={onClose}
      footer={
        <DrawerActions
          enabled={item.enabled}
          onClose={onClose}
          onEdit={onEdit}
          onToggle={onToggle}
          onDelete={onDelete}
        />
      }
    >
      <StatusBanner {...banner} />

      <DetailSection label="Runtime">
        <DetailRow k="Type">{item.type}</DetailRow>
        <DetailRow k="Model" mono>{item.model ?? "auto"}</DetailRow>
        <DetailRow k="Max concurrent" mono>{String(item.maxConcurrent ?? "∞")}</DetailRow>
        <DetailRow k="Agent ID" mono>{item.id}</DetailRow>
      </DetailSection>

      <DetailSection label="Bound prompts">
        <DetailRow k="System">
          <Tag tone="info">{promptLabel(item.systemPromptId)}</Tag>
        </DetailRow>
        <DetailRow k="Instructions">
          <Tag tone="active">{promptLabel(item.instructionsPromptId)}</Tag>
        </DetailRow>
        {item.feedbackInstructionsPromptId && (
          <DetailRow k="Feedback">
            <Tag tone="warn">{promptLabel(item.feedbackInstructionsPromptId)}</Tag>
          </DetailRow>
        )}
      </DetailSection>
    </Drawer>
  );
}

/* ─── 4. Project drawer ──────────────────────────────────────────────── */

interface ProjectDrawerProps {
  item: ApiProject;
  agents: ApiAgent[];
  onClose: () => void;
  onEdit?: () => void;
  onToggle?: () => void;
  onDelete?: () => void;
}

export function ProjectDrawer({ item, agents, onClose, onEdit, onToggle, onDelete }: ProjectDrawerProps) {
  const agentName = agents.find((a) => a.id === item.agentId)?.name ?? item.agentId ?? "—";

  const banner = item.enabled
    ? {
        tone: item.type === "review" ? ("warn" as const) : ("active" as const),
        icon: "pulse",
        title: "Active",
        sub: "Polling ticket source · processing tasks",
      }
    : { tone: "muted" as const, icon: "pause", title: "Paused", sub: "Not polling — execution paused" };

  return (
    <Drawer
      eyebrow={"Project · " + item.type}
      title={item.name}
      glyph={
        <span
          style={{
            width: 40, height: 40, borderRadius: "8px", flex: "none",
            display: "grid", placeItems: "center",
            background: "var(--panel-2)", color: "var(--text-faint)",
            border: "1px solid var(--border-soft)",
          }}
        >
          <Icon name="box" size={18} />
        </span>
      }
      onClose={onClose}
      footer={
        <DrawerActions
          enabled={item.enabled}
          onClose={onClose}
          onEdit={onEdit}
          onToggle={onToggle}
          onDelete={onDelete}
        />
      }
    >
      <StatusBanner {...banner} />

      <DetailSection label="Binding">
        <DetailRow k="Kind">
          <Tag tone={item.type === "review" ? "warn" : "active"} mono={false}>{item.type}</Tag>
        </DetailRow>
        <DetailRow k="Agent">{agentName}</DetailRow>
        <DetailRow k="Project ID" mono>{item.id}</DetailRow>
        <DetailRow k="Created">{new Date(item.createdAt).toLocaleDateString()}</DetailRow>
      </DetailSection>
    </Drawer>
  );
}
