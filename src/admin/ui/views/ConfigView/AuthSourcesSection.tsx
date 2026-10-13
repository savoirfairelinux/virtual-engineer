import { useEffect, useState } from "react";
import { api } from "../../api.ts";
import { Icon } from "../../components/Icon.tsx";
import { Modal, Field, FieldInput, FieldTextarea } from "../../components/Modal.tsx";

export interface LdapSourceConfig {
  url: string;
  startTls: boolean;
  tlsCaCert?: string | undefined;
  bindDn: string;
  bindPassword: string;
  userSearchBaseDn: string;
  userSearchFilter: string;
  usernameAttribute: string;
  uniqueIdAttribute: string;
  displayNameAttribute: string;
  timeoutMs: number;
}

export interface AuthSource {
  id: string;
  name: string;
  kind: "ldap";
  enabled: boolean;
  priority: number;
  config: LdapSourceConfig;
}

type ConnectionTest = { ok: true } | { ok: false; stage: string; error: string };

export const SECRET_MASK = "********";

export const EMPTY_LDAP_CONFIG: LdapSourceConfig = {
  url: "ldaps://",
  startTls: false,
  tlsCaCert: "",
  bindDn: "",
  bindPassword: "",
  userSearchBaseDn: "",
  userSearchFilter: "(&(objectClass=inetOrgPerson)(uid={username}))",
  usernameAttribute: "uid",
  uniqueIdAttribute: "entryUUID",
  displayNameAttribute: "cn",
  timeoutMs: 5000,
};

const ACTION_ICON_STYLE = {
  color: "var(--text-dim)",
  background: "var(--panel-2)",
  borderColor: "var(--border-soft)",
} as const;

export function describeConnectionTest(result: ConnectionTest): string {
  return result.ok ? "Connection succeeded" : `Failed at ${result.stage}: ${result.error}`;
}

