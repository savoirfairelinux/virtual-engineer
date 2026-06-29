import { describe, it, expect } from "vitest";
import { buildTaskPageUrl, resolvePublicBaseUrl } from "../../src/utils/taskPageUrl.js";

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

describe("resolvePublicBaseUrl", () => {
  it("prefers the configured public base url", () => {
    expect(
      resolvePublicBaseUrl({ publicBaseUrl: "https://ve.example.com", host: "127.0.0.1", port: 3100 })
    ).toBe("https://ve.example.com");
  });

  it("falls back to host:port when unconfigured", () => {
    expect(resolvePublicBaseUrl({ host: "127.0.0.1", port: 3100 })).toBe("http://127.0.0.1:3100");
  });

  it("treats a blank configured value as unset", () => {
    expect(
      resolvePublicBaseUrl({ publicBaseUrl: "   ", host: "0.0.0.0", port: 8080 })
    ).toBe("http://0.0.0.0:8080");
  });
});
