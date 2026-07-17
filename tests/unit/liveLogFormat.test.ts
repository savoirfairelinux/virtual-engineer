import { describe, expect, it } from "vitest";
import { renderPayload } from "../../src/admin/ui/views/TasksView/liveLogFormat.js";

describe("renderPayload", () => {
  it("formats structured JSON as one compact line", () => {
    const payload = renderPayload({
      message: undefined,
      data: {
        model: "gpt-5-mini",
        usage: { inputTokens: 120, outputTokens: 40 },
      },
    });

    expect(payload).toBe('{"model":"gpt-5-mini","usage":{"inputTokens":120,"outputTokens":40}}');
    expect(payload).not.toContain("\n");
  });

  it.each([
    { message: '{\n  "status": "connected",\n  "attempt": 2\n}' },
    { data: '[\n  { "tool": "grep" },\n  { "tool": "read_file" }\n]' },
  ])("compacts valid JSON strings", (entry) => {
    const payload = renderPayload(entry);

    expect(payload).not.toContain("\n");
    expect(JSON.parse(payload)).toEqual(JSON.parse(entry.message ?? entry.data ?? ""));
  });

  it("preserves multiline plain-text messages", () => {
    expect(renderPayload({ message: "first line\nsecond line" })).toBe("first line\nsecond line");
  });
});