import { describe, expect, it, vi } from "vitest";
import { copyTaskPageLink } from "../../src/admin/ui/taskPageLink.js";

describe("copyTaskPageLink", () => {
  it("copies the current hash-routed task URL", async () => {
    const writeText = vi.fn(async () => undefined);
    const href = "https://ve.example.test/admin/#tasks/review-42-abcd";

    await copyTaskPageLink(href, { writeText });

    expect(writeText).toHaveBeenCalledWith(href);
  });
});