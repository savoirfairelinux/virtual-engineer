import { useEffect, useState, useCallback, useRef } from "react";
import { Modal, Field, FieldInput, FieldSelect, FormError, FormRow, FieldTextarea } from "../../components/Modal.tsx";
import { Icon } from "../../components/Icon.tsx";
import { ProviderGlyph } from "../../components/ProviderGlyph.tsx";
import { api } from "../../api.ts";
import type { ApiIntegration, ApiPlugin, ApiPluginOAuth, PluginField } from "../../types.ts";

interface Props {
  integration?: ApiIntegration | undefined;
  plugins: ApiPlugin[];
  onClose: () => void;
  onSaved: () => void;
}

type Config = Record<string, string>;

const CAPABILITY_COLORS: Record<string, { bg: string; color: string }> = {
  issue_tracking:  { bg: "var(--info-soft)",   color: "var(--info)" },
  code_review:     { bg: "var(--warn-soft)",   color: "var(--warn)" },
  source_control:  { bg: "var(--warn-soft)",   color: "var(--warn)" },
  agent_execution: { bg: "var(--accent-soft)", color: "var(--accent)" },
};

const CAPABILITY_LABEL: Record<string, string> = {
  issue_tracking:  "Tickets",
  code_review:     "Review",
  source_control:  "VCS",
  agent_execution: "Agent",
};

function CapabilityBadge({ capability }: { capability: string }) {
  const c = CAPABILITY_COLORS[capability] ?? CAPABILITY_COLORS["agent_execution"]!;
  const label = CAPABILITY_LABEL[capability] ?? capability;
  return (
    <span
      style={{
        fontSize: "10.5px", fontWeight: 600, letterSpacing: "0.04em",
        padding: "2px 8px", borderRadius: "99px",
        background: c.bg, color: c.color, textTransform: "uppercase",
      }}
    >
      {label}
    </span>
  );
}

function TypePicker({ plugins, onSelect }: { plugins: ApiPlugin[]; onSelect: (provider: string) => void }) {
  const [hovered, setHovered] = useState<string | null>(null);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "10px", padding: "4px 0 8px" }}>
      {plugins.map((p) => {
        const active = hovered === p.provider;
        return (
          <button
            key={p.provider}
            onClick={() => onSelect(p.provider)}
            onMouseEnter={() => setHovered(p.provider)}
            onMouseLeave={() => setHovered(null)}
            style={{
              display: "flex", flexDirection: "column", alignItems: "center",
              gap: "10px", padding: "20px 12px 18px", borderRadius: "12px",
              background: active ? "var(--panel-2)" : "var(--panel)",
              border: active ? "1px solid var(--accent-line)" : "1px solid var(--border-soft)",
              cursor: "pointer", outline: "none", textAlign: "center",
              transition: "border-color .12s, background .12s, box-shadow .12s",
              boxShadow: active ? "0 0 0 3px var(--accent-soft)" : "none",
            }}
          >
            <ProviderGlyph provider={p.provider} size={48} />
            <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--text)" }}>{p.name}</span>
            {p.domainCapabilities.slice(0, 2).map((cap) => (
              <CapabilityBadge key={cap} capability={cap} />
            ))}
          </button>
        );
      })}
    </div>
  );
}

function base64UrlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Generate a PKCE verifier + S256 challenge pair using the Web Crypto API. */
async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  const verifier = base64UrlEncode(randomBytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64UrlEncode(new Uint8Array(digest));
  return { verifier, challenge };
}

