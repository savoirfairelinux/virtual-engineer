import { describe, expect, it } from "vitest";
import { buildCopilotSystemMessage } from "../../agent-worker/src/providers/copilot.js";

describe("Copilot worker native profile", () => {
  it("appends agent instructions to the Copilot CLI foundation explicitly", () => {
    expect(buildCopilotSystemMessage("permanent agent policy")).toEqual({
      mode: "append",
      content: "permanent agent policy",
    });
  });
});