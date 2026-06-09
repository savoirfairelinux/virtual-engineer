import { useState } from "react";
import { Icon } from "../components/Icon.tsx";
import { deriveToken, storeToken } from "../api.ts";

interface AuthScreenProps {
  authMode: "bearer" | "hmac" | "mixed";
  onAuthenticated: () => void;
}

export function AuthScreen({ authMode, onAuthenticated }: AuthScreenProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!value.trim()) return;
    setLoading(true);
    setError(null);
    try {
      let token: string;
      if (authMode === "hmac" || authMode === "mixed") {
        token = await deriveToken(value.trim());
      } else {
        token = value.trim();
      }
      storeToken(token);
      // Verify token by calling a protected endpoint
      const res = await fetch("/api/admin/status", {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setError("Invalid secret — access denied.");
        storeToken("");
      } else {
        onAuthenticated();
      }
    } catch {
      setError("Network error — could not reach the server.");
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

        <div style={{ marginBottom: "20px", color: "var(--text-dim)", fontSize: "13.5px" }}>
          Enter your <code style={{ fontFamily: "var(--font-mono)", fontSize: "12px" }}>ADMIN_AUTH_SECRET</code> to unlock the dashboard.
        </div>

        <form onSubmit={(e) => void handleSubmit(e)}>
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Auth secret…"
            autoFocus
            style={{
              width: "100%", marginBottom: "12px",
              background: "var(--panel-2)", border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)", color: "var(--text)",
              fontFamily: "var(--font-mono)", fontSize: "13px",
              padding: "9px 12px", outline: "none",
            }}
          />

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
            disabled={loading || !value.trim()}
            className="btn primary"
            style={{ width: "100%", justifyContent: "center" }}
          >
            {loading ? "Verifying…" : "Unlock dashboard"}
          </button>
        </form>
      </div>
    </div>
  );
}
