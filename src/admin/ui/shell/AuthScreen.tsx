import { useEffect, useState } from "react";
import { Icon } from "../components/Icon.tsx";
import { fetchSetupStatus, login, setup, ApiError } from "../api.ts";
import type { ApiMe } from "../types.ts";

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
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchSetupStatus()
      .then((s) => { if (!cancelled) setMode(s.needsSetup ? "setup" : "login"); })
      .catch(() => { if (!cancelled) setMode("login"); });
    return () => { cancelled = true; };
  }, []);

  const canSubmit = mode === "setup"
    ? secret.trim().length > 0 && username.trim().length > 0 && password.length >= 8 && confirm.length > 0
    : username.trim().length > 0 && password.length > 0;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || loading) return;
    setError(null);

    if (mode === "setup" && password !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);
    try {
      const user = mode === "setup"
        ? await setup(secret.trim(), username.trim(), password)
        : await login(username.trim(), password);
      onAuthenticated(user);
    } catch (err) {
      if (err instanceof ApiError) {
        if (mode === "login" && err.status === 401) {
          setError("Invalid credentials.");
        } else if (mode === "setup" && err.status === 401) {
          setError("Invalid ADMIN_AUTH_SECRET — access denied.");
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
        flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
        background: "var(--bg)",
      }}
    >
      <div
        className="card"
        style={{ width: "100%", maxWidth: "400px", padding: "32px 28px" }}
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
                <>No users exist yet. Enter the <code style={{ fontFamily: "var(--font-mono)", fontSize: "12px" }}>ADMIN_AUTH_SECRET</code> to create the first admin account.</>
              ) : (
                <>Sign in with your username and password.</>
              )}
            </div>

            <form onSubmit={(e) => void handleSubmit(e)}>
              {mode === "setup" && (
                <input
                  type="password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder="ADMIN_AUTH_SECRET…"
                  autoFocus
                  style={inputStyle}
                />
              )}
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Username…"
                autoComplete="username"
                autoFocus={mode === "login"}
                style={inputStyle}
              />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === "setup" ? "Password (min 8 characters)…" : "Password…"}
                autoComplete={mode === "setup" ? "new-password" : "current-password"}
                style={inputStyle}
              />
              {mode === "setup" && (
                <input
                  type="password"
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
