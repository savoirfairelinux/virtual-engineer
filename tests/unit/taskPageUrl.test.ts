import { describe, it, expect } from "vitest";
import { buildTaskPageUrl } from "../../src/utils/taskPageUrl.js";

describe("buildTaskPageUrl", () => {
  it("appends a hash route for the task id", () => {
    expect(buildTaskPageUrl("https://ve.example.com", "task-123")).toBe(
      "https://ve.example.com/#/tasks/task-123"
    );
  });

  it("strips trailing slashes from the base url", () => {
    expect(buildTaskPageUrl("https://ve.example.com/", "abc")).toBe(
      "https://ve.example.com/#/tasks/abc"
    );
    expect(buildTaskPageUrl("https://ve.example.com///", "abc")).toBe(
      "https://ve.example.com/#/tasks/abc"
    );
  });

  it("preserves a sub-path in the base url", () => {
    expect(buildTaskPageUrl("https://host/admin", "abc")).toBe(
      "https://host/admin/#/tasks/abc"
    );
  });

  it("url-encodes the task id", () => {
    expect(buildTaskPageUrl("https://host", "a/b c")).toBe(
      "https://host/#/tasks/a%2Fb%20c"
    );
  });
});
