import { describe, expect, it, vi } from "vitest";
import { applyIfCurrentGeneration } from "../../../src/admin/ui/useIdentityReset.js";

describe("identity generation", () => {
  it("does not apply an identity loaded by a superseded generation", () => {
    const apply = vi.fn();

    applyIfCurrentGeneration({ username: "old-admin" }, 1, 2, apply);

    expect(apply).not.toHaveBeenCalled();
  });

  it("applies an identity loaded by the current generation", () => {
    const apply = vi.fn();
    const user = { username: "current-admin" };

    applyIfCurrentGeneration(user, 2, 2, apply);

    expect(apply).toHaveBeenCalledWith(user);
  });
});
