import { describe, expect, it } from "vitest";
import {
  AgentWorkerProtocolError,
  decodeReviewWorkerOutput,
} from "../../src/workspace/agentWorkerProtocol.js";

describe("decodeReviewWorkerOutput", () => {
  it("extracts multiline review output from a successful worker envelope", () => {
    const rawOutput = [
      "REVIEW_RESULT_START",
      JSON.stringify({ comments: [], summary: "Looks good", score: 1 }),
      "REVIEW_RESULT_END",
    ].join("\n");

    expect(decodeReviewWorkerOutput(JSON.stringify({
      status: "success",
      modifiedFiles: [],
      summary: "Looks good",
      agentLogs: rawOutput,
      rawOutput,
      metadata: { reviewMode: true },
    }))).toBe(rawOutput);
  });

  it("surfaces a failed worker summary", () => {
    expect(() => decodeReviewWorkerOutput(JSON.stringify({
      status: "failed",
      modifiedFiles: [],
      summary: "Agent worker error: model unavailable",
      agentLogs: "",
    }))).toThrow("Agent worker error: model unavailable");
  });

  it.each([
    ["invalid JSON", "not-json"],
    ["missing rawOutput", JSON.stringify({ status: "success" })],
    ["non-string rawOutput", JSON.stringify({ status: "success", rawOutput: 42 })],
  ])("rejects %s", (_label, stdout) => {
    expect(() => decodeReviewWorkerOutput(stdout)).toThrow(AgentWorkerProtocolError);
  });
});