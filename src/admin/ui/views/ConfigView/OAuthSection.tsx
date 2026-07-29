import { RowCard } from "../../components/RowCard.tsx";
import { Tag } from "../../components/Tag.tsx";
import { Icon } from "../../components/Icon.tsx";
import { OAuthDrawer } from "./ConfigDrawers.tsx";
import { OAuthFormModal } from "./OAuthFormModal.tsx";
import { useCurrentUser } from "../../authContext.tsx";
import type { ConfigSectionProps } from "./index.tsx";

export function OAuthSection({ oauthApps, onRefresh, route, navigate, markClean }: ConfigSectionProps) {
  const { can } = useCurrentUser();
  const canManage = can("oauth.manage");
  const detailItem = route.section === "oauth" && route.mode === "detail"
    ? oauthApps.find((app) => app.provider === route.provider && app.baseUrl === route.baseUrl)
    : undefined;

  function handleSaved() {
    markClean();
    onRefresh();
    navigate({ section: "oauth", mode: "list" });
  }

  function handleDeleted() {
    onRefresh();
    navigate({ section: "oauth", mode: "list" });
  }

  if (route.mode === "detail") {
    if (!detailItem) {
      return (
        <div className="config-missing">
          <div className="placeholder">This OAuth app is unavailable.</div>
          <button className="btn" onClick={() => navigate({ section: "oauth", mode: "list" })}>Back to OAuth apps</button>
        </div>
      );
    }
    return (
      <OAuthDrawer
        item={detailItem}
        onClose={() => navigate({ section: "oauth", mode: "list" })}
        {...(canManage ? { onDeleted: handleDeleted } : {})}
      />
    );
  }

  if (route.mode === "create") {
    return (
      <OAuthFormModal
        onClose={() => navigate({ section: "oauth", mode: "list" })}
        onSaved={handleSaved}
      />
    );
  }

  return (
    <>
      <div style={{ marginBottom: "22px" }}>
        <div className="eyebrow" style={{ marginBottom: "8px" }}>Configuration / OAuth Apps</div>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "16px" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: "22px", fontWeight: 600, letterSpacing: "-0.01em" }}>OAuth apps</h1>
            <p style={{ margin: "6px 0 0", color: "var(--text-faint)", fontSize: "13.5px" }}>Provider OAuth registrations used to mint short-lived agent tokens.</p>
          </div>
          {canManage && <button className="btn primary" onClick={() => navigate({ section: "oauth", mode: "create" })}><Icon name="plus" size={14} /> Register app</button>}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {oauthApps.length === 0 && (
          <div className="placeholder" style={{ minHeight: "120px" }}>No OAuth apps registered.</div>
        )}
        {oauthApps.map((app, i) => (
          <RowCard key={i} ariaLabel={`Open ${app.provider} OAuth app`} onClick={() => navigate({ section: "oauth", mode: "detail", provider: app.provider, baseUrl: app.baseUrl })}>
            <span
              style={{
                width: 34, height: 34, borderRadius: "8px",
                display: "grid", placeItems: "center",
                background: "var(--panel-2)", color: "var(--text-faint)", flex: "none",
              }}
            >
              <Icon name="link" size={15} />
            </span>
            <div className="row-card-copy" style={{ flex: 1 }}>
              <span className="mono" style={{ fontSize: "13px", fontWeight: 600 }}>
                {app.provider} · {app.baseUrl}
              </span>
              <div style={{ fontSize: "11.5px", color: "var(--text-faint)", marginTop: "2px" }}>
                client_id: {app.clientId}
              </div>
            </div>
            <Tag tone="ok">linked</Tag>
          </RowCard>
        ))}
      </div>

    </>
  );
}