function useOAuthFlow(
  oauth: ApiPluginOAuth | undefined,
  onToken: (token: string) => void
) {
  const [pending, setPending] = useState(false);
  const [userCode, setUserCode] = useState<string | null>(null);
  const [verificationUri, setVerificationUri] = useState<string | null>(null);
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);
  // Redirect (manual-code) flow state.
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [awaitingCode, setAwaitingCode] = useState(false);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const pkceRef = useRef<{ verifier: string; state: string } | null>(null);

  const reset = useCallback(() => {
    setPending(false);
    setUserCode(null);
    setVerificationUri(null);
    setDeviceCode(null);
    setAuthorizationUrl(null);
    setAwaitingCode(false);
    setCode("");
    setSubmitting(false);
    pkceRef.current = null;
  }, []);

  const start = useCallback(async () => {
    if (!oauth) return;
    setOauthError(null);
    setPending(true);
    try {
      if (oauth.mode === "redirect") {
        // Manual authorization-code flow: request an authorization URL, then the
        // user pastes back the code shown on the provider's callback page.
        const { verifier, challenge } = await generatePkce();
        const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
        pkceRef.current = { verifier, state };
        const res = await api.post<{ authorizationUrl: string }>(oauth.startPath, {
          redirectUri: window.location.origin,
          state,
          codeChallenge: challenge,
          codeChallengeMethod: "S256",
        });
        setAuthorizationUrl(res.authorizationUrl);
        setAwaitingCode(true);
        return;
      }
      const res = await api.post<{ userCode: string; verificationUri: string; deviceCode: string }>(
        oauth.startPath,
        {}
      );
      setUserCode(res.userCode);
      setVerificationUri(res.verificationUri);
      setDeviceCode(res.deviceCode);
    } catch (e) {
      setOauthError(e instanceof Error ? e.message : "Failed to start OAuth flow");
      setPending(false);
    }
  }, [oauth]);

  const submitCode = useCallback(async () => {
    if (!oauth || !pkceRef.current) return;
    const trimmed = code.trim();
    if (!trimmed) { setOauthError("Paste the authorization code from the provider."); return; }
    setOauthError(null);
    setSubmitting(true);
    try {
      const res = await api.post<{ encryptedToken?: string; isPlaintext?: boolean }>(
        oauth.completePath,
        {
          code: trimmed,
          redirectUri: window.location.origin,
          state: pkceRef.current.state,
          codeVerifier: pkceRef.current.verifier,
        }
      );
      if (res.encryptedToken) {
        onToken(res.encryptedToken);
        reset();
      } else {
        setOauthError("No token returned by the provider.");
        setSubmitting(false);
      }
    } catch (e) {
      setOauthError(e instanceof Error ? e.message : "Failed to exchange authorization code");
      setSubmitting(false);
    }
  }, [oauth, code, onToken, reset]);

  // Poll for completion (device flow only).
  useEffect(() => {
    if (!oauth || oauth.mode !== "device" || !deviceCode) return;
    let active = true;
    const poll = async () => {
      try {
        // Server returns { encryptedToken, isPlaintext } on success
        const res = await api.post<{ encryptedToken?: string; isPlaintext?: boolean; status?: string; [k: string]: unknown }>(
          oauth.completePath,
          { deviceCode }
        );
        if (!active) return;
        // Primary: server sends back encryptedToken (the canonical success shape)
        // Fallback: some providers may still embed the token under tokenField or status=="success"
        const receivedToken = res.encryptedToken ?? (res[oauth.tokenField] as string | undefined);
        if (receivedToken) {
          onToken(receivedToken);
          reset();
        } else {
          setTimeout(poll, 3000);
        }
      } catch {
        if (active) setTimeout(poll, 5000);
      }
    };
    const t = setTimeout(poll, 3000);
    return () => { active = false; clearTimeout(t); };
  }, [oauth, deviceCode, onToken, reset]);

  const cancel = useCallback(() => {
    reset();
  }, [reset]);

  return {
    pending,
    userCode,
    verificationUri,
    oauthError,
    start,
    cancel,
    mode: oauth?.mode ?? "device",
    authorizationUrl,
    awaitingCode,
    code,
    setCode,
    submitCode,
    submitting,
  };
}

function DynamicField({
  field,
  value,
  onChange,
  allValues,
}: {
  field: PluginField;
  value: string;
  onChange: (v: string) => void;
  allValues: Config;
}) {
  // Hidden fields (managed by OAuth flows) are never rendered
  if (field.hidden) return null;

  // If dependsOn is set and condition not met, hide
  if (field.dependsOn) {
    if (allValues[field.dependsOn.field] !== field.dependsOn.value) return null;
  }

  if (field.type === "select") {
    return (
      <Field label={field.label} required={field.required}>
        <FieldSelect value={value} onChange={(e) => onChange(e.currentTarget.value)}>
          {!field.required && <option value="">— select —</option>}
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </FieldSelect>
      </Field>
    );
  }

  if (field.type === "textarea") {
    return (
      <Field label={field.label} required={field.required}>
        <FieldTextarea
          value={value}
          placeholder={field.placeholder ?? ""}
          onChange={(e) => onChange(e.currentTarget.value)}
          style={{ minHeight: "80px" }}
        />
      </Field>
    );
  }

  return (
    <Field label={field.label} required={field.required}>
      <FieldInput
        type={field.type === "password" ? "password" : field.type === "number" ? "number" : "text"}
        value={value}
        placeholder={field.placeholder ?? ""}
        autoComplete={field.type === "password" ? "off" : undefined}
        onChange={(e) => onChange(e.currentTarget.value)}
      />
    </Field>
  );
}

