/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TaskList } from "../../../src/admin/ui/views/TasksView/TaskList.tsx";
import type { ApiTask } from "../../../src/admin/ui/types.ts";

const task: ApiTask = {
  taskId: "task-1",
  taskType: "code-gen",
  ticketId: "VE-1",
  ticketSourceLabel: "redmine",
  ticketTitle: "Fix the task",
  ticketDescription: "",
  state: "IN_REVIEW",
  gerritChangeId: null,
  currentPatchset: 0,
  reviewedPatchset: null,
  cycleCount: 0,
  failureReason: null,
  ticketUrl: null,
  reviewUrl: null,
  displayId: "1",
  createdAt: "2026-08-14T00:00:00.000Z",
  updatedAt: "2026-08-14T00:00:00.000Z",
};

describe("TaskList keyboard interaction", () => {
  it("does not activate the row when a nested checkbox receives a key", () => {
    const onSelect = vi.fn();

    render(
      <TaskList
        tasks={[task]}
        selectedId={task.taskId}
        selectedIds={new Set()}
        onSelect={onSelect}
        onSelectionChange={vi.fn()}
        onBulkAction={vi.fn()}
        canOperate={false}
        bulkBusy={false}
        bulkError={null}
      />,
    );

    fireEvent.keyDown(screen.getByRole("checkbox"), { key: " " });

    expect(onSelect).not.toHaveBeenCalled();
  });
});