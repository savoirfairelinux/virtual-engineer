import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon.tsx";
import { connectSse, getStoredToken } from "../../api.ts";
import type { AgentLogEvent } from "../../types.ts";
import { TONE } from "../../states.ts";
import type { ToneKey } from "../../states.ts";
import { extractMetrics } from "./liveMetrics.ts";

type StreamEntry = {
  id: number;
  timestamp: string;
  type?: string | undefined;
  category?: string | undefined;
  level?: "info" | "warn" | "error" | "debug" | undefined;
  message?: string | undefined;
  data?: unknown;
};

const LOG_TAG_TONE: Record<string, ToneKey> = {
  CONTEXT_USAGE: "info",
  MODEL_USAGE:   "ok",
  TOOL_CALL:     "info",
  ASSISTANT:     "active",
  SESSION_END:   "danger",
  LOG:           "muted",
  AGENT_COMPLETED: "ok",
  PARSING:       "warn",
  POSTING:       "warn",
  COMPLETED:     "ok",
};

const FILTER_CATS = ["All", "Tools", "Usage", "Errors"] as const;
type FilterCat = typeof FILTER_CATS[number];

function matchesFilter(entry: StreamEntry, filter: FilterCat): boolean {
  if (filter === "All") return true;
  if (filter === "Errors") {
    return entry.level === "error" || entry.type === "SESSION_END" || entry.type === "session.error";
  }
  if (filter === "Tools") {
    return entry.category === "tools" || entry.type === "TOOL_CALL" || entry.type?.startsWith("tool.") === true;
  }
  if (filter === "Usage") {
    return (
      entry.category === "usage" ||
      entry.type === "MODEL_USAGE" ||
      entry.type === "CONTEXT_USAGE" ||
      entry.type === "assistant.usage" ||
      entry.type === "session.usage_info"
    );
  }
  return true;
}

function normalizeIncomingEntry(raw: unknown, id: number): StreamEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const timestamp = typeof obj["timestamp"] === "string" ? obj["timestamp"] : new Date().toISOString();
  const type = typeof obj["type"] === "string" ? obj["type"] : undefined;
  const category = typeof obj["category"] === "string" ? obj["category"] : undefined;
  const level = obj["level"];
  const message = typeof obj["message"] === "string" ? obj["message"] : undefined;
  return {
    id,
    timestamp,
    type,
    category,
    level: level === "info" || level === "warn" || level === "error" || level === "debug" ? level : undefined,
    message,
    data: obj["data"],
  };
}

function renderPayload(entry: StreamEntry): string {
  if (typeof entry.message === "string" && entry.message.trim().length > 0) {
    return entry.message;
  }
  if (entry.data === null || entry.data === undefined) return "";
  if (typeof entry.data === "string") return entry.data;
  if (typeof entry.data === "number" || typeof entry.data === "boolean") return String(entry.data);
  try {
    return JSON.stringify(entry.data, null, 2);
  } catch {
    return String(entry.data);
  }
}

interface LiveLogsProps {
  taskId: string;
  running: boolean;
}

