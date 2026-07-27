import { useState } from "react";
import { RowCard } from "../../components/RowCard.tsx";
import { Tag } from "../../components/Tag.tsx";
import { Icon } from "../../components/Icon.tsx";
import { OAuthDrawer } from "./ConfigDrawers.tsx";
import { OAuthFormModal } from "./OAuthFormModal.tsx";
import { useCurrentUser } from "../../authContext.tsx";
import type { ConfigViewData } from "./index.tsx";

export function OAuthSection({ oauthApps, onRefresh }: ConfigViewData) {
  const { canOperate } = useCurrentUser();
  const [drawerIdx, setDrawerIdx] = useState<number | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const drawerItem = drawerIdx !== null ? oauthApps[drawerIdx] : undefined;

  function handleSaved() {
    setShowAdd(false);
    onRefresh();
  }

  function handleDeleted() {
    setDrawerIdx(null);
    onRefresh();
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
          {canOperate && <button className="btn primary" onClick={() => setShowAdd(true)}><Icon name="plus" size={14} /> Register app</button>}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {oauthApps.length === 0 && (
          <div className="placeholder" style={{ minHeight: "120px" }}>No OAuth apps registered.</div>
        )}
        {oauthApps.map((app, i) => (
          <RowCard key={i} onClick={() => setDrawerIdx(i)}>
            <span
              style={{
                width: 34, height: 34, borderRadius: "8px",
                display: "grid", placeItems: "center",
                background: "var(--panel-2)", color: "var(--text-faint)", flex: "none",
              }}
            >
              <Icon name="link" size={15} />
            </span>
            <div style={{ flex: 1 }}>
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

      {drawerItem && (
        <OAuthDrawer item={drawerItem} onClose={() => setDrawerIdx(null)} onDeleted={handleDeleted} />
      )}

      {showAdd && (
        <OAuthFormModal onClose={() => setShowAdd(false)} onSaved={handleSaved} />
      )}
    </>
  );
}
