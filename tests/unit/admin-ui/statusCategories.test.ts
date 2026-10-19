import { describe, expect, it } from "vitest";
import { TASK_STATES, TASK_STATUS_CATEGORIES, TASK_WORKFLOW_BUCKETS } from "../../../src/domain/tasks.js";
import { STATES, STATUS_CATEGORIES, classifyStatusCategory, classifyWorkflowBucket } from "../../../src/admin/ui/states.js";

describe("dashboard status categories", () => {
  it.each(TASK_STATES)("classifies %s identically in the domain and the UI mirror", (state) => {
    expect(classifyStatusCategory(state)).toBe(TASK_STATUS_CATEGORIES.get(state));
    expect(classifyWorkflowBucket(state)).toBe(TASK_WORKFLOW_BUCKETS.get(state));
  });

  it.each(TASK_STATES)("colours %s with its category tone", (state) => {
    const category = STATUS_CATEGORIES.find((entry) => entry.id === classifyStatusCategory(state));
    expect(STATES[state].tone).toBe(category?.tone);
  });

  it("treats a review awaiting execution as queued work, not as watching", () => {
    expect(TASK_STATUS_CATEGORIES.get("REVIEW_PENDING")).toBe("queued");
    expect(TASK_WORKFLOW_BUCKETS.get("REVIEW_PENDING")).toBe("active");
  });
});
