import { useCallback, useEffect, useState } from "react";
import { api } from "../../api.ts";
import { useCurrentUser } from "../../authContext.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Modal, Field, FieldInput, FieldSelect, FieldTextarea, FormError } from "../../components/Modal.tsx";
import { Tag } from "../../components/Tag.tsx";
import type { ApiGroup } from "../../types.ts";

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
  groupMembershipAttribute: string;
  groupSearchBaseDn?: string | undefined;
  groupSearchFilter: string;
  timeoutMs: number;
}

export type ProvisionedRole = "viewer" | "operator";

export interface AuthSource {
  id: string;
  name: string;
  kind: "ldap";
  enabled: boolean;
  priority: number;
  autoProvision: boolean;
  defaultRole: ProvisionedRole;
  sessionMaxAgeHours: number;
  revalidateIntervalMinutes: number;
  config: LdapSourceConfig;
}

interface GroupMapping {
  id: string;
  externalGroup: string;
  groupId: string;
  groupName: string;
}

type DirectoryLookup =
  | {
      status: "found";
      account: { dn: string; subject: string; username: string; displayName: string | null; groups: string[] };
      mappedGroups: Array<{ id: string; name: string }>;
      linkedUser: { id: string; username: string } | null;
      wouldProvision: boolean;
      blockedReason: "source_disabled" | "not_linked" | "username_taken" | null;
    }
  | { status: "not_found" | "ambiguous" }
  | { status: "unavailable"; error: string };

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
  groupMembershipAttribute: "memberOf",
  groupSearchBaseDn: "",
  groupSearchFilter: "(&(objectClass=groupOfNames)(member={dn}))",
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
  const { can } = useCurrentUser();
  const canManageMappings = can("policy.manage");
  const [sources, setSources] = useState<AuthSource[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AuthSource | null>(null);
  const [creating, setCreating] = useState(false);
  const [mappingSource, setMappingSource] = useState<AuthSource | null>(null);
  const [lookupSource, setLookupSource] = useState<AuthSource | null>(null);
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
                  {source.autoProvision && <span className="tag" style={{ fontSize: "10px" }}>auto-provision · {source.defaultRole}</span>}
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
              <button className="iconbtn" onClick={() => setLookupSource(source)} title="Look up a user" aria-label={`Look up a user in ${source.name}`} style={ACTION_ICON_STYLE}>
                <Icon name="search" size={16} />
              </button>
              {canManageMappings && (
                <button className="iconbtn" onClick={() => setMappingSource(source)} title="Group mappings" aria-label={`Group mappings for ${source.name}`} style={ACTION_ICON_STYLE}>
                  <Icon name="link" size={16} />
                </button>
              )}
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
      {mappingSource && <GroupMappingsModal source={mappingSource} onClose={() => setMappingSource(null)} />}
      {lookupSource && <DirectoryLookupModal source={lookupSource} onClose={() => setLookupSource(null)} />}
    </>
  );
}

