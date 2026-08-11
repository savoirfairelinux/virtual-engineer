export const LIVE_LOG_WINDOW_MAX = 500;

export interface LiveLogEntry {
  id: number;
  timestamp: string;
  type?: string | undefined;
  category?: string | undefined;
  level?: "info" | "warn" | "error" | "debug" | undefined;
  message?: string | undefined;
  data?: unknown;
}

export interface LiveLogWindow {
  entries: LiveLogEntry[];
  seenEntryKeys: Set<string>;
}

export function createLiveLogWindow(): LiveLogWindow {
  return { entries: [], seenEntryKeys: new Set() };
}

export function liveLogEntryKey(entry: LiveLogEntry): string {
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
}

export function appendLiveLogEntry(
  window: LiveLogWindow,
  entry: LiveLogEntry,
): LiveLogWindow {
  const key = liveLogEntryKey(entry);
  if (window.seenEntryKeys.has(key)) return window;

  const seenEntryKeys = new Set(window.seenEntryKeys);
  seenEntryKeys.add(key);
  const entries = [...window.entries, entry];
  if (entries.length <= LIVE_LOG_WINDOW_MAX) return { entries, seenEntryKeys };

  const evicted = entries.slice(0, entries.length - LIVE_LOG_WINDOW_MAX);
  for (const oldEntry of evicted) seenEntryKeys.delete(liveLogEntryKey(oldEntry));
  return { entries: entries.slice(-LIVE_LOG_WINDOW_MAX), seenEntryKeys };
}