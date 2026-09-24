import { useMemo, useState } from "react";
import { RowCard } from "../../components/RowCard.tsx";
import { ListToolbar, NoListMatches } from "../../components/ListToolbar.tsx";
import { ProviderGlyph } from "../../components/ProviderGlyph.tsx";
import { Tag } from "../../components/Tag.tsx";
import { Toggle } from "../../components/Toggle.tsx";
import { Icon } from "../../components/Icon.tsx";
import { api } from "../../api.ts";
import { useCurrentUser } from "../../authContext.tsx";
import { IntegrationFormModal } from "./IntegrationFormModal.tsx";
import { IntegrationDrawer } from "./ConfigDrawers.tsx";
import { integrationListConfig } from "./configListConfigs.ts";
import { EMPTY_LIST_FILTER, applyListFilter } from "./listFilters.ts";
import type { ApiIntegration } from "../../types.ts";
import type { ConfigSectionProps } from "./index.tsx";

export function IntegrationsSection({ integrations, plugins, onRefresh, route, navigate, markClean, setDirty, listFilter, onListFilterChange }: ConfigSectionProps) {
  const { can } = useCurrentUser();
  const canCreate = can("integration.create");
  const [busy, setBusy] = useState<string | null>(null);
  const listConfig = useMemo(() => integrationListConfig(integrations, plugins), [integrations, plugins]);
  const visibleIntegrations = useMemo(() => applyListFilter(integrations, listFilter, listConfig), [integrations, listFilter, listConfig]);
  const routeId = route.section === "integrations" && (route.mode === "detail" || route.mode === "edit")
    ? route.id
    : null;
  const routeItem = routeId ? integrations.find((integration) => integration.id === routeId) : undefined;

  async function toggleEnabled(id: string, enabled: boolean) {
    setBusy(id);
    try {
      await api.patch(`/api/admin/integrations/${id}/${enabled ? "disable" : "enable"}`);
      onRefresh();
    } finally {
      setBusy(null);
    }
  }

  async function deleteIntegration(it: ApiIntegration): Promise<boolean> {
    if (!window.confirm(`Delete integration "${it.name}"? This cannot be undone.`)) return false;
    setBusy(it.id);
    try {
      await api.delete(`/api/admin/integrations/${it.id}`);
      onRefresh();
      return true;
    } catch (e) {
      alert(e instanceof Error ? e.message : "Delete failed");
      return false;
    } finally {
      setBusy(null);
    }
  }

  function handleSaved() {
    markClean();
    onRefresh();
    navigate(route.mode === "edit" && routeId
      ? { section: "integrations", mode: "detail", id: routeId }
      : { section: "integrations", mode: "list" });
  }

  if (route.mode === "detail") {
    if (!routeItem) return <MissingEntity label="integration" onBack={() => navigate({ section: "integrations", mode: "list" })} />;
    return (
      <IntegrationDrawer
        item={routeItem}
        onClose={() => navigate({ section: "integrations", mode: "list" })}
        {...(can("integration.write", routeItem.id, routeItem.ownerUserId ?? null) ? { onEdit: () => navigate({ section: "integrations", mode: "edit", id: routeItem.id }) } : {})}
        {...(can("integration.operate", routeItem.id, routeItem.ownerUserId ?? null) ? { onToggle: () => { void toggleEnabled(routeItem.id, routeItem.enabled); } } : {})}
        {...(can("integration.delete", routeItem.id, routeItem.ownerUserId ?? null) ? { onDelete: () => { void deleteIntegration(routeItem).then((deleted) => { if (deleted) navigate({ section: "integrations", mode: "list" }); }); } } : {})}
      />
    );
  }

  if (route.mode === "create" || route.mode === "edit") {
    const canUseForm = route.mode === "create"
      ? canCreate
      : routeItem !== undefined && can("integration.write", routeItem.id, routeItem.ownerUserId ?? null);
    if (!canUseForm) return <MissingEntity label="page" onBack={() => navigate({ section: "integrations", mode: "list" })} />;
    if (route.mode === "edit" && !routeItem) return <MissingEntity label="integration" onBack={() => navigate({ section: "integrations", mode: "list" })} />;
    return (
      <IntegrationFormModal
        integration={route.mode === "edit" ? routeItem : undefined}
        plugins={plugins}
        onClose={() => navigate(route.mode === "edit" && routeId
          ? { section: "integrations", mode: "detail", id: routeId }
          : { section: "integrations", mode: "list" })}
        onSaved={handleSaved}
        onDirtyChange={setDirty}
      />
    );
  }

  return (
    <>
      <div style={{ marginBottom: "22px" }}>
        <div className="eyebrow" style={{ marginBottom: "8px" }}>Configuration / Integrations</div>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "16px" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: "22px", fontWeight: 600, letterSpacing: "-0.01em" }}>Integrations</h1>
            <p style={{ margin: "6px 0 0", color: "var(--text-faint)", fontSize: "13.5px" }}>External providers the orchestrator routes to by integration ID.</p>
          </div>
          {canCreate && (
            <button className="btn primary" data-tour="integrations-add" onClick={() => navigate({ section: "integrations", mode: "create" })}>
              <Icon name="plus" size={14} /> Add integration
            </button>
          )}
        </div>
      </div>

      {integrations.length > 0 && (
        <ListToolbar
          noun="integrations"
          searchPlaceholder="Search by name, provider, or ID"
          config={listConfig}
          state={listFilter}
          onChange={onListFilterChange}
          shown={visibleIntegrations.length}
          total={integrations.length}
        />
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {integrations.length === 0 && (
          <div className="placeholder" style={{ minHeight: "120px" }}>No integrations configured.</div>
        )}
        {integrations.length > 0 && visibleIntegrations.length === 0 && (
          <NoListMatches noun="integrations" onClear={() => onListFilterChange(EMPTY_LIST_FILTER)} />
        )}
        {visibleIntegrations.map((it) => {
          const tone = it.enabled ? "ok" : "muted";
          return (
            <RowCard key={it.id} ariaLabel={`Open integration ${it.name}`} onClick={() => navigate({ section: "integrations", mode: "detail", id: it.id })}>
              <ProviderGlyph provider={it.provider} size={36} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "9px", minWidth: 0 }}>
                  <span style={{ fontSize: "13.5px", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {it.name}
                  </span>
                  <Tag tone={it.domainCapabilities.includes("agent_execution") ? "active" : it.domainCapabilities.includes("issue_tracking") ? "info" : "warn"} mono={false}>
                    {it.provider}
                  </Tag>
                </div>
                <div style={{ fontSize: "12px", color: "var(--text-faint)", marginTop: "3px" }}>
                  {it.provider} · {it.id.slice(0, 8)}
                </div>
              </div>
              <Tag tone={tone}>
                <span
                  className={it.enabled ? "live-dot" : undefined}
                  style={{ width: 5, height: 5, borderRadius: "50%", background: "currentColor", flex: "none", display: "inline-block" }}
                />
                {it.enabled ? "enabled" : "disabled"}
              </Tag>
              {can("integration.operate", it.id, it.ownerUserId ?? null) && (
                <div onClick={(e) => e.stopPropagation()}>
                  <Toggle
                    on={it.enabled}
                    label={`Integration ${it.name} enabled`}
                    disabled={busy === it.id}
                    onChange={() => void toggleEnabled(it.id, it.enabled)}
                  />
                </div>
              )}
              {can("integration.delete", it.id, it.ownerUserId ?? null) && (
                <button
                  className="iconbtn"
                  title="Delete"
                  disabled={busy === it.id}
                  onClick={(e) => { e.stopPropagation(); void deleteIntegration(it); }}
                >
                  <Icon name="trash" size={14} />
                </button>
              )}
            </RowCard>
          );
        })}
      </div>

    </>
  );
}

function MissingEntity({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <div className="config-missing">
      <div className="placeholder">This {label} is unavailable or you do not have access.</div>
      <button className="btn" onClick={onBack}>Back to integrations</button>
    </div>
  );
}