function GroupMappingsModal({ source, onClose }: { source: AuthSource; onClose: () => void }) {
  const [mappings, setMappings] = useState<GroupMapping[]>([]);
  const [groups, setGroups] = useState<ApiGroup[]>([]);
  const [externalGroup, setExternalGroup] = useState("");
  const [groupId, setGroupId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [mapped, available] = await Promise.all([
        api.get<{ mappings: GroupMapping[] }>(`/api/admin/auth-sources/${source.id}/group-mappings`),
        api.get<{ groups: ApiGroup[] }>("/api/admin/groups"),
      ]);
      setMappings(mapped.mappings);
      setGroups(available.groups);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load group mappings");
    }
  }, [source.id]);

  useEffect(() => { void load(); }, [load]);

  async function mutate(operation: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await operation();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Group mappings" sub={`${source.name} — directory groups grant membership in VE groups at sign-in`} onClose={onClose} wide>
      <FormError msg={error} />
      <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "14px" }}>
        {mappings.length === 0 && <div className="placeholder" style={{ minHeight: "56px" }}>No group mappings yet.</div>}
        {mappings.map((mapping) => (
          <div key={mapping.id} className="card" style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 12px" }}>
            <span className="mono" style={{ flex: 1, fontSize: "12px", overflowWrap: "anywhere" }}>{mapping.externalGroup}</span>
            <Icon name="arrow" size={13} />
            <Tag tone="info" mono={false}>{mapping.groupName}</Tag>
            <button className="iconbtn" disabled={busy} title="Remove mapping" aria-label={`Remove mapping ${mapping.externalGroup}`}
              onClick={() => void mutate(() => api.delete(`/api/admin/auth-sources/${source.id}/group-mappings/${mapping.id}`))}>
              <Icon name="trash" size={14} />
            </button>
          </div>
        ))}
      </div>
      <Field label="Directory group DN" hint="Compared case-insensitively, e.g. cn=devs,ou=groups,dc=example,dc=com">
        <FieldInput value={externalGroup} onChange={(e) => setExternalGroup(e.target.value)} placeholder="cn=devs,ou=groups,dc=example,dc=com" />
      </Field>
      <Field label="VE group">
        <div style={{ display: "flex", gap: "8px" }}>
          <FieldSelect aria-label="VE group" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">Select a group…</option>
            {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </FieldSelect>
          <button className="btn primary" disabled={busy || externalGroup.trim() === "" || groupId === ""}
            onClick={() => void mutate(async () => {
              await api.post(`/api/admin/auth-sources/${source.id}/group-mappings`, { externalGroup: externalGroup.trim(), groupId });
              setExternalGroup("");
              setGroupId("");
            })}>
            Add mapping
          </button>
        </div>
      </Field>
    </Modal>
  );
}

function DirectoryLookupModal({ source, onClose }: { source: AuthSource; onClose: () => void }) {
  const [username, setUsername] = useState("");
  const [result, setResult] = useState<DirectoryLookup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleLookup() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.post<DirectoryLookup>(`/api/admin/auth-sources/${source.id}/lookup`, { username: username.trim() }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lookup failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Look up a user" sub={`${source.name} — resolves the account with the service account; no password is checked`} onClose={onClose} wide>
      <Field label="Directory username">
        <div style={{ display: "flex", gap: "8px" }}>
          <FieldInput aria-label="Directory username" value={username} autoComplete="off" onChange={(e) => setUsername(e.target.value)} />
          <button className="btn primary" disabled={busy || username.trim() === ""} onClick={() => void handleLookup()}>
            {busy ? "Looking up…" : "Look up"}
          </button>
        </div>
      </Field>
      <FormError msg={error} />
      {result && result.status !== "found" && (
        <div role="status" style={{ fontSize: "13px", color: "var(--text-dim)" }}>
          {result.status === "not_found" && "No account matches the user filter."}
          {result.status === "ambiguous" && "More than one account matches; tighten the user filter."}
          {result.status === "unavailable" && `Directory unavailable: ${result.error}`}
        </div>
      )}
      {result?.status === "found" && (
        <div role="status" style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "6px 14px", fontSize: "12.5px" }}>
          <span style={{ color: "var(--text-faint)" }}>DN</span><span className="mono" style={{ overflowWrap: "anywhere" }}>{result.account.dn}</span>
          <span style={{ color: "var(--text-faint)" }}>Username</span><span>{result.account.username}</span>
          <span style={{ color: "var(--text-faint)" }}>Display name</span><span>{result.account.displayName ?? "—"}</span>
          <span style={{ color: "var(--text-faint)" }}>Unique ID</span><span className="mono">{result.account.subject}</span>
          <span style={{ color: "var(--text-faint)" }}>Directory groups</span>
          <span className="mono" style={{ overflowWrap: "anywhere" }}>{result.account.groups.length > 0 ? result.account.groups.join("; ") : "none"}</span>
          <span style={{ color: "var(--text-faint)" }}>VE groups</span>
          <span>{result.mappedGroups.length > 0 ? result.mappedGroups.map((group) => group.name).join(", ") : "none"}</span>
          <span style={{ color: "var(--text-faint)" }}>VE account</span>
          <span>{lookupOutcome(result, source.defaultRole)}</span>
        </div>
      )}
    </Modal>
  );
}