export function IntegrationFormModal({ integration, plugins, onClose, onSaved }: Props) {
  const isEdit = !!integration;

  const [step, setStep] = useState<"pick" | "form">(isEdit ? "form" : "pick");
  const [selectedType, setSelectedType] = useState<string>(integration?.provider ?? "");
  const [name, setName] = useState(integration?.name ?? "");
  const [config, setConfig] = useState<Config>(() => {
    if (integration?.config) {
      try { return integration.config as Config; } catch { /* ignore */ }
    }
    return {};
  });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const plugin = plugins.find((p) => p.provider === selectedType);

  const setConfigField = (key: string, val: string) => {
    setConfig((prev) => ({ ...prev, [key]: val }));
    setTestResult(null);
  };

  const handleOAuthToken = useCallback((token: string) => {
    if (!plugin?.oauth) return;
    setConfigField(plugin.oauth.tokenField, token);
    setTestResult("OAuth connected — token received.");
  }, [plugin]);

  const oauth = useOAuthFlow(plugin?.oauth, handleOAuthToken);

  const showOAuth = plugin?.oauth
    ? !plugin.oauth.dependsOn || config[plugin.oauth.dependsOn.field] === plugin.oauth.dependsOn.value
    : false;

  const handlePickType = (type: string) => {
    // Pre-seed config with default values for select fields so dependsOn
    // conditions evaluate correctly on first render (no toggling required).
    const newPlugin = plugins.find((p) => p.provider === type);
    const defaults: Config = {};
    for (const f of newPlugin?.requiredFields ?? []) {
      if (f.type === "select" && f.options && f.options.length > 0) {
        defaults[f.key] = f.options[0]!.value;
      }
    }
    setSelectedType(type);
    setConfig(defaults);
    setTestResult(null);
    setError(null);
    setStep("form");
  };

  const handleBackToPicker = () => {
    setStep("pick");
    setSelectedType("");
    setConfig({});
    setTestResult(null);
    setError(null);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const payload = { provider: selectedType, name: name || "test", config };
      const body = integration ? { ...payload, integrationId: integration.id } : payload;
      const res = await api.post<{ success: boolean; message?: string; error?: string }>(
        "/api/admin/integrations/test",
        body
      );
      setTestResult(res.success ? (res.message ?? "Connection successful") : (res.error ?? "Test failed"));
    } catch (e) {
      setTestResult(e instanceof Error ? `Error: ${e.message}` : "Test failed");
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!name.trim()) { setError("Integration name is required"); return; }
    setSaving(true);
    setError(null);
    try {
      if (isEdit) {
        await api.put(`/api/admin/integrations/${integration!.id}`, { name, config });
      } else {
        await api.post("/api/admin/integrations", { provider: selectedType, name, config });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (step === "pick") {
    return (
      <Modal
        title="Add Integration"
        sub="Choose the provider type to configure."
        wide
        onClose={onClose}
        footer={
          <button className="btn" onClick={onClose}>Cancel</button>
        }
      >
        <TypePicker plugins={plugins} onSelect={handlePickType} />
      </Modal>
    );
  }

  return (
    <Modal
      title={isEdit ? `Edit — ${integration!.name}` : "Add Integration"}
      sub={plugin ? `Configure ${plugin.name} integration` : undefined}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={handleTest} disabled={testing || saving}>
            {testing ? "Testing…" : <><Icon name="bolt" size={13} /> Test</>}
          </button>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : isEdit ? "Save changes" : "Add integration"}
          </button>
        </>
      }
    >
      <FormRow>
        {!isEdit && plugin && (
          <div
            style={{
              display: "flex", alignItems: "center", gap: "10px",
              padding: "10px 14px",
              background: "var(--panel-2)", border: "1px solid var(--border-soft)",
              borderRadius: "var(--radius-sm)",
            }}
          >
            <ProviderGlyph provider={selectedType} size={34} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "3px" }}>{plugin.name}</div>
              {plugin.domainCapabilities.slice(0, 2).map((cap) => (
                <CapabilityBadge key={cap} capability={cap} />
              ))}
            </div>
            <button
              className="btn ghost"
              onClick={handleBackToPicker}
              style={{ fontSize: "12px", padding: "4px 10px", display: "flex", alignItems: "center", gap: "4px" }}
            >
              <Icon name="chevron" size={13} style={{ transform: "rotate(180deg)" }} />
              Change
            </button>
          </div>
        )}

        <Field label="Name" required>
          <FieldInput
            value={name}
            placeholder={`My ${plugin?.name ?? "integration"}`}
            onChange={(e) => setName(e.currentTarget.value)}
          />
        </Field>

        {/* Regular dynamic fields */}
        {plugin?.requiredFields.filter((f) => !f.advanced && !f.hidden).map((field) => (
          <DynamicField
            key={field.key}
            field={field}
            value={config[field.key] ?? ""}
            onChange={(v) => setConfigField(field.key, v)}
            allValues={config}
          />
        ))}

        {/* Advanced settings (collapsed by default) */}
        {(plugin?.requiredFields.some((f) => f.advanced)) && (
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <button
              type="button"
              className="btn sm"
              onClick={() => setShowAdvanced((p) => !p)}
              style={{ alignSelf: "flex-start", gap: "6px" }}
            >
              <Icon name="config" size={13} />
              Advanced settings
              <Icon name="chevdown" size={12} style={{ transition: "transform 0.15s", transform: showAdvanced ? "rotate(180deg)" : "none" }} />
            </button>
            {showAdvanced && plugin.requiredFields.filter((f) => f.advanced).map((field) => (
              <DynamicField
                key={field.key}
                field={field}
                value={config[field.key] ?? ""}
                onChange={(v) => setConfigField(field.key, v)}
                allValues={config}
              />
            ))}
          </div>
        )}

        {/* OAuth device flow */}
        {showOAuth && plugin?.oauth && (
          <div
            style={{
              padding: "14px 16px",
              background: "var(--panel-2)",
              border: "1px solid var(--border-soft)",
              borderRadius: "var(--radius-sm)",
              display: "flex",
              flexDirection: "column",
              gap: "10px",
            }}
          >
            <div style={{ fontSize: "13px", fontWeight: 600 }}>{plugin.oauth.heading}</div>
            {oauth.userCode ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <div style={{ fontSize: "13px" }}>
                  Visit{" "}
                  <a href={oauth.verificationUri ?? "#"} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                    {oauth.verificationUri}
                  </a>{" "}
                  and enter code:
                </div>
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "20px",
                    fontWeight: 700,
                    letterSpacing: "0.15em",
                    color: "var(--accent)",
                    padding: "8px 12px",
                    background: "var(--panel)",
                    borderRadius: "var(--radius-sm)",
                    display: "inline-block",
                  }}
                >
                  {oauth.userCode}
                </div>
                <div style={{ fontSize: "12.5px", color: "var(--text-dim)" }}>
                  {plugin.oauth.pendingLabel} — waiting for authorisation…
                </div>
                <button className="btn ghost" onClick={oauth.cancel} style={{ alignSelf: "flex-start" }}>
                  Cancel
                </button>
              </div>
            ) : oauth.awaitingCode ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                <div style={{ fontSize: "13px" }}>
                  1. Open the authorization page, sign in, and approve access:
                </div>
                <a
                  href={oauth.authorizationUrl ?? "#"}
                  target="_blank"
                  rel="noreferrer"
                  className="btn secondary"
                  style={{ alignSelf: "flex-start", textDecoration: "none" }}
                >
                  Open Claude authorization page ↗
                </a>
                <div style={{ fontSize: "13px" }}>
                  2. Copy the authorization code shown afterwards and paste it here:
                </div>
                <FieldInput
                  type="text"
                  value={oauth.code}
                  onChange={(e) => oauth.setCode(e.currentTarget.value)}
                  placeholder="Paste authorization code…"
                />
                <div style={{ display: "flex", gap: "8px" }}>
                  <button
                    className="btn secondary"
                    onClick={oauth.submitCode}
                    disabled={oauth.submitting || !oauth.code.trim()}
                  >
                    {oauth.submitting ? "Connecting…" : "Connect"}
                  </button>
                  <button className="btn ghost" onClick={oauth.cancel}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                className="btn secondary"
                onClick={oauth.start}
                disabled={oauth.pending}
                style={{ alignSelf: "flex-start" }}
              >
                {config[plugin.oauth.tokenField] ? plugin.oauth.reconnectLabel : plugin.oauth.connectLabel}
              </button>
            )}
            {oauth.oauthError && <span style={{ fontSize: "12.5px", color: "var(--danger)" }}>{oauth.oauthError}</span>}
          </div>
        )}

        {testResult && (
          <div
            style={{
              fontSize: "12.5px",
              padding: "8px 12px",
              background: testResult.toLowerCase().includes("success") || testResult.toLowerCase().includes("connected")
                ? "var(--ok-soft)"
                : "var(--danger-soft)",
              color: testResult.toLowerCase().includes("success") || testResult.toLowerCase().includes("connected")
                ? "var(--ok)"
                : "var(--danger)",
              borderRadius: "var(--radius-sm)",
            }}
          >
            {testResult}
          </div>
        )}

        <FormError msg={error} />
      </FormRow>
    </Modal>
  );
}
