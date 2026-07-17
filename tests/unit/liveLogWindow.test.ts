import { describe, expect, it } from "vitest";
import {
  appendLiveLogEntry,
  createLiveLogWindow,
  liveLogEntryKey,
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
});