function lookupOutcome(result: Extract<DirectoryLookup, { status: "found" }>, defaultRole: string): string {
  const linked = result.linkedUser ? `Linked to ${result.linkedUser.username}` : null;
  if (result.blockedReason === "source_disabled") {
    return `${linked ? `${linked}; s` : "S"}ign-in is refused while this source is disabled`;
  }
  if (linked) return linked;
  if (result.wouldProvision) return `Created on first sign-in as ${defaultRole}`;
  if (result.blockedReason === "username_taken") {
    return "Not created at sign-in: a local account already uses this username; link this account to a user or create it under another username";
  }
  return "Not linked; sign-in is refused until an admin links it";
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
  const [autoProvision, setAutoProvision] = useState(source?.autoProvision ?? false);
  const [defaultRole, setDefaultRole] = useState<ProvisionedRole>(source?.defaultRole ?? "viewer");
  const [sessionMaxAgeHours, setSessionMaxAgeHours] = useState(String(source?.sessionMaxAgeHours ?? 24));
  const [revalidateIntervalMinutes, setRevalidateIntervalMinutes] = useState(String(source?.revalidateIntervalMinutes ?? 15));
  const [config, setConfig] = useState<LdapSourceConfig>(() => ({
    ...EMPTY_LDAP_CONFIG,
    ...source?.config,
    tlsCaCert: source?.config.tlsCaCert ?? "",
    groupSearchBaseDn: source?.config.groupSearchBaseDn ?? "",
  }));
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
      const body = {
        name,
        enabled,
        priority: Number(priority),
        autoProvision,
        defaultRole,
        sessionMaxAgeHours: Number(sessionMaxAgeHours),
        revalidateIntervalMinutes: Number(revalidateIntervalMinutes),
        config: payloadConfig(),
      };
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

      <div className="eyebrow" style={{ margin: "18px 0 8px" }}>Groups</div>
      <Field label="Group membership attribute" hint="User attribute listing group DNs (memberOf). Leave empty to rely on the group search only.">
        <FieldInput value={config.groupMembershipAttribute} onChange={(e) => update("groupMembershipAttribute", e.target.value)} />
      </Field>
      <Field label="Group search base DN" hint="Optional. Searches groups with the service account for directories without memberOf.">
        <FieldInput value={config.groupSearchBaseDn ?? ""} onChange={(e) => update("groupSearchBaseDn", e.target.value)} placeholder="ou=groups,dc=example,dc=com" />
      </Field>
      <Field label="Group search filter" hint="{dn} is the user's DN and {username} the sign-in name, both escaped. Used only with a group search base.">
        <FieldInput value={config.groupSearchFilter} onChange={(e) => update("groupSearchFilter", e.target.value)} style={{ fontFamily: "var(--mono, monospace)" }} />
      </Field>

      <div className="eyebrow" style={{ margin: "18px 0 8px" }}>Provisioning</div>
      <Checkbox label="Create a user on first sign-in" checked={autoProvision} onChange={setAutoProvision} />
      <Field label="Role for new users" hint="Admin rights are never granted automatically; promote users on the Users page.">
        <FieldSelect value={defaultRole} disabled={!autoProvision} onChange={(e) => setDefaultRole(e.target.value as ProvisionedRole)}>
          <option value="viewer">viewer</option>
          <option value="operator">operator</option>
        </FieldSelect>
      </Field>

      <div className="eyebrow" style={{ margin: "18px 0 8px" }}>Sessions</div>
      <Field label="Maximum session age (hours)" hint="Directory sessions end after this long even while active (1–720).">
        <FieldInput type="number" min={1} max={720} value={sessionMaxAgeHours} onChange={(e) => setSessionMaxAgeHours(e.target.value)} />
      </Field>
      <Field label="Revalidation interval (minutes)" hint="Active sessions re-check the directory account and its groups this often; 0 checks on every request. An unreachable directory keeps sessions until the maximum age.">
        <FieldInput type="number" min={0} max={1440} value={revalidateIntervalMinutes} onChange={(e) => setRevalidateIntervalMinutes(e.target.value)} />
      </Field>
    </Modal>
  );
}