export function AuthSourcesSection() {
  const [sources, setSources] = useState<AuthSource[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AuthSource | null>(null);
  const [creating, setCreating] = useState(false);
  const [testResults, setTestResults] = useState<Record<string, string>>({});

  async function load() {
    setError(null);
    try {
      const data = await api.get<{ authSources: AuthSource[] }>("/api/admin/auth-sources");
      setSources(data.authSources);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load authentication sources");
    }
  }

  useEffect(() => { void load(); }, []);

  async function handleTest(source: AuthSource) {
    setTestResults((current) => ({ ...current, [source.id]: "Testing…" }));
    try {
      const result = await api.post<ConnectionTest>(`/api/admin/auth-sources/${source.id}/test`, {});
      setTestResults((current) => ({ ...current, [source.id]: describeConnectionTest(result) }));
    } catch (e) {
      setTestResults((current) => ({ ...current, [source.id]: e instanceof Error ? e.message : "Test failed" }));
    }
  }

  async function handleDelete(source: AuthSource) {
    if (!window.confirm(`Delete the authentication source "${source.name}"?`)) return;
    try {
      await api.delete(`/api/admin/auth-sources/${source.id}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  }

  return (
    <>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "22px" }}>
        <div>
          <div className="eyebrow" style={{ marginBottom: "8px" }}>Configuration / Access control</div>
          <h1 style={{ margin: 0, fontSize: "22px", fontWeight: 600, letterSpacing: "-0.01em" }}>Authentication</h1>
          <p style={{ margin: "6px 0 0", color: "var(--text-faint)", fontSize: "13.5px", maxWidth: "600px" }}>
            LDAP directories that admin users can sign in through. Connections always use LDAPS or StartTLS,
            and the bind password is stored encrypted.
          </p>
        </div>
        <button className="btn primary" data-tour="auth-sources-new" onClick={() => setCreating(true)}>
          <Icon name="plus" size={14} /> New LDAP source
        </button>
      </div>

      {error && <div className="card" style={{ padding: "12px 14px", marginBottom: "16px", color: "var(--danger, #f85149)" }}>{error}</div>}

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {sources.length === 0 ? (
          <div style={{ padding: "22px", color: "var(--text-ghost)", fontSize: "13px" }}>No authentication sources yet.</div>
        ) : (
          sources.map((source, index) => (
            <div
              key={source.id}
              style={{
                display: "flex", alignItems: "center", gap: "12px", padding: "13px 16px",
                borderTop: index === 0 ? "none" : "1px solid var(--border-soft)",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ fontWeight: 600, fontSize: "13.5px" }}>{source.name}</span>
                  <span className="tag" style={{ textTransform: "uppercase", fontSize: "10px" }}>{source.kind}</span>
                  <span className="tag" style={{ fontSize: "10px" }}>{source.enabled ? "enabled" : "disabled"}</span>
                  <span style={{ fontSize: "11px", color: "var(--text-ghost)" }}>priority {source.priority}</span>
                </div>
                <div style={{ fontSize: "11.5px", color: "var(--text-ghost)", marginTop: 2 }}>
                  {source.config.url}{source.config.startTls ? " · StartTLS" : ""} · {source.config.userSearchBaseDn}
                </div>
                {testResults[source.id] && (
                  <div role="status" style={{ fontSize: "12px", color: "var(--text-dim)", marginTop: 4 }}>{testResults[source.id]}</div>
                )}
              </div>
              <button className="iconbtn" onClick={() => void handleTest(source)} title="Test connection" aria-label={`Test ${source.name}`} style={ACTION_ICON_STYLE}>
                <Icon name="pulse" size={16} />
              </button>
              <button className="iconbtn" onClick={() => setEditing(source)} title="Edit" aria-label={`Edit ${source.name}`} style={ACTION_ICON_STYLE}>
                <Icon name="edit" size={16} />
              </button>
              <button className="iconbtn danger" onClick={() => void handleDelete(source)} title="Delete" aria-label={`Delete ${source.name}`} style={ACTION_ICON_STYLE}>
                <Icon name="trash" size={16} />
              </button>
            </div>
          ))
        )}
      </div>

      {(creating || editing) && (
        <AuthSourceEditor
          source={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { setCreating(false); setEditing(null); void load(); }}
        />
      )}
    </>
  );
}

function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: "13px", userSelect: "none" }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ accentColor: "var(--accent)", cursor: "pointer", flexShrink: 0 }}
      />
      {label}
    </label>
  );
}

export function AuthSourceEditor({ source, onClose, onSaved }: { source: AuthSource | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(source?.name ?? "");
  const [enabled, setEnabled] = useState(source?.enabled ?? true);
  const [priority, setPriority] = useState(String(source?.priority ?? 100));
  const [config, setConfig] = useState<LdapSourceConfig>(() => ({ ...EMPTY_LDAP_CONFIG, ...source?.config, tlsCaCert: source?.config.tlsCaCert ?? "" }));
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function update<K extends keyof LdapSourceConfig>(key: K, value: LdapSourceConfig[K]) {
    setConfig((current) => ({ ...current, [key]: value }));
  }

  function payloadConfig(): LdapSourceConfig {
    return { ...config, timeoutMs: Number(config.timeoutMs) };
  }

  async function handleTest() {
    setBusy(true);
    setTestResult("Testing…");
    try {
      const result = await api.post<ConnectionTest>("/api/admin/auth-sources/test", {
        ...(source ? { id: source.id } : {}),
        kind: "ldap",
        config: payloadConfig(),
      });
      setTestResult(describeConnectionTest(result));
    } catch (e) {
      setTestResult(e instanceof Error ? e.message : "Test failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleSave() {
    setError(null);
    if (!name.trim()) { setError("Name is required"); return; }
    setBusy(true);
    try {
      const body = { name, enabled, priority: Number(priority), config: payloadConfig() };
      if (source) {
        await api.put(`/api/admin/auth-sources/${source.id}`, body);
      } else {
        await api.post("/api/admin/auth-sources", { ...body, kind: "ldap" });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={source ? `Edit "${source.name}"` : "New LDAP source"}
      sub="Directory used to authenticate admin users"
      onClose={onClose}
      wide
      footer={
        <>
          {testResult && <span role="status" style={{ marginRight: "auto", fontSize: "12.5px", color: "var(--text-dim)" }}>{testResult}</span>}
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn" data-tour="auth-source-form-test" disabled={busy} onClick={() => void handleTest()}>Test connection</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void handleSave()}>{busy ? "Working…" : "Save"}</button>
        </>
      }
    >
      {error && <div style={{ marginBottom: "12px", color: "var(--danger, #f85149)", fontSize: "13px" }}>{error}</div>}
      <Field label="Name" required>
        <FieldInput data-tour="auth-source-form-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Corporate directory" />
      </Field>
      <Field label="Priority" hint="Lower values are tried first.">
        <FieldInput type="number" min={0} value={priority} onChange={(e) => setPriority(e.target.value)} />
      </Field>
      <Checkbox label="Enabled" checked={enabled} onChange={setEnabled} />

      <div className="eyebrow" style={{ margin: "18px 0 8px" }}>Connection</div>
      <Field label="URL" required hint="ldaps://host:636, or ldap://host:389 with StartTLS.">
        <FieldInput data-tour="auth-source-form-url" value={config.url} onChange={(e) => update("url", e.target.value)} placeholder="ldaps://ldap.example.com:636" />
      </Field>
      <Checkbox label="Use StartTLS (ldap:// URLs only)" checked={config.startTls} onChange={(value) => update("startTls", value)} />
      <Field label="CA certificate (PEM)" hint="Leave empty to trust the system certificate authorities.">
        <FieldTextarea rows={4} value={config.tlsCaCert ?? ""} onChange={(e) => update("tlsCaCert", e.target.value)} style={{ fontFamily: "var(--mono, monospace)", fontSize: "12px" }} />
      </Field>
      <Field label="Timeout (ms)">
        <FieldInput type="number" min={1000} max={60000} value={config.timeoutMs} onChange={(e) => update("timeoutMs", Number(e.target.value))} />
      </Field>

      <div className="eyebrow" style={{ margin: "18px 0 8px" }}>Service account</div>
      <Field label="Bind DN" required>
        <FieldInput data-tour="auth-source-form-bind" value={config.bindDn} onChange={(e) => update("bindDn", e.target.value)} placeholder="cn=ve-service,ou=services,dc=example,dc=com" />
      </Field>
      <Field label="Bind password" required={!source} hint={source ? "Leave unchanged to keep the stored password." : undefined}>
        <FieldInput type="password" autoComplete="new-password" value={config.bindPassword} onChange={(e) => update("bindPassword", e.target.value)} />
      </Field>

      <div className="eyebrow" style={{ margin: "18px 0 8px" }}>User lookup</div>
      <Field label="User search base DN" required>
        <FieldInput value={config.userSearchBaseDn} onChange={(e) => update("userSearchBaseDn", e.target.value)} placeholder="ou=people,dc=example,dc=com" />
      </Field>
      <Field label="User filter" hint="{username} is replaced with the escaped sign-in name. Exclude disabled accounts here.">
        <FieldInput value={config.userSearchFilter} onChange={(e) => update("userSearchFilter", e.target.value)} style={{ fontFamily: "var(--mono, monospace)" }} />
      </Field>
      <Field label="Username attribute">
        <FieldInput value={config.usernameAttribute} onChange={(e) => update("usernameAttribute", e.target.value)} />
      </Field>
      <Field label="Unique ID attribute" hint="Stable identifier: entryUUID (OpenLDAP) or objectGUID (Active Directory).">
        <FieldInput value={config.uniqueIdAttribute} onChange={(e) => update("uniqueIdAttribute", e.target.value)} />
      </Field>
      <Field label="Display name attribute">
        <FieldInput value={config.displayNameAttribute} onChange={(e) => update("displayNameAttribute", e.target.value)} />
      </Field>
    </Modal>
  );
}
