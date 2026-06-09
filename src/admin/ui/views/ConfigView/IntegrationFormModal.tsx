import { useEffect, useState, useCallback } from "react";
import { Modal, Field, FieldInput, FieldSelect, FormError, FormRow, FieldTextarea } from "../../components/Modal.tsx";
import { Icon } from "../../components/Icon.tsx";
import { api } from "../../api.ts";
import type { ApiIntegration, ApiPlugin, ApiPluginOAuth, PluginField } from "../../types.ts";

interface Props {
  integration?: ApiIntegration | undefined;
  plugins: ApiPlugin[];
  onClose: () => void;
  onSaved: () => void;
}

type Config = Record<string, string>;
type UiTheme = "dark" | "light";

// ─── Brand SVGs (vendored files under icons/brands/) ───────────────────────
const BRAND_SVG_FILES = import.meta.glob("../../icons/brands/*.svg", {
  eager: true,
  import: "default",
}) as Record<string, string>;

const BRAND_SVG_URLS: Record<string, string> = Object.fromEntries(
  Object.entries(BRAND_SVG_FILES).map(([filePath, src]) => {
    const name = (filePath.split("/").pop() ?? "mock.svg").replace(/\.svg$/, "");
    return [name, src];
  })
);

const DARK_THEME_INVERT: ReadonlySet<string> = new Set(["github", "mock"]);
const LIGHT_THEME_INVERT: ReadonlySet<string> = new Set(["copilot", "gerrit"]);

function getUiTheme(): UiTheme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.dataset["theme"] === "light" ? "light" : "dark";
}

function useUiTheme(): UiTheme {
  const [theme, setTheme] = useState<UiTheme>(() => getUiTheme());

  useEffect(() => {
    const root = document.documentElement;
    const syncTheme = () => setTheme(root.dataset["theme"] === "light" ? "light" : "dark");
    syncTheme();

    const observer = new MutationObserver(syncTheme);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  return theme;
}

const TYPE_TO_BRAND: Record<string, string> = {
  "github-issue":         "github",
  "github-pull-request":  "github",
  "gitlab-issue":         "gitlab",
  "gitlab-merge-request": "gitlab",
  gerrit:                 "gerrit",
  redmine:                "redmine",
  copilot:                "copilot",
  mock:                   "mock",
};

const CAT_COLORS: Record<string, { bg: string; color: string }> = {
  ticketing: { bg: "var(--info-soft)",   color: "var(--info)" },
  review:    { bg: "var(--warn-soft)",   color: "var(--warn)" },
  agent:     { bg: "var(--accent-soft)", color: "var(--accent)" },
};

function ProviderLogo({ type, size = 48, theme }: { type: string; size?: number; theme: UiTheme }) {
  const brandKey = TYPE_TO_BRAND[type] ?? "mock";
  const src = BRAND_SVG_URLS[brandKey] ?? BRAND_SVG_URLS["mock"] ?? "";
  const glyphSize = Math.round(size * 0.8);
  const shouldInvert =
    (theme === "dark" && DARK_THEME_INVERT.has(brandKey))
    || (theme === "light" && LIGHT_THEME_INVERT.has(brandKey));

  return (
    <span
      style={{
        width: size, height: size, flexShrink: 0,
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        lineHeight: 0,
      }}
    >
      <img
        src={src}
        alt=""
        aria-hidden="true"
        width={glyphSize}
        height={glyphSize}
        style={{
          display: "block",
          width: `${glyphSize}px`,
          height: `${glyphSize}px`,
          objectFit: "contain",
          filter: shouldInvert ? "invert(1)" : "none",
        }}
      />
    </span>
  );
}

function CategoryBadge({ category }: { category: string }) {
  const c = CAT_COLORS[category] ?? CAT_COLORS["agent"]!;
  return (
    <span
      style={{
        fontSize: "10.5px", fontWeight: 600, letterSpacing: "0.04em",
        padding: "2px 8px", borderRadius: "99px",
        background: c.bg, color: c.color, textTransform: "uppercase",
      }}
    >
      {category}
    </span>
  );
}

function TypePicker({ plugins, onSelect, theme }: { plugins: ApiPlugin[]; onSelect: (type: string) => void; theme: UiTheme }) {
  const [hovered, setHovered] = useState<string | null>(null);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "10px", padding: "4px 0 8px" }}>
      {plugins.map((p) => {
        const active = hovered === p.type;
        return (
          <button
            key={p.type}
            onClick={() => onSelect(p.type)}
            onMouseEnter={() => setHovered(p.type)}
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
            <ProviderLogo type={p.type} size={48} theme={theme} />
            <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--text)" }}>{p.name}</span>
            <CategoryBadge category={p.category} />
          </button>
        );
      })}
    </div>
  );
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

  const start = useCallback(async () => {
    if (!oauth) return;
    setOauthError(null);
    setPending(true);
    try {
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

  // Poll for completion
  useEffect(() => {
    if (!oauth || !deviceCode) return;
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
          setPending(false);
          setUserCode(null);
          setVerificationUri(null);
          setDeviceCode(null);
        } else {
          setTimeout(poll, 3000);
        }
      } catch {
        if (active) setTimeout(poll, 5000);
      }
    };
    const t = setTimeout(poll, 3000);
    return () => { active = false; clearTimeout(t); };
  }, [oauth, deviceCode, onToken]);

  const cancel = useCallback(() => {
    setPending(false);
    setUserCode(null);
    setVerificationUri(null);
    setDeviceCode(null);
  }, []);

  return { pending, userCode, verificationUri, oauthError, start, cancel };
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
  const theme = useUiTheme();

  const [step, setStep] = useState<"pick" | "form">(isEdit ? "form" : "pick");
  const [selectedType, setSelectedType] = useState<string>(integration?.type ?? "");
  const [name, setName] = useState(integration?.name ?? "");
  const [config, setConfig] = useState<Config>(() => {
    if (integration?.configJson) {
      try { return JSON.parse(integration.configJson) as Config; } catch { /* ignore */ }
    }
    return {};
  });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const plugin = plugins.find((p) => p.type === selectedType);

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
    const newPlugin = plugins.find((p) => p.type === type);
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
      const payload = { type: selectedType, name: name || "test", config };
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
        await api.post("/api/admin/integrations", { type: selectedType, name, config });
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
        <TypePicker plugins={plugins} onSelect={handlePickType} theme={theme} />
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
            <ProviderLogo type={selectedType} size={34} theme={theme} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "3px" }}>{plugin.name}</div>
              <CategoryBadge category={plugin.category} />
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
