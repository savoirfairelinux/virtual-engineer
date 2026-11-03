import { describe, expect, it } from "vitest";
import {
  appendLiveLogEntry,
  createLiveLogWindow,
  liveLogEntryKey,
  startLiveLogReplay,
  type LiveLogEntry,
} from "../../src/admin/ui/views/TasksView/liveLogWindow.js";

function entry(id: number): LiveLogEntry {
  return {
    id,
    timestamp: new Date(id * 1_000).toISOString(),
    type: "LOG",
    message: `entry-${id}`,
  };
}

describe("live log window", () => {
  it("keeps only the latest 500 entries and matching deduplication keys", () => {
    let window = createLiveLogWindow();

    for (let id = 0; id < 505; id++) {
      window = appendLiveLogEntry(window, entry(id));
    }

    expect(window.entries).toHaveLength(500);
    expect(window.entries[0]?.id).toBe(5);
    expect(window.entries.at(-1)?.id).toBe(504);
    expect(window.seenEntryKeys).toHaveLength(500);
    expect(window.seenEntryKeys.has(liveLogEntryKey(entry(0)))).toBe(false);
    expect(window.seenEntryKeys.has(liveLogEntryKey(entry(504)))).toBe(true);
  });

  it("accepts an evicted key again while rejecting a key still in the window", () => {
    let window = createLiveLogWindow();
    for (let id = 0; id <= 500; id++) {
      window = appendLiveLogEntry(window, entry(id));
    }

    const unchanged = appendLiveLogEntry(window, entry(500));
    expect(unchanged).toBe(window);

    window = appendLiveLogEntry(window, entry(0));
    expect(window.entries).toHaveLength(500);
    expect(window.entries.at(-1)?.id).toBe(0);
    expect(window.seenEntryKeys.has(liveLogEntryKey(entry(0)))).toBe(true);
    expect(window.seenEntryKeys.has(liveLogEntryKey(entry(1)))).toBe(false);
  });

  it("does not mutate the previous window", () => {
    const previous = createLiveLogWindow();
    const next = appendLiveLogEntry(previous, entry(1));

    expect(previous.entries).toEqual([]);
    expect(previous.seenEntryKeys).toHaveLength(0);
    expect(next).not.toBe(previous);
  });

  it("counts entries evicted from the window as omitted", () => {
    let window = createLiveLogWindow();
    for (let id = 0; id < 505; id++) {
      window = appendLiveLogEntry(window, entry(id));
    }

    expect(window.omitted).toBe(5);
  });

  it("restarts the window for a fresh replay and records what the server omitted", () => {
    const previous = appendLiveLogEntry(createLiveLogWindow(), entry(1));

    const fresh = startLiveLogReplay(previous, { resumed: false, replayed: 500, omitted: 9_500, limit: 500 });

    expect(fresh.entries).toEqual([]);
    expect(fresh.seenEntryKeys).toHaveLength(0);
    expect(fresh.omitted).toBe(9_500);
    expect(appendLiveLogEntry(fresh, entry(1)).entries).toHaveLength(1);
  });

  it("keeps the window when the stream resumed after the last received entry", () => {
    const previous = appendLiveLogEntry(createLiveLogWindow(), entry(1));

    expect(startLiveLogReplay(previous, { resumed: true, replayed: 2, omitted: 0, limit: 500 })).toBe(previous);
  });

  it("treats missing or malformed replay details as a complete fresh replay", () => {
    const previous = appendLiveLogEntry(createLiveLogWindow(), entry(1));

    for (const replay of [undefined, null, "resumed", { omitted: -3 }, { omitted: Number.NaN }]) {
      const fresh = startLiveLogReplay(previous, replay);
      expect(fresh.entries).toEqual([]);
      expect(fresh.omitted).toBe(0);
    }
  });
});