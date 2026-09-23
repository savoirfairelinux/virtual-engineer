import { useCallback, useEffect, useState } from "react";
import { Icon } from "../../components/Icon.tsx";
import { Tag } from "../../components/Tag.tsx";
import { api } from "../../api.ts";
import type { ApiAuditEntry, ApiAuditPage } from "../../types.ts";

const PAGE_SIZE = 50;

/** Actor names that denote unverified identities (legacy + current fallback). */
const UNVERIFIED_ACTORS = new Set(["unknown", "unauthenticated"]);
/** Actor name for the unauthenticated bootstrap phase before any user exists. */
const BOOTSTRAP_ACTOR = "bootstrap";

const filterInputStyle: React.CSSProperties = {
  padding: "7px 10px", fontSize: "12.5px", fontFamily: "var(--font-sans)",
  border: "1px solid var(--border)", borderRadius: "var(--radius-sm)",
  background: "var(--panel-2)", color: "var(--text)", outline: "none",
  width: "200px",
};

const clickableStyle: React.CSSProperties = {
  cursor: "pointer",
};

/** Short technical tokens rendered as acronyms rather than capitalized words. */
const ACRONYMS = new Set(["ip", "url", "id", "api", "ssh", "http", "https", "json", "uri"]);

/** Humanize a details key for display: "sourceIp" → "Source IP". */
function humanizeKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return spaced
    .split(/\s+/)
    .map((word) => ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Compact inline JSON for non-primitive detail values. */
function formatInlineJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isPrimitive(value: unknown): value is string | number | boolean | null {
  return ["string", "number", "boolean"].includes(typeof value) || value === null;
}

/** Render the masked details blob as a labeled key/value table. */
function DetailsTable({ details }: { details: Record<string, unknown> }) {
  const rows = Object.entries(details);
  if (rows.length === 0) return null;
  return (
    <div style={{ padding: "10px 16px 14px", background: "var(--panel-2)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(140px, max-content) 1fr", gap: "6px 20px", fontSize: "12px" }}>
        {rows.map(([key, value]) => (
          <div key={key} style={{ display: "contents" }}>
            <span style={{ color: "var(--text-faint)", whiteSpace: "nowrap" }}>{humanizeKey(key)}</span>
            {isPrimitive(value) ? (
              <span className="mono" style={{ color: "var(--text-dim)", wordBreak: "break-word" }}>
                {value === null ? "—" : String(value)}
              </span>
            ) : (
              <span className="mono" style={{ color: "var(--text-dim)", fontSize: "11.5px", wordBreak: "break-all" }}>
                {formatInlineJson(value)}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Actor cell: real usernames plain; unverified/bootstrap actors as badges. */
function ActorCell({ name, onFilter }: { name: string; onFilter: (actor: string) => void }) {
  if (UNVERIFIED_ACTORS.has(name)) {
    return (
      <span title={`Unverified identity (actor name: ${name})`}>
        <Tag tone="muted">UNVERIFIED</Tag>
      </span>
    );
  }
  if (name === BOOTSTRAP_ACTOR) {
    return (
      <span title="Initial bootstrap (no users existed yet)">
        <Tag tone="muted">SYSTEM</Tag>
      </span>
    );
  }
  return (
    <span
      onClick={(e) => { e.stopPropagation(); onFilter(name); }}
      style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", ...clickableStyle }}
      title={`Filter by ${name}`}
    >
      {name}
    </span>
  );
}

export function AuditSection() {
  const [entries, setEntries] = useState<ApiAuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [actionFilter, setActionFilter] = useState("");
  const [actorFilter, setActorFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const load = useCallback(async (nextOffset: number, action: string, actor: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(nextOffset) });
      if (action.trim()) params.set("action", action.trim());
      if (actor.trim()) params.set("actor", actor.trim());
      const page = await api.get<ApiAuditPage>(`/api/admin/audit?${params.toString()}`);
      setEntries(page.entries);
      setTotal(page.total);
      setOffset(page.offset);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load audit log");
    } finally {
      setLoading(false);
    }
  }, []);

  // Reload on filter change (debounced) — filters reset pagination.
  useEffect(() => {
    const id = setTimeout(() => { void load(0, actionFilter, actorFilter); }, 300);
    return () => clearTimeout(id);
  }, [actionFilter, actorFilter, load]);

  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + entries.length, total);

  return (
    <>
      <div style={{ marginBottom: "22px" }}>
        <div className="eyebrow" style={{ marginBottom: "8px" }}>Configuration / Audit</div>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "16px" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: "22px", fontWeight: 600, letterSpacing: "-0.01em" }}>Audit trail</h1>
            <p style={{ margin: "6px 0 0", color: "var(--text-faint)", fontSize: "13.5px" }}>Timestamped record of every admin configuration change.</p>
          </div>
          <button className="btn" data-tour="audit-refresh" onClick={() => void load(offset, actionFilter, actorFilter)} disabled={loading}>
            <Icon name="refresh" size={14} /> Refresh
          </button>
        </div>
      </div>

      {/* filters */}
      <div data-tour="audit-filters" style={{ display: "flex", gap: "10px", alignItems: "center", marginBottom: "14px" }}>
        <input
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          placeholder="Filter by action (e.g. integration.update)…"
          style={{ ...filterInputStyle, width: "260px" }}
        />
        <input
          value={actorFilter}
          onChange={(e) => setActorFilter(e.target.value)}
          placeholder="Filter by actor…"
          style={filterInputStyle}
        />
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: "12px", color: "var(--text-faint)" }}>
          {loading ? "Loading…" : `${from}–${to} of ${total}`}
        </span>
      </div>

      {error && (
        <div
          style={{
            marginBottom: "14px", padding: "10px 14px",
            background: "var(--danger-soft)",
            border: "1px solid color-mix(in oklab,var(--danger) 30%, transparent)",
            borderRadius: "var(--radius-sm)", fontSize: "13px", color: "var(--danger)",
          }}
        >
          {error}
        </div>
      )}

      {/* table */}
      <div className="card" data-tour="audit-table" style={{ padding: 0, overflow: "hidden" }}>
        <div
          style={{
            display: "grid", gridTemplateColumns: "170px 140px 1fr 220px 32px",
            gap: "0 12px", padding: "9px 16px",
            borderBottom: "1px solid var(--border-soft)",
            fontSize: "10.5px", fontWeight: 600, letterSpacing: "0.05em",
            textTransform: "uppercase", color: "var(--text-ghost)",
          }}
        >
          <span>Time</span><span>Actor</span><span>Action</span><span>Target</span><span />
        </div>

        {entries.length === 0 && !loading && (
          <div className="placeholder" style={{ minHeight: "100px", border: "none" }}>No audit entries.</div>
        )}

        {entries.map((e) => {
          const expanded = expandedId === e.id;
          const hasDetails = Object.keys(e.details ?? {}).length > 0;
          return (
            <div key={e.id} style={{ borderBottom: "1px solid var(--border-soft)" }}>
              <div
                onClick={() => { if (hasDetails) setExpandedId(expanded ? null : e.id); }}
                style={{
                  display: "grid", gridTemplateColumns: "170px 140px 1fr 220px 32px",
                  gap: "0 12px", padding: "10px 16px", alignItems: "center",
                  cursor: hasDetails ? "pointer" : "default", fontSize: "12.5px",
                }}
              >
                <span className="mono" style={{ fontSize: "11.5px", color: "var(--text-dim)" }}>
                  {new Date(e.createdAt).toLocaleString()}
                </span>
                <ActorCell name={e.actorName} onFilter={(actor) => setActorFilter(actor)} />
                <span>
                  <span onClick={(e2) => { e2.stopPropagation(); setActionFilter(e.action); }} style={clickableStyle}>
                    <Tag tone="info">{e.action}</Tag>
                  </span>
                </span>
                <span className="mono" style={{ fontSize: "11.5px", color: "var(--text-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {e.targetType ? `${e.targetType}${e.targetId ? ` · ${e.targetId}` : ""}` : "—"}
                </span>
                <span style={{ display: "grid", placeItems: "center" }}>
                  {hasDetails && (
                    <Icon
                      name="chevdown"
                      size={13}
                      style={{ color: "var(--text-faint)", transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}
                    />
                  )}
                </span>
              </div>
              {expanded && hasDetails && <DetailsTable details={e.details} />}
            </div>
          );
        })}
      </div>

      {/* pagination */}
      <div data-tour="audit-pagination" style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "14px" }}>
        <button
          className="btn"
          disabled={loading || offset === 0}
          onClick={() => void load(Math.max(0, offset - PAGE_SIZE), actionFilter, actorFilter)}
        >
          Newer
        </button>
        <button
          className="btn"
          disabled={loading || offset + entries.length >= total}
          onClick={() => void load(offset + PAGE_SIZE, actionFilter, actorFilter)}
        >
          Older
        </button>
      </div>
    </>
  );
}
