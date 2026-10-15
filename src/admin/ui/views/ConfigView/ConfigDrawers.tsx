/**
 * Unified detail drawers for the Configuration view.
 * One drawer per entity type: Integration, OAuthApp, Agent, Project.
 */
import { Drawer, DetailSection, DetailRow, StatusBanner } from "../../components/Drawer.tsx";
import { ProviderGlyph } from "../../components/ProviderGlyph.tsx";
import { Tag } from "../../components/Tag.tsx";
import { Icon } from "../../components/Icon.tsx";
import { api } from "../../api.ts";
import type { ApiIntegration, ApiOAuthApp, ApiAgent, ApiProject, ApiProjectDetail, ApiPrompt } from "../../types.ts";

/* ─── Detail helpers ─────────────────────────────────────────────────── */

const SAAS_HOSTS: Record<string, { modeKey: string; mode: string; host: string }> = {
  github: { modeKey: "mode", mode: "github.com", host: "github.com" },
  gitlab: { modeKey: "gitlabMode", mode: "gitlab.com", host: "gitlab.com" },
};

function configText(item: ApiIntegration, key: string): string | undefined {
  const value: unknown = item.config?.[key];
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
}

/** Network endpoint (host + port) an integration connects to, or null when it has none. */
export function integrationEndpoint(item: ApiIntegration): { host: string; port: string } | null {
  const sshHost = configText(item, "sshHost");
  if (sshHost) return { host: sshHost, port: configText(item, "sshPort") ?? "29418" };

  const baseUrl = configText(item, "baseUrl");
  if (baseUrl) {
    try {
      const url = new URL(baseUrl);
      return { host: url.hostname, port: url.port || (url.protocol === "http:" ? "80" : "443") };
    } catch {
      return null;
    }
  }

  const saas = SAAS_HOSTS[item.provider];
  if (saas && (configText(item, saas.modeKey) ?? saas.mode) === saas.mode) return { host: saas.host, port: "443" };
  return null;
}

/** Reasoning effort configured in the agent provider options, or null for the provider default. */
export function agentReasoningEffort(item: ApiAgent): string | null {
  const options = item.modelConfig?.["providerOptions"];
  if (typeof options !== "object" || options === null) return null;
  const effort = (options as Record<string, unknown>)["reasoningEffort"];
  return typeof effort === "string" && effort.length > 0 ? effort : null;
}

