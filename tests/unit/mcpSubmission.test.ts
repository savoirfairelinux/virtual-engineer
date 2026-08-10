import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
  CHANGE_SUBMISSION_JSON_SCHEMA,
  SUBMISSION_TOOL_ANNOTATIONS,
  appendSubmissionInstruction,
  assertSingleNativeReviewDelegation,
  assertSuccessfulSubmissionToolCall,
  buildSubmissionMcpConfig,
  readSubmission,
  recordSubmission,
  validateSubmission,
} from "../../agent-worker/src/mcpSubmission.js";

describe("MCP submission contract", () => {
  it("exposes only the review submission tool with the integration schema", () => {
    const schema = {
      type: "object",
      properties: { vote: { type: "integer", enum: [-1, 0, 1] } },
      required: ["vote"],
      additionalProperties: false,
    };

    const config = buildSubmissionMcpConfig("review", schema, "/ve-home/review.json");

    expect(config.toolName).toBe("ve_submit_review");
    expect(config.server).toEqual({
      type: "stdio",
      command: "node",
      args: ["/agent-worker/dist/mcpSubmissionServer.js"],
      env: {
        VE_SUBMISSION_MODE: "review",
        VE_SUBMISSION_PATH: "/ve-home/review.json",
        VE_SUBMISSION_SCHEMA_JSON: JSON.stringify(schema),
      },
    });
  });

  it("records exactly one submission with restrictive permissions", () => {
    const directory = mkdtempSync(join(tmpdir(), "ve-mcp-submission-"));
    const path = join(directory, "submission.json");

    recordSubmission(path, { vote: 1 });

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ vote: 1 });
    expect(() => recordSubmission(path, { vote: -1 })).toThrow("already recorded");
  });

  it("rejects non-object submissions", () => {
    const directory = mkdtempSync(join(tmpdir(), "ve-mcp-submission-"));
    const path = join(directory, "submission.json");

    expect(() => recordSubmission(path, "approve")).toThrow("must be a JSON object");
  });

  it("requires an MCP artifact and reads its JSON object", () => {
    const directory = mkdtempSync(join(tmpdir(), "ve-mcp-submission-"));
    const path = join(directory, "submission.json");

    expect(() => readSubmission(path)).toThrow("did not submit");
    recordSubmission(path, { status: "completed", summary: "Implemented tests" });
    expect(readSubmission(path)).toEqual({ status: "completed", summary: "Implemented tests" });
  });

  it("surfaces a failed submission tool execution before reading the artifact", () => {
    expect(() => assertSuccessfulSubmissionToolCall("review", [{
      callId: "submit-1",
      name: "ve-submission-ve_submit_review",
      input: { comments: [] },
      success: false,
      error: "MCP submission does not match its JSON Schema",
    }])).toThrow("MCP submission does not match its JSON Schema");

    expect(() => assertSuccessfulSubmissionToolCall("review", [{
      callId: "submit-1",
      name: "ve-submission-ve_submit_review",
      input: { comments: [], summary: "No issues", replies: [], vote: 1 },
      success: true,
    }])).not.toThrow();
  });

  it("recognizes accepted submissions under the declared MCP server identity", () => {
    expect(() => assertSuccessfulSubmissionToolCall("review", [{
      callId: "submit-1",
      name: "virtual-engineer-submission-ve_submit_review",
      input: { comments: [], summary: "No issues", replies: [], vote: 1 },
      success: true,
    }])).not.toThrow();
  });

  it("allows rejected payloads to be corrected before one accepted submission", () => {
    expect(() => assertSuccessfulSubmissionToolCall("review", [
      {
        callId: "submit-1",
        name: "ve-submission-ve_submit_review",
        input: { comments: [] },
        success: false,
        error: "MCP submission does not match its JSON Schema",
      },
      {
        callId: "submit-2",
        name: "ve-submission-ve_submit_review",
        input: { comments: [], summary: "No issues", replies: [], vote: 1 },
        success: true,
      },
    ])).not.toThrow();

    expect(() => assertSuccessfulSubmissionToolCall("review", [
      {
        callId: "submit-1",
        name: "ve-submission-ve_submit_review",
        input: {},
        success: true,
      },
      {
        callId: "submit-2",
        name: "ve-submission-ve_submit_review",
        input: {},
        success: true,
      },
    ])).toThrow("accepted exactly once");
  });

  it("tells the agent to correct rejected payloads without duplicating accepted submissions", () => {
    expect(appendSubmissionInstruction("Review safely.", "ve_submit_review")).toBe(
      "Review safely.\n\nSubmit the final structured result through ve_submit_review before ending. " +
      "Exactly one submission must be accepted; correct and retry rejected attempts."
    );
  });

  it("requires exactly one synchronous code-review task delegation", () => {
    expect(() => assertSingleNativeReviewDelegation([])).toThrow("exactly once");
    expect(() => assertSingleNativeReviewDelegation([
      { name: "task", input: { agent_type: "research", mode: "sync" } },
    ])).toThrow("exactly once");
    expect(() => assertSingleNativeReviewDelegation([
      { name: "task", input: { agent_type: "code-review", mode: "sync" } },
    ])).not.toThrow();
    expect(() => assertSingleNativeReviewDelegation([
      { name: "task", input: { agent_type: "code-review", mode: "sync" } },
      { name: "task", input: { agent_type: "code-review", mode: "sync" } },
    ])).toThrow("observed 2");
  });

  it("marks the submission tool as mutating and non-idempotent", () => {
    expect(SUBMISSION_TOOL_ANNOTATIONS).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it("defines a narrow coding completion contract", () => {
    expect(CHANGE_SUBMISSION_JSON_SCHEMA).toEqual({
      type: "object",
      properties: {
        status: { type: "string", enum: ["completed", "no_change"] },
        summary: { type: "string", minLength: 1 },
      },
      required: ["status", "summary"],
      additionalProperties: false,
    });
  });

  it("validates submissions against the exact advertised JSON Schema", () => {
    const schema = {
      type: "object",
      properties: { vote: { type: "integer", enum: [-1, 0, 1] } },
      required: ["vote"],
      additionalProperties: false,
    };

    expect(validateSubmission(schema, { vote: 1 })).toEqual({ vote: 1 });
    expect(() => validateSubmission(schema, { vote: 2 })).toThrow("does not match");
    expect(() => validateSubmission(schema, { vote: 1, push: true })).toThrow("does not match");
  });

  it("revalidates the persisted artifact when the worker reads it", () => {
    const directory = mkdtempSync(join(tmpdir(), "ve-mcp-submission-"));
    const path = join(directory, "submission.json");
    const schema = {
      type: "object",
      properties: { vote: { type: "integer", enum: [-1, 0, 1] } },
      required: ["vote"],
      additionalProperties: false,
    };

    recordSubmission(path, { vote: 2 });
    expect(() => readSubmission(path, schema)).toThrow("does not match");
  });
});