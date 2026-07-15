import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OpenShellSandboxReconciler,
  reconcileOpenShellSandboxes,
} from "../../src/openshell/openShellSandboxReconciler.js";
import {
  VE_SANDBOX_MANAGER_LABEL,
  VE_SANDBOX_MANAGER_VALUE,
  VE_SANDBOX_TASK_HASH_LABEL,
  sandboxTaskHash,
} from "../../src/openshell/sandboxOwnership.js";
import { makeTaskId, type Task } from "../../src/interfaces.js";

function makeTask(taskId: string): Task {
  return {
    taskId: makeTaskId(taskId),
    ticketId: `ticket-${taskId}` as Task["ticketId"],
    displayId: taskId,
    ticketTitle: "Task",
    ticketDescription: "",
    state: "AGENT_RUNNING",
    taskType: "code-gen",
    ticketSourceLabel: "redmine:redmine-1",
    externalChangeId: null,
    currentPatchset: 0,
    reviewedPatchset: null,
    pushRef: null,
    projectId: null,
    cycleCount: 1,
    failureReason: null,
    ticketUrl: null,
    reviewUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const NOW = new Date("2026-07-15T12:00:00Z");
const OLD = new Date("2026-07-15T10:00:00Z");
const RECENT = new Date("2026-07-15T11:55:00Z");

function labels(taskId: string): Record<string, string> {
  return {
    [VE_SANDBOX_MANAGER_LABEL]: VE_SANDBOX_MANAGER_VALUE,
    [VE_SANDBOX_TASK_HASH_LABEL]: sandboxTaskHash(taskId),
  };
}

describe("reconcileOpenShellSandboxes", () => {
  afterEach(() => vi.useRealTimers());

  it("deletes only old VE-owned orphans and isolates delete failures", async () => {
    const active = makeTask("active-task");
    const listSandboxes = vi.fn(async () => [
      { id: "1", name: "ve-active", labels: labels("active-task"), createdAt: OLD, phase: "Ready" },
      { id: "2", name: "ve-recent", labels: labels("recent-orphan"), createdAt: RECENT, phase: "Ready" },
      { id: "3", name: "foreign", labels: {}, createdAt: OLD, phase: "Ready" },
      { id: "4", name: "ve-orphan", labels: labels("old-orphan"), createdAt: OLD, phase: "Ready" },
      { id: "5", name: "ve-failed", labels: labels("failed-orphan"), createdAt: OLD, phase: "Error" },
    ]);
    const removeSandbox = vi.fn(async (name: string) => {
      if (name === "ve-failed") throw new Error("gateway unavailable");
    });

    const result = await reconcileOpenShellSandboxes({
      client: { listSandboxes, removeSandbox, removeProvider: vi.fn(async () => undefined) },
      store: {
        getActiveTasks: vi.fn(async () => [active]),
        listManagedOpenShellProviders: vi.fn(async () => []),
        deleteManagedOpenShellProvider: vi.fn(async () => undefined),
      },
      now: () => NOW,
      minAgeMs: 10 * 60_000,
    });

    expect(listSandboxes).toHaveBeenCalledWith({
      limit: 100,
      offset: 0,
      selector: `${VE_SANDBOX_MANAGER_LABEL}=${VE_SANDBOX_MANAGER_VALUE}`,
    });
    expect(removeSandbox.mock.calls).toEqual([["ve-orphan"], ["ve-failed"]]);
    expect(result).toEqual({
      scanned: 5,
      deleted: 1,
      failed: 1,
      skippedActive: 1,
      skippedRecent: 1,
      skippedForeign: 1,
      providers: { scanned: 0, deleted: 0, failed: 0, skippedActive: 0, skippedRecent: 0, skippedAttached: 0 },
    });
  });

  it("paginates beyond the first 100 sandboxes", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: String(index),
      name: `ve-recent-${index}`,
      labels: labels(`recent-${index}`),
      createdAt: RECENT,
      phase: "Ready",
    }));
    const orphan = {
      id: "orphan",
      name: "ve-old-orphan",
      labels: labels("old-orphan"),
      createdAt: OLD,
      phase: "Ready",
    };
    const listSandboxes = vi.fn(async ({ offset = 0 }: { offset?: number }) =>
      offset === 0 ? firstPage : offset === 100 ? [orphan] : []);
    const removeSandbox = vi.fn().mockResolvedValue(undefined);

    const result = await reconcileOpenShellSandboxes({
      client: { listSandboxes, removeSandbox, removeProvider: vi.fn(async () => undefined) },
      store: {
        getActiveTasks: vi.fn(async () => []),
        listManagedOpenShellProviders: vi.fn(async () => []),
        deleteManagedOpenShellProvider: vi.fn(async () => undefined),
      },
      now: () => NOW,
    });

    expect(listSandboxes.mock.calls.map(([input]) => input.offset ?? 0)).toEqual([0, 100]);
    expect(removeSandbox).toHaveBeenCalledWith("ve-old-orphan");
    expect(result.scanned).toBe(101);
  });

  it("removes persisted orphan providers after their sandbox is gone", async () => {
    const calls: string[] = [];
    const removeProvider = vi.fn(async (name: string) => {
      calls.push(`provider:${name}`);
    });
    const deleteManagedProvider = vi.fn(async (name: string) => {
      calls.push(`ledger:${name}`);
    });

    const result = await reconcileOpenShellSandboxes({
      client: {
        listSandboxes: vi.fn(async () => []),
        removeSandbox: vi.fn(async (name: string) => {
          calls.push(`sandbox:${name}`);
        }),
        removeProvider,
      },
      store: {
        getActiveTasks: vi.fn(async () => []),
        listManagedOpenShellProviders: vi.fn(async () => [{
          providerName: "ve-orphan-agent",
          sandboxName: "ve-orphan",
          taskHash: sandboxTaskHash("orphan-task"),
          createdAt: OLD,
        }]),
        deleteManagedOpenShellProvider: deleteManagedProvider,
      },
      now: () => NOW,
      minAgeMs: 10 * 60_000,
    });

    expect(removeProvider).toHaveBeenCalledWith("ve-orphan-agent");
    expect(deleteManagedProvider).toHaveBeenCalledWith("ve-orphan-agent");
    expect(calls).toEqual(["provider:ve-orphan-agent", "ledger:ve-orphan-agent"]);
    expect(result.providers).toEqual({ scanned: 1, deleted: 1, failed: 0, skippedActive: 0, skippedRecent: 0, skippedAttached: 0 });
  });

  it("runs periodically without overlap and stops cleanly", async () => {
    vi.useFakeTimers();
    let resolveList: ((value: []) => void) | undefined;
    const listSandboxes = vi.fn(() => new Promise<[]>((resolve) => {
      resolveList = resolve;
    }));
    const reconciler = new OpenShellSandboxReconciler({
      client: {
        listSandboxes,
        removeSandbox: vi.fn(async () => undefined),
        removeProvider: vi.fn(async () => undefined),
      },
      store: {
        getActiveTasks: vi.fn(async () => []),
        listManagedOpenShellProviders: vi.fn(async () => []),
        deleteManagedOpenShellProvider: vi.fn(async () => undefined),
      },
    }, 1_000);

    reconciler.start();
    reconciler.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(listSandboxes).toHaveBeenCalledOnce();

    resolveList?.([]);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(listSandboxes).toHaveBeenCalledTimes(2);

    reconciler.stop();
    resolveList?.([]);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(listSandboxes).toHaveBeenCalledTimes(2);
  });
});