export function LiveLogs({ taskId, running }: LiveLogsProps) {
  const [entries, setEntries] = useState<StreamEntry[]>([]);
  const [filter, setFilter] = useState<FilterCat>("All");
  const scrollRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(0);
  const seenEntryKeys = useRef<Set<string>>(new Set());

  const entryKey = (entry: StreamEntry): string => {
    const parts = [
      entry.timestamp,
      String(entry.type ?? ""),
      String(entry.category ?? ""),
      String(entry.level ?? ""),
      String(entry.message ?? ""),
    ];
    if (entry.data !== undefined) {
      try {
        parts.push(typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data));
      } catch {
        parts.push(String(entry.data));
      }
    }
    return parts.join("|");
  };

  useEffect(() => {
    setEntries([]);
    seenEntryKeys.current = new Set();
    const token = getStoredToken();
    const path = `/api/admin/logs/stream?taskId=${encodeURIComponent(taskId)}${token ? `&t=${token}` : ""}`;
    const cleanup = connectSse(path, (_evType, data) => {
      try {
        const parsed = JSON.parse(data) as AgentLogEvent | Record<string, unknown>;
        const normalized = normalizeIncomingEntry(parsed, nextId.current++);
        if (!normalized) return;
        const key = entryKey(normalized);
        if (seenEntryKeys.current.has(key)) return;
        seenEntryKeys.current.add(key);
        setEntries((prev) => [...prev, normalized]);
        // auto-scroll
        requestAnimationFrame(() => {
          if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
          }
        });
      } catch { /* ignore malformed */ }
    });
    return cleanup;
  }, [taskId]);

  const shown = entries.filter((e) => matchesFilter(e, filter));
  const metrics = extractMetrics(entries);

  const metricRow = [
    { k: "Tool calls",     v: metrics.toolCalls.toLocaleString() },
    { k: "Input tokens",   v: metrics.inputTokens.toLocaleString() },
    { k: "Output tokens",  v: metrics.outputTokens.toLocaleString() },
    { k: "Cache read",     v: metrics.cacheRead.toLocaleString() },
    { k: "Cache write",    v: metrics.cacheWrite.toLocaleString() },
  ];

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* header */}
      <div
        style={{
          display: "flex", alignItems: "center", gap: "10px", padding: "13px 16px",
          borderBottom: "1px solid var(--border-soft)",
        }}
      >
        <Icon name="pulse" size={15} style={{ color: running ? "var(--ok)" : "var(--text-faint)" }} />
        <span style={{ fontSize: "13px", fontWeight: 600 }}>Live logs &amp; metrics</span>
        {running && (
          <span className="pill" style={{ color: "var(--ok)", background: "var(--ok-soft)", borderColor: "color-mix(in oklab,var(--ok) 30%, transparent)" }}>
            <span className="dot live-dot" /> streaming
          </span>
        )}
        <div style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: "10.5px", color: "var(--text-ghost)" }}>SSE · /logs/stream</span>
      </div>

      {/* metric strip */}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${metricRow.length}, 1fr)`, borderBottom: "1px solid var(--border-soft)" }}>
        {metricRow.map((x, i) => (
          <div key={x.k} style={{ padding: "12px 14px", borderRight: i < metricRow.length - 1 ? "1px solid var(--border-soft)" : "none" }}>
            <div className="eyebrow" style={{ marginBottom: "6px", fontSize: "9.5px" }}>{x.k}</div>
            <div className="metric-val" style={{ fontSize: "15px", fontWeight: 600 }}>{x.v}</div>
          </div>
        ))}
      </div>

      {/* filter chips */}
      <div style={{ display: "flex", gap: "6px", padding: "10px 14px", borderBottom: "1px solid var(--border-soft)" }}>
        {FILTER_CATS.map((cat) => (
          <button
            key={cat}
            onClick={() => setFilter(cat)}
            className="mono"
            style={{
              border: `1px solid ${filter === cat ? "var(--accent-line)" : "var(--border-soft)"}`,
              background: filter === cat ? "var(--accent-soft)" : "transparent",
              color: filter === cat ? "var(--accent-strong)" : "var(--text-faint)",
              fontSize: "11px", padding: "3px 11px", borderRadius: "99px",
              cursor: "pointer", transition: "all 0.13s var(--ease)",
            }}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* log feed */}
      <div ref={scrollRef} style={{ maxHeight: "320px", overflowY: "auto" }}>
        {shown.length === 0 && !running && (
          <div style={{ padding: "24px 16px", color: "var(--text-ghost)", fontSize: "12.5px" }}>
            No log entries to show.
          </div>
        )}
        {shown.map((entry) => {
          const tagTone = LOG_TAG_TONE[entry.type ?? ""] ?? (entry.level === "error" ? "danger" : "muted");
          const t = TONE[tagTone];
          const payload = renderPayload(entry);
          const payloadLooksJson = payload.startsWith("{") || payload.startsWith("[");
          return (
            <div
              key={entry.id}
              style={{
                display: "flex", gap: "12px", alignItems: "flex-start",
                padding: "8px 16px", borderBottom: "1px solid var(--border-soft)", fontSize: "12px",
              }}
            >
              <span className="mono" style={{ color: "var(--text-ghost)", flex: "none", fontSize: "11px", paddingTop: "1px" }}>
                {new Date(entry.timestamp).toLocaleTimeString()}
              </span>
              <span
                className="mono"
                style={{
                  flex: "none", fontSize: "9.5px", fontWeight: 600, letterSpacing: "0.03em",
                  padding: "2px 6px", borderRadius: "5px",
                  color: t.c, background: t.bg, minWidth: "130px", textAlign: "center",
                }}
              >
                {entry.type ?? entry.level ?? "LOG"}
              </span>
              {payloadLooksJson ? (
                <pre
                  className="mono"
                  style={{
                    margin: 0,
                    color: "var(--text-dim)",
                    lineHeight: 1.45,
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                    fontSize: "11px",
                  }}
                >
                  {payload}
                </pre>
              ) : (
                <span className="mono" style={{ color: "var(--text-dim)", lineHeight: 1.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {payload}
                </span>
              )}
            </div>
          );
        })}
        {running && (
          <div style={{ display: "flex", gap: "12px", alignItems: "center", padding: "9px 16px", fontSize: "12px" }}>
            <span className="mono" style={{ color: "var(--text-ghost)", fontSize: "11px" }}>now</span>
            <span className="live-dot" style={{ width: 7, height: 7, borderRadius: 99, background: "var(--accent-strong)" }} />
            <span className="mono" style={{ color: "var(--text-faint)" }}>waiting for agent output…</span>
          </div>
        )}
      </div>
    </div>
  );
}
