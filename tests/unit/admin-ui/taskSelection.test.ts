import { describe, expect, it } from "vitest";
import {
  BULK_ACTION_PAST_TENSE,
  selectTaskIds,
} from "../../../src/admin/ui/views/TasksView/taskSelection.ts";

describe("task selection", () => {
  const taskIds = ["task-a", "task-b", "task-c", "task-d"];

  it("uses explicit past-tense labels for bulk action failures", () => {
    expect(BULK_ACTION_PAST_TENSE).toEqual({
      retry: "retried",
      abandon: "abandoned",
      delete: "deleted",
    });
  });

  it("selects one task for a normal click", () => {
    expect([...selectTaskIds(taskIds, new Set(["task-a"]), "task-c")]).toEqual(["task-c"]);
  });

  it("toggles one task for an additive click", () => {
    expect([...selectTaskIds(taskIds, new Set(["task-a", "task-c"]), "task-c", { additive: true })])
      .toEqual(["task-a"]);
    expect([...selectTaskIds(taskIds, new Set(["task-a"]), "task-c", { additive: true })])
      .toEqual(["task-a", "task-c"]);
  });

  it("selects the inclusive range from the anchor", () => {
    expect([...selectTaskIds(taskIds, new Set(), "task-d", { anchorId: "task-b" })])
      .toEqual(["task-b", "task-c", "task-d"]);
  });

  it("adds a dragged range without dropping existing additive selection", () => {
    expect([...selectTaskIds(taskIds, new Set(["task-a"]), "task-d", { anchorId: "task-b", additive: true })])
      .toEqual(["task-a", "task-b", "task-c", "task-d"]);
  });
});