import { describe, expect, it } from "vitest";
import { resolveProviderOptions } from "../../src/agents/providerOptions.js";

describe("resolveProviderOptions", () => {
  it("copies the opaque provider-owned options object", () => {
    expect(resolveProviderOptions({
      providerOptions: { effort: "max", futureProviderFlag: 42 },
    })).toEqual({ effort: "max", futureProviderFlag: 42 });
  });

  it("returns an empty object for missing or invalid envelopes", () => {
    expect(resolveProviderOptions({ effort: "legacy-top-level" })).toEqual({});
    expect(resolveProviderOptions({ providerOptions: [] })).toEqual({});
  });
});