import { useState } from "react";
import { Icon } from "../../components/Icon.tsx";
import { copyText } from "../../clipboard.ts";

interface Diagnostic {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  redacted: boolean;
  parseError: string | null;
}

function isDiagnostic(value: unknown): value is Diagnostic {
  if (typeof value !== "object" || value === null) return false;
  const data = value as Record<string, unknown>;
  return typeof data["exitCode"] === "number"
    && typeof data["stdout"] === "string" && typeof data["stderr"] === "string"
    && typeof data["stdoutBytes"] === "number" && typeof data["stderrBytes"] === "number"
    && typeof data["stdoutTruncated"] === "boolean" && typeof data["stderrTruncated"] === "boolean"
    && typeof data["redacted"] === "boolean"
    && (data["parseError"] === null || typeof data["parseError"] === "string");
}

export function WorkerDiagnostics({ value, cycleNumber }: { value: unknown; cycleNumber: number }) {
  const [feedback, setFeedback] = useState("");
  if (!isDiagnostic(value)) return null;
  const serialized = JSON.stringify(value, null, 2);

  async function copy(): Promise<void> {
    try {
      await copyText(serialized);
      setFeedback("Copied");
    } catch {
      setFeedback("Copy failed");
    }
  }

  function download(): void {
    let url: string | undefined;
    const link = document.createElement("a");
    try {
      url = URL.createObjectURL(new Blob([serialized], { type: "application/json;charset=utf-8" }));
      link.href = url;
      link.download = `worker-cycle-${cycleNumber}-diagnostics.json`;
      document.body.appendChild(link);
      link.click();
    } catch {
      setFeedback("Download failed");
    } finally {
      link.remove();
      if (url !== undefined) URL.revokeObjectURL(url);
    }
  }

  return (
    <details style={{ marginTop: "20px", minWidth: 0 }}>
      <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: "12px" }}>Worker diagnostics</summary>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "8px", marginTop: "10px", fontSize: "12px" }}>
        <span>Exit code: {value.exitCode}</span>
        <span>{value.redacted ? "Secrets masked" : "Secret filtering applied"}</span>
        <button type="button" className="btn btn-ghost" title="Copy worker diagnostics" aria-label="Copy worker diagnostics" onClick={() => { void copy(); }}>
          <Icon name="layers" size={16} />
        </button>
        <button type="button" className="btn btn-ghost" title="Download worker diagnostics" aria-label="Download worker diagnostics" onClick={download}>
          <Icon name="file" size={16} />
        </button>
        <span role="status">{feedback}</span>
      </div>
      {value.parseError && <p className="mono" style={{ fontSize: "12px", overflowWrap: "anywhere" }}>{value.parseError}</p>}
      {(["stdout", "stderr"] as const).map((stream) => (
        <div key={stream} style={{ minWidth: 0, marginTop: "12px" }}>
          <div className="mono" style={{ fontSize: "12px" }}>
            {stream}: {value[`${stream}Bytes`]} bytes received ({value[`${stream}Truncated`] ? "truncated" : "complete"})
          </div>
          <pre className="mono" style={{
            margin: "8px 0 0", padding: "10px 12px", background: "var(--bg)",
            border: "1px solid var(--border-soft)", borderRadius: "var(--radius-sm)",
            fontSize: "11.5px", lineHeight: 1.6, maxHeight: "320px", overflow: "auto",
            whiteSpace: "pre-wrap", overflowWrap: "anywhere",
          }}>{value[stream] || "(empty)"}</pre>
        </div>
      ))}
    </details>
  );
}