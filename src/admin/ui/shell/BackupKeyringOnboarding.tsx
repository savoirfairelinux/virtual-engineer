import { useEffect, useState, type CSSProperties } from "react";
import { api } from "../api.ts";

interface BackupKeyringFileContent {
  format: "virtual-engineer-backup-keyring";
  version: 1;
  activeKeyId: string;
  keys: Record<string, string>;
}

interface PendingSecuritySecrets {
  adminAuthSecret?: string;
  backupKeyring?: BackupKeyringFileContent;
}

type OnboardingStatus = "loading" | "hidden" | "pending" | "revealed" | "error";
type OnboardingStatusResponse = { pending: boolean };
type RevealResponse = { pending: false } | { pending: true; secrets: PendingSecuritySecrets };

const ONBOARDING_PATH = "/api/admin/security/secrets-onboarding";
const readonlyTextBoxStyle: CSSProperties = {
  width: "100%", boxSizing: "border-box", minHeight: 42, maxHeight: 240,
  overflowY: "auto", padding: "10px 12px",
  border: "1px solid var(--border)", borderRadius: "var(--radius-sm)",
  background: "var(--panel-2)", color: "var(--text)",
  fontFamily: "var(--font-mono)", fontSize: "12px", lineHeight: 1.5,
  whiteSpace: "pre-wrap", overflowWrap: "anywhere", cursor: "text", userSelect: "text",
};

export function SecuritySecretsOnboarding() {
  const [retryToken, setRetryToken] = useState(0);
  const [status, setStatus] = useState<OnboardingStatus>("loading");
  const [secrets, setSecrets] = useState<PendingSecuritySecrets | null>(null);
  const [adminSecretSaved, setAdminSecretSaved] = useState(false);
  const [keyringSaved, setKeyringSaved] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setStatus("loading");
    setSecrets(null);
    setAdminSecretSaved(false);
    setKeyringSaved(false);
    setMessage(null);
    void api.get<OnboardingStatusResponse>(ONBOARDING_PATH)
      .then((response) => {
        if (current) setStatus(response.pending ? "pending" : "hidden");
      })
      .catch((error: unknown) => {
        if (!current) return;
        setMessage(error instanceof Error ? error.message : "Could not check setup secrets.");
        setStatus("error");
      });
    return () => { current = false; };
  }, [retryToken]);

  async function revealSecrets(): Promise<void> {
    setRevealing(true);
    setMessage(null);
    try {
      const response = await api.post<RevealResponse>(`${ONBOARDING_PATH}/reveal`);
      if (!response.pending || (!response.secrets.adminAuthSecret && !response.secrets.backupKeyring)) {
        setStatus("hidden");
        return;
      }
      setSecrets(response.secrets);
      setAdminSecretSaved(false);
      setKeyringSaved(false);
      setStatus("revealed");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not reveal setup secrets.");
    } finally {
      setRevealing(false);
    }
  }

  async function copyAdminSecret(): Promise<void> {
    if (!secrets?.adminAuthSecret) return;
    try {
      await navigator.clipboard.writeText(secrets.adminAuthSecret);
      setAdminSecretSaved(true);
      setMessage("ADMIN_AUTH_SECRET copied. Store it in a protected location.");
    } catch {
      setMessage("Clipboard access failed. Select and copy the ADMIN_AUTH_SECRET text or try copying again.");
    }
  }

  async function copyKeyring(): Promise<void> {
    if (!secrets?.backupKeyring) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(secrets.backupKeyring, null, 2));
      setKeyringSaved(true);
      setMessage("Backup keyring copied. Store it in a protected location.");
    } catch {
      setMessage("Clipboard access failed. Select and copy the keyring text or download the file instead.");
    }
  }

  function downloadKeyring(): void {
    if (!secrets?.backupKeyring) return;
    const blob = new Blob([`${JSON.stringify(secrets.backupKeyring, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "backup-keyring.json";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setKeyringSaved(true);
    setMessage("Backup keyring downloaded. Store it in a protected location.");
  }

  async function acknowledgeSecrets(): Promise<void> {
    setSaving(true);
    setMessage(null);
    try {
      await api.post(`${ONBOARDING_PATH}/acknowledge`);
      setSecrets(null);
      setStatus("hidden");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not acknowledge the saved secrets.");
    } finally {
      setSaving(false);
    }
  }

  if (status === "loading" || status === "hidden") return null;

  if (status === "error") {
    return (
      <div
        role="alert"
        style={{
          position: "fixed", right: 16, bottom: 16, zIndex: 3000,
          maxWidth: 420, padding: 16, border: "1px solid var(--warn)",
          borderRadius: "var(--radius-sm)", background: "var(--panel)", color: "var(--text)",
        }}
      >
        <p style={{ margin: "0 0 12px" }}>Could not check setup secrets: {message}</p>
        <button className="btn ghost" onClick={() => setRetryToken((token) => token + 1)}>Retry</button>
      </div>
    );
  }

  const hasAdminSecret = Boolean(secrets?.adminAuthSecret);
  const hasKeyring = Boolean(secrets?.backupKeyring);
  const allSecretsSaved = (!hasAdminSecret || adminSecretSaved) && (!hasKeyring || keyringSaved);
  const keyringJson = secrets?.backupKeyring ? JSON.stringify(secrets.backupKeyring, null, 2) : "";

  return (
    <div className="modal-scrim">
      <section
        className="modal"
        style={{ maxWidth: 720, maxHeight: "calc(100vh - 32px)", display: "flex", flexDirection: "column" }}
        role="dialog"
        aria-modal="true"
        aria-label="Save your Virtual Engineer setup secrets"
        aria-labelledby="security-secrets-title"
      >
        <header className="modal-head">
          <div className="titles">
            <h2 id="security-secrets-title" className="modal-title">Save your Virtual Engineer setup secrets</h2>
            <p className="modal-sub">These values are shown only during this first-admin setup.</p>
          </div>
        </header>
        <div className="modal-body" style={{ overflowY: "auto" }}>
          <p style={{ marginTop: 0 }}>
            These values protect different things and are not interchangeable. Keep protected copies: changing
            {" "}<code>ADMIN_AUTH_SECRET</code> breaks access to stored credentials and backup-manifest verification;
            removing a key from the keyring makes archives encrypted with it undecryptable.
          </p>
          <div
            role="note"
            style={{
              marginBottom: 16, padding: "12px 14px", border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)", background: "var(--panel-2)",
              color: "var(--text-dim)", fontSize: "12.5px", lineHeight: 1.55, overflowWrap: "anywhere",
            }}
          >
            <strong style={{ display: "block", color: "var(--text)", marginBottom: 4 }}>
              What each value protects, where it is stored, and how to change it
            </strong>
            <p style={{ margin: "0 0 8px" }}>
              <code>ADMIN_AUTH_SECRET</code> encrypts stored provider credentials and generated SSH private keys. It
              also authenticates backup manifests and is not the admin login password. <code>ADMIN_AUTH_SECRET</code>{" "}
              is in the project <code>.env</code>. You can change it there on a fresh instance before saving
              credentials or creating backups, then recreate <code>ve-orchestrator</code>. After that, keep the
              original: changing it makes stored credentials undecryptable and prevents verifying backups made with
              the old secret. In-place rotation is not supported.
            </p>
            <p style={{ margin: "0 0 8px" }}>
              <code>BACKUP_KEYRING_FILE</code> is a path, not a secret key. Its setting in <code>.env</code> points to
              the keyring file (default:{" "}
              <code>{'${XDG_CONFIG_HOME:-$HOME/.config}/virtual-engineer/backup-keyring.json'}</code>). To move it,
              update that path and recreate the container. The file's <code>keys</code> map contains the actual
              {" "}<code>AES-256-GCM</code> archive-encryption keys; <code>activeKeyId</code> selects the key used for
              new archives. To rotate, add a new key, set <code>activeKeyId</code> to it, and keep old keys for existing
              archives; see README → Backups and recovery → Rotate the key.
            </p>
            <p style={{ margin: 0 }}>
              After you click Reveal, the server sends the values to this browser as plaintext JSON, and the UI holds
              them in page memory while this dialog is open. <code>no-store</code> prevents caching; it does not
              encrypt the connection. The Admin server itself uses HTTP, so only reveal over a trusted local
              connection or through a trusted HTTPS proxy for remote access. Avoid screenshots and clear the clipboard
              after copying.
            </p>
          </div>
          {status === "pending" && (
            <button className="btn primary" disabled={revealing} onClick={() => void revealSecrets()}>
              {revealing ? "Revealing…" : "Reveal setup secrets"}
            </button>
          )}
          {hasAdminSecret && (
            <div style={{ marginTop: 18 }}>
              <div id="admin-auth-secret-label" style={{ display: "block", marginBottom: 6, fontWeight: 600 }}>
                ADMIN_AUTH_SECRET
              </div>
              <div
                id="admin-auth-secret"
                role="textbox"
                aria-labelledby="admin-auth-secret-label"
                aria-readonly="true"
                tabIndex={0}
                onCopy={() => setAdminSecretSaved(true)}
                style={readonlyTextBoxStyle}
              >
                {secrets?.adminAuthSecret ?? ""}
              </div>
              <div className="form-actions" style={{ justifyContent: "flex-start", marginTop: 8 }}>
                <button className="btn ghost" onClick={() => void copyAdminSecret()}>Copy ADMIN_AUTH_SECRET</button>
              </div>
            </div>
          )}
          {hasKeyring && (
            <div style={{ marginTop: 18 }}>
              <div id="backup-keyring-json-label" style={{ display: "block", marginBottom: 6, fontWeight: 600 }}>
                Backup keyring JSON
              </div>
              <div
                id="backup-keyring-json"
                role="textbox"
                aria-labelledby="backup-keyring-json-label"
                aria-readonly="true"
                tabIndex={0}
                onCopy={() => setKeyringSaved(true)}
                style={readonlyTextBoxStyle}
              >
                {keyringJson}
              </div>
              <div className="form-actions" style={{ justifyContent: "flex-start", marginTop: 8 }}>
                <button className="btn ghost" onClick={() => void copyKeyring()}>Copy keyring JSON</button>
                <button className="btn ghost" onClick={downloadKeyring}>Download keyring JSON</button>
              </div>
            </div>
          )}
          {message && <p role="status" style={{ margin: "8px 0 0", color: "var(--text-dim)" }}>{message}</p>}
        </div>
        {status === "revealed" && (
          <footer className="modal-foot">
            <button className="btn primary" disabled={!allSecretsSaved || saving} onClick={() => void acknowledgeSecrets()}>
              {saving ? "Saving…" : "I've saved both secrets securely"}
            </button>
          </footer>
        )}
      </section>
    </div>
  );
}