import { describe, expect, it } from "vitest";
import { DEFAULT_TASK_FILTERS, taskFiltersFromHash, taskMatchesStatusFilters } from "../../../src/admin/ui/views/TasksView/TaskList.js";

describe("taskFiltersFromHash", () => {
  it("applies known status buckets from a tasks deep link and ignores unknown ones", () => {
    expect(taskFiltersFromHash("#tasks?status=failed&status=bogus&status=failed")).toEqual({
      ...DEFAULT_TASK_FILTERS,
      statuses: ["failed"],
    });
  });

  it("keeps abandoned tasks out of the failed filter and active covers queued work", () => {
    expect(taskMatchesStatusFilters({ state: "ABANDONED" }, ["failed"])).toBe(false);
    expect(taskMatchesStatusFilters({ state: "ABANDONED" }, ["abandoned"])).toBe(true);
    expect(taskMatchesStatusFilters({ state: "REVIEW_FAILED" }, ["failed"])).toBe(true);
    expect(taskMatchesStatusFilters({ state: "REVIEW_PENDING" }, ["active"])).toBe(true);
    expect(taskMatchesStatusFilters({ state: "REVIEW_PENDING" }, ["watching"])).toBe(false);
  });

  it("falls back to default filters without a usable status", () => {
    expect(taskFiltersFromHash("#tasks")).toEqual(DEFAULT_TASK_FILTERS);
    expect(taskFiltersFromHash("#tasks?status=bogus")).toEqual(DEFAULT_TASK_FILTERS);
  });
});
