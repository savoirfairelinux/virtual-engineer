import { describe, it, expect } from "vitest";
import {
  validateTransition,
  InvalidTransitionError,
  VALID_TRANSITIONS,
} from "../../src/state/stateMachine.js";
import { TASK_STATES, TERMINAL_STATES } from "../../src/interfaces.js";
import type { TaskState } from "../../src/interfaces.js";

describe("validateTransition", () => {
  it("returns idempotent when from === to", () => {
    expect(validateTransition("DETECTED", "DETECTED")).toBe("idempotent");
    expect(validateTransition("IN_REVIEW", "IN_REVIEW")).toBe("idempotent");
  });

  it("returns valid for allowed transitions", () => {
    expect(validateTransition("DETECTED", "CONTEXT_BUILDING")).toBe("valid");
    expect(validateTransition("CONTEXT_BUILDING", "AGENT_RUNNING")).toBe("valid");
    expect(validateTransition("AGENT_RUNNING", "IN_REVIEW")).toBe("valid");
    expect(validateTransition("IN_REVIEW", "MERGED")).toBe("valid");
    expect(validateTransition("MERGED", "CLOSING")).toBe("valid");
    expect(validateTransition("CLOSING", "DONE")).toBe("valid");
  });

  it("throws InvalidTransitionError for disallowed transitions", () => {
    expect(() => validateTransition("DETECTED", "IN_REVIEW")).toThrow(InvalidTransitionError);
    expect(() => validateTransition("DONE", "DETECTED")).toThrow(InvalidTransitionError);
    expect(() => validateTransition("IN_REVIEW", "DETECTED")).toThrow(InvalidTransitionError);
    expect(() => validateTransition("IN_REVIEW", "CONTEXT_BUILDING")).toThrow(InvalidTransitionError);
  });

  it("throws for any transition out of terminal states", () => {
    for (const terminal of TERMINAL_STATES) {
      for (const target of TASK_STATES) {
        if (target === terminal) continue; // idempotent, tested above
        expect(() => validateTransition(terminal, target)).toThrow(InvalidTransitionError);
      }
    }
  });

  it("FAILED and ABANDONED are reachable from multiple states", () => {
    const canFail: TaskState[] = [
      "DETECTED",
      "CONTEXT_BUILDING",
      "AGENT_RUNNING",
      "IN_REVIEW",
      "FEEDBACK_PROCESSING",
      "RETRY_CYCLE",
      "CLOSING",
    ];
    for (const state of canFail) {
      expect(VALID_TRANSITIONS.get(state)?.has("FAILED")).toBe(true);
    }
  });

  it("every non-terminal state has at least one outgoing transition", () => {
    for (const state of TASK_STATES) {
      if (TERMINAL_STATES.has(state)) continue;
      const transitions = VALID_TRANSITIONS.get(state);
      expect(transitions?.size).toBeGreaterThan(0);
    }
  });

  it("InvalidTransitionError carries from and to states", () => {
    const err = (() => {
      try { 
        validateTransition("DONE", "DETECTED");
        throw new Error("Expected InvalidTransitionError");
      }
      catch (e) { 
        if (e instanceof InvalidTransitionError) {
          return e;
        }
        throw e;
      }
    })();
    expect(err.from).toBe("DONE");
    expect(err.to).toBe("DETECTED");
  });

  describe("code-review states", () => {
    it("allows the canonical review happy path", () => {
      expect(validateTransition("REVIEW_PENDING", "REVIEW_RUNNING")).toBe("valid");
      expect(validateTransition("REVIEW_RUNNING", "REVIEW_COMMENTING")).toBe("valid");
      expect(validateTransition("REVIEW_COMMENTING", "REVIEW_WATCHING")).toBe("valid");
      expect(validateTransition("REVIEW_WATCHING", "REVIEW_DONE")).toBe("valid");
    });

    it("allows re-review loop from REVIEW_WATCHING back to REVIEW_RUNNING", () => {
      expect(validateTransition("REVIEW_WATCHING", "REVIEW_RUNNING")).toBe("valid");
    });

    it("allows REVIEW_COMMENTING to short-circuit to REVIEW_DONE when no comments", () => {
      expect(validateTransition("REVIEW_COMMENTING", "REVIEW_DONE")).toBe("valid");
    });

    it("allows REVIEW_FAILED from any non-terminal review state", () => {
      expect(validateTransition("REVIEW_PENDING", "REVIEW_FAILED")).toBe("valid");
      expect(validateTransition("REVIEW_RUNNING", "REVIEW_FAILED")).toBe("valid");
      expect(validateTransition("REVIEW_COMMENTING", "REVIEW_FAILED")).toBe("valid");
      expect(validateTransition("REVIEW_WATCHING", "REVIEW_FAILED")).toBe("valid");
    });

    it("rejects mixing review and code-gen states", () => {
      expect(() => validateTransition("REVIEW_PENDING", "AGENT_RUNNING")).toThrow(
        InvalidTransitionError
      );
      expect(() => validateTransition("DETECTED", "REVIEW_RUNNING")).toThrow(
        InvalidTransitionError
      );
      expect(() => validateTransition("REVIEW_WATCHING", "IN_REVIEW")).toThrow(
        InvalidTransitionError
      );
    });

    it("treats REVIEW_DONE and REVIEW_FAILED as terminal", () => {
      expect(TERMINAL_STATES.has("REVIEW_DONE")).toBe(true);
      expect(TERMINAL_STATES.has("REVIEW_FAILED")).toBe(true);
      expect(() => validateTransition("REVIEW_DONE", "REVIEW_RUNNING")).toThrow(
        InvalidTransitionError
      );
      expect(() => validateTransition("REVIEW_FAILED", "REVIEW_RUNNING")).toThrow(
        InvalidTransitionError
      );
    });
  });
});
