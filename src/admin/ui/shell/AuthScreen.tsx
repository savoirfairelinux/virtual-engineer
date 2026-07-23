import { useEffect, useState } from "react";
import { Icon } from "../components/Icon.tsx";
import { PasswordField } from "../components/PasswordField.tsx";
import { fetchSetupStatus, login, setup, ApiError } from "../api.ts";
import type { ApiMe } from "../types.ts";

type StrengthLevel = 0 | 1 | 2 | 3;
interface StrengthInfo { level: StrengthLevel; label: string; color: string }

function measureStrength(pwd: string): StrengthInfo {
  if (pwd.length === 0) return { level: 0, label: "", color: "" };
  if (pwd.length < 8)   return { level: 0, label: "Too short", color: "#e05252" };
  let classes = 0;
  if (/[a-z]/.test(pwd)) classes++;
  if (/[A-Z]/.test(pwd)) classes++;
  if (/[0-9]/.test(pwd)) classes++;
  if (/[^a-zA-Z0-9]/.test(pwd)) classes++;
  if (classes <= 1)                                            return { level: 0, label: "Weak",        color: "#e05252" };
  if (classes === 4)                                           return { level: 3, label: "Very strong",  color: "#4caf82" };
  if (classes === 3 || (classes === 2 && pwd.length >= 16))   return { level: 2, label: "Strong",       color: "#7ec86e" };
  return                                                              { level: 1, label: "Fair",         color: "#e0a840" };
}

interface AuthScreenProps {
  onAuthenticated: (user: ApiMe) => void;
}

type Mode = "loading" | "login" | "setup";

const inputStyle: React.CSSProperties = {
  width: "100%", marginBottom: "12px",
  background: "var(--panel-2)", border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)", color: "var(--text)",
  fontFamily: "var(--font-mono)", fontSize: "13px",
  padding: "9px 12px", outline: "none",
};

export function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  const [mode, setMode] = useState<Mode>("loading");
  const [credentialEncryptionConfigured, setCredentialEncryptionConfigured] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchSetupStatus()
      .then((status) => {
        if (!cancelled) {
          setCredentialEncryptionConfigured(status.credentialEncryptionConfigured);
          setMode(status.needsSetup ? "setup" : "login");
        }
      })
      .catch(() => { if (!cancelled) setMode("login"); });
    return () => { cancelled = true; };
  }, []);

  const canSubmit = mode === "login"
    ? username.trim().length > 0 && password.length > 0
    : true; // setup: always submittable — validation errors shown inline on submit

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setError(null);

    if (mode === "setup") {
      if (!username.trim()) { setError("Username is required."); return; }
      if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
      if (measureStrength(password).level === 0) { setError("Password is too weak — mix uppercase letters, numbers, or symbols."); return; }
      if (!confirm) { setError("Please confirm your password."); return; }
      if (password !== confirm) { setError("Passwords do not match."); return; }
    }

    setLoading(true);
    try {
      const user = mode === "setup"
        ? await setup(username.trim(), password)
        : await login(username.trim(), password);
      onAuthenticated(user);
    } catch (err) {
      if (err instanceof ApiError) {
        if (mode === "login" && err.status === 401) {
          setError("Invalid credentials.");
        } else {
          setError(err.message);
        }
      } else {
        setError("Network error — could not reach the server.");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        flex: 1, minHeight: 0, display: "flex", alignItems: "flex-start", justifyContent: "center",
        padding: "clamp(16px, 6vh, 64px) clamp(12px, 4vw, 28px)",
        background: "var(--bg)", overflowY: "auto",
      }}
    >
      <div
        className="card"
        style={{
          width: "100%", maxWidth: mode === "setup" ? "560px" : "400px",
          margin: "auto", padding: "clamp(24px, 5vw, 32px) clamp(20px, 5vw, 28px)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "24px" }}>
          <span
            style={{
              width: 36, height: 36, borderRadius: "10px", display: "grid", placeItems: "center",
              background: "var(--accent)", color: "white",
            }}
          >
            <Icon name="spark" size={20} />
          </span>
          <div>
            <div style={{ fontWeight: 700, fontSize: "16px" }}>Virtual Engineer</div>
            <div style={{ fontSize: "12px", color: "var(--text-faint)" }}>Admin Dashboard</div>
          </div>
        </div>

        {mode === "loading" && (
          <div style={{ color: "var(--text-faint)", fontSize: "13.5px", textAlign: "center", padding: "12px 0" }}>
            Loading…
          </div>
        )}

        {mode !== "loading" && (
          <>
            <div style={{ marginBottom: "20px", color: "var(--text-dim)", fontSize: "13.5px" }}>
              {mode === "setup" ? (
                <>No users exist yet. Create the first admin account to get started.</>
              ) : (
                <>Sign in with your username and password.</>
              )}
            </div>

            {mode === "setup" && !credentialEncryptionConfigured && (
              <div
                role="status"
                style={{
                  marginBottom: "20px", padding: "14px 16px",
                  background: "var(--warn-soft)",
                  borderLeft: "3px solid var(--warn)",
                  borderRadius: "var(--radius-sm)", color: "var(--text-dim)",
                  fontSize: "12.5px", lineHeight: 1.55, overflowWrap: "anywhere",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--text)", fontWeight: 700, marginBottom: "6px" }}>
                  <Icon name="alert" size={15} style={{ color: "var(--warn)", flex: "none" }} />
                  Credential encryption is not configured
                </div>
                <div style={{ marginBottom: "8px" }}>
                  <code>ADMIN_AUTH_SECRET</code> encrypts provider credentials at rest. Without it, credential-backed
                  integrations, OAuth, generated SSH keys, and related agent or review workflows are unavailable.
                </div>
                <div style={{ marginBottom: "8px" }}>
                  For production, generate it with <code>openssl rand -hex 32</code>, add
                  {" "}<code>ADMIN_AUTH_SECRET=&lt;generated value&gt;</code> to <code>.env</code>, then run
                  {" "}<code>docker rm -f ve-orchestrator &amp;&amp; ./scripts/start.sh</code>.
                </div>
                <strong>Keep this value safe and unchanged; existing credentials require the original secret.</strong>
              </div>
            )}

            <form onSubmit={(e) => void handleSubmit(e)}>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Username…"
                autoComplete="username"
                autoFocus={mode === "login"}
                style={inputStyle}
              />
              <PasswordField
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === "setup" ? "Password (min. 8 characters)…" : "Password…"}
                autoComplete={mode === "setup" ? "new-password" : "current-password"}
                style={{ ...inputStyle, marginBottom: mode === "setup" ? "6px" : "12px" }}
              />
              {mode === "setup" && (() => {
                const s = measureStrength(password);
                if (!s.label) return null;
                const segments = [0, 1, 2, 3] as const;
                return (
                  <div style={{ marginBottom: "12px" }}>
                    <div style={{ display: "flex", gap: "4px", marginBottom: "4px" }}>
                      {segments.map((i) => (
                        <div key={i} style={{
                          flex: 1, height: "3px", borderRadius: "2px",
                          background: i <= s.level ? s.color : "var(--border)",
                          transition: "background 0.2s",
                        }} />
                      ))}
                    </div>
                    <div style={{ fontSize: "11.5px", color: s.color }}>{s.label}</div>
                  </div>
                );
              })()}
              {mode === "setup" && (
                <PasswordField
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Confirm password…"
                  autoComplete="new-password"
                  style={inputStyle}
                />
              )}

              {error && (
                <div
                  style={{
                    fontSize: "12.5px", color: "var(--danger)", marginBottom: "12px",
                    display: "flex", alignItems: "center", gap: "6px",
                  }}
                >
                  <Icon name="alert" size={13} style={{ flex: "none" }} />
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading || !canSubmit}
                className="btn primary"
                style={{ width: "100%", justifyContent: "center" }}
              >
                {loading
                  ? (mode === "setup" ? "Creating…" : "Signing in…")
                  : (mode === "setup" ? "Create first admin" : "Sign in")}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
