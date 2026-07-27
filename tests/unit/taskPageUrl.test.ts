import { describe, expect, it } from "vitest";
import { buildTaskPageUrl } from "../../src/utils/taskPageUrl.js";

describe("buildTaskPageUrl", () => {
  it("preserves the deployment path and targets the task hash route", () => {
    expect(buildTaskPageUrl("https://ve.example.test/admin/", "review-42-abcd")).toBe(
      "https://ve.example.test/admin/#tasks/review-42-abcd",
    );
  });

  it("encodes the task id", () => {
    expect(buildTaskPageUrl("https://ve.example.test", "review 42")).toBe(
      "https://ve.example.test/#tasks/review%2042",
    );
  });
});