function yesNo(value: boolean | undefined): string | undefined {
  return value === undefined ? undefined : value ? "yes" : "no";
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function linkedIntegrationLabel(integration: { name: string; provider: string } | null | undefined): string | undefined {
  return integration ? `${integration.name} · ${integration.provider}` : undefined;
}

/* ─── Shared footer ──────────────────────────────────────────────────── */

interface DrawerActionsProps {
  enabled: boolean;
  onClose: () => void;
  onToggle?: (() => void) | undefined;
  onDelete?: (() => void) | undefined;
  onEdit?: (() => void) | undefined;
  onAccess?: (() => void) | undefined;
  onStatistics?: (() => void) | undefined;
}

function DrawerActions({ enabled, onClose, onToggle, onDelete, onEdit, onAccess, onStatistics }: DrawerActionsProps) {
  return (
    <>
      <button className="btn" onClick={onClose}>Close</button>
      <span className="spacer" />
            {onAccess && (
              <button className="btn" onClick={onAccess}>
                <Icon name="user" size={13} /> Access
              </button>
            )}
            {onStatistics && (
              <button className="btn" onClick={onStatistics}>
                <Icon name="bar-chart" size={13} /> Statistics
              </button>
            )}
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
  const categoryTone = item.domainCapabilities.includes("agent_execution") ? "active" : item.domainCapabilities.includes("issue_tracking") ? "info" : "warn";

  const banner = item.enabled
    ? { tone: "ok" as const, icon: "check", title: "Enabled", sub: "Integration is active and routing traffic." }
    : { tone: "muted" as const, icon: "pause", title: "Disabled", sub: "Integration is not active — not routing." };
  const endpoint = integrationEndpoint(item);
  const baseUrl = configText(item, "baseUrl");

  return (
    <Drawer
      eyebrow={"Integration · " + item.provider}
      title={item.name}
      glyph={<ProviderGlyph provider={item.provider} size={40} />}
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
        <DetailRow k="Provider">{item.provider}</DetailRow>
        <DetailRow k="Capabilities">
          {item.domainCapabilities.length > 0
            ? item.domainCapabilities.join(", ")
            : <Tag tone={categoryTone} mono={false}>{item.provider}</Tag>}
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

      {endpoint && (
        <DetailSection label="Connection">
          <DetailRow k="Host" mono>{endpoint.host}</DetailRow>
          <DetailRow k="Port" mono>{endpoint.port}</DetailRow>
          {baseUrl && <DetailRow k="Base URL" mono>{baseUrl}</DetailRow>}
        </DetailSection>
      )}

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
  onDeleted?: () => void;
}

export function OAuthDrawer({ item, onClose, onDeleted }: OAuthDrawerProps) {
  async function handleDelete() {
    if (!window.confirm(`Delete OAuth app for ${item.provider} · ${item.baseUrl}? This cannot be undone.`)) return;
    try {
      await api.delete("/api/admin/oauth-apps", { provider: item.provider, baseUrl: item.baseUrl });
      onDeleted?.();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Delete failed");
    }
  }

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
          <span className="spacer" />
          {onDeleted && (
            <button className="btn danger sm" onClick={handleDelete}>
              <Icon name="trash" size={13} /> Delete
            </button>
          )}
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
  integrations: ApiIntegration[];
  onClose: () => void;
  onEdit?: () => void;
  onToggle?: () => void;
  onDelete?: () => void;
}

export function AgentDrawer({ item, prompts, integrations, onClose, onEdit, onToggle, onDelete }: AgentDrawerProps) {
  const integration = item.integrationId ? integrations.find((i) => i.id === item.integrationId) : undefined;
  const integrationLabel = integration ? `${integration.name} · ${integration.provider}` : item.integrationId ?? "—";
  const nativeReview = item.reviewStrategy === "copilot_native";
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
        <DetailRow k="Integration">{integrationLabel}</DetailRow>
        <DetailRow k="Review strategy">
          {nativeReview ? "Copilot native (experimental)" : "VE direct"}
        </DetailRow>
        <DetailRow k="Model" mono>
          {nativeReview ? "CLI-managed models" : item.model ?? "auto"}
        </DetailRow>
        {!nativeReview && (
          <DetailRow k="Reasoning effort" mono>{agentReasoningEffort(item) ?? "default"}</DetailRow>
        )}
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
  detail?: ApiProjectDetail | null;
  agents: ApiAgent[];
  onClose: () => void;
  onEdit?: () => void;
  onToggle?: () => void;
  onDelete?: () => void;
  onAccess?: () => void;
  onStatistics?: () => void;
}

export function ProjectDrawer({ item, detail, agents, onClose, onEdit, onToggle, onDelete, onAccess, onStatistics }: ProjectDrawerProps) {
  const agentName = agents.find((a) => a.id === item.agentId)?.name ?? item.agentId ?? "—";
  const skillSources = detail?.skillSources ?? item.skillSources ?? [];
  const skillCount = skillSources.reduce((total, source) => total + source.skills.length, 0);
  const pushTargets = [...(detail?.pushTargets ?? [])].sort((a, b) => a.commitOrder - b.commitOrder);

  const banner = item.enabled
    ? {
        tone: item.type === "review" ? ("warn" as const) : ("active" as const),
        icon: "play",
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
          onAccess={onAccess}
          onStatistics={onStatistics}
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
        <DetailRow k="Updated">{new Date(item.updatedAt).toLocaleDateString()}</DetailRow>
      </DetailSection>

      {detail?.ticketSource && (
        <DetailSection label="Ticket source">
          <DetailRow k="Ticket source">{linkedIntegrationLabel(detail.ticketSource.integration) ?? "—"}</DetailRow>
          <DetailRow k="Ticket project" mono>{detail.ticketSource.ticketProjectKey}</DetailRow>
        </DetailSection>
      )}

      {detail?.reviewConfig && (
        <DetailSection label="Review source">
          <DetailRow k="Review source">{linkedIntegrationLabel(detail.reviewConfig.integration) ?? "—"}</DetailRow>
          <DetailRow k="Repositories" mono>{detail.reviewConfig.repos.join(", ") || "—"}</DetailRow>
          <DetailRow k="Assignment">{detail.reviewConfig.assignmentMode}</DetailRow>
          <DetailRow k="Branches">{detail.reviewConfig.branches?.join(", ") || "All branches"}</DetailRow>
        </DetailSection>
      )}

      {pushTargets.length > 0 && (
        <DetailSection label={`Push targets · ${pushTargets.length}`}>
          {pushTargets.map((target) => (
            <DetailRow key={`${target.integrationId}:${target.repoKey}:${target.localPath}`} k={target.repoKey} mono>
              {`${target.targetBranch} · ${target.role}`}
            </DetailRow>
          ))}
        </DetailSection>
      )}

      {detail && (
        <DetailSection label="Options">
          <DetailRow k="Gerrit topic" mono>{detail.gerritTopicOverride ?? undefined}</DetailRow>
          <DetailRow k="React to CI failures">{yesNo(detail.reactToCiFailures)}</DetailRow>
          <DetailRow k="Post review link">{yesNo(detail.postReviewLinkToTicket)}</DetailRow>
          <DetailRow k="Full ticket URL in commits">{yesNo(detail.useFullTicketUrlInCommits)}</DetailRow>
          <DetailRow k="Post-clone script">{detail.postCloneScript?.trim() ? "configured" : undefined}</DetailRow>
          <DetailRow k="Skill sources">
            {skillSources.length > 0
              ? `${plural(skillSources.length, "source")} · ${skillSources.some((source) => source.installAll)
                ? "all skills"
                : plural(skillCount, "skill")}`
              : undefined}
          </DetailRow>
        </DetailSection>
      )}
    </Drawer>
  );
}
