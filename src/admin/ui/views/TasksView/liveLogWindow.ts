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
  /** Older entries that are not shown: evicted from the window or left out of the server replay. */
  omitted: number;
}

export function createLiveLogWindow(omitted = 0): LiveLogWindow {
  return { entries: [], seenEntryKeys: new Set(), omitted };
}

/**
 * Apply the replay details a log stream announces on (re)connection. A stream
 * resumed after the last received entry continues the current window; any
 * other connection replays the latest history, so the window starts over and
 * records how many older entries the server left out.
 */
export function startLiveLogReplay(window: LiveLogWindow, replay: unknown): LiveLogWindow {
  const details = replay !== null && typeof replay === "object" ? replay as Record<string, unknown> : {};
  if (details["resumed"] === true) return window;
  const omitted = details["omitted"];
  return createLiveLogWindow(typeof omitted === "number" && Number.isFinite(omitted) && omitted > 0 ? Math.floor(omitted) : 0);
}

/**
 * Apply one stream entry. A `stream.connected` announcement only carries replay
 * details and never takes a row: as a row it would count as omitted after a
 * full replay and evict a real entry on every resumed reconnect.
 */
export function receiveLiveLogEntry(window: LiveLogWindow, entry: LiveLogEntry): LiveLogWindow {
  return entry.type === "stream.connected"
    ? startLiveLogReplay(window, entry.data)
    : appendLiveLogEntry(window, entry);
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
  if (entries.length <= LIVE_LOG_WINDOW_MAX) return { entries, seenEntryKeys, omitted: window.omitted };

  const evicted = entries.slice(0, entries.length - LIVE_LOG_WINDOW_MAX);
  for (const oldEntry of evicted) seenEntryKeys.delete(liveLogEntryKey(oldEntry));
  return {
    entries: entries.slice(-LIVE_LOG_WINDOW_MAX),
    seenEntryKeys,
    omitted: window.omitted + evicted.length,
  };
}