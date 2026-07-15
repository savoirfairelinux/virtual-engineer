import { describe, expect, it, vi } from "vitest";
import {
  resolveOpenShellGateway,
  startRuntimeRecovery,
} from "../../src/runtime/runtimeStartup.js";

describe("runtime startup", () => {
  it("prefers the named OpenShell profile and falls back to a direct endpoint", () => {
    expect(resolveOpenShellGateway({
      OPENSHELL_GATEWAY_ENDPOINT: "https://gateway.direct:8080",
      OPENSHELL_GATEWAY: "virtual-engineer",
    })).toBe("virtual-engineer");
    expect(resolveOpenShellGateway({
      OPENSHELL_GATEWAY_ENDPOINT: "https://gateway.direct:8080",
    })).toBe("https://gateway.direct:8080");
    expect(resolveOpenShellGateway({})).toBeUndefined();
  });

  it("starts recovery in order and stops the reconciler once", async () => {
    const calls: string[] = [];
    const lifecycle = await startRuntimeRecovery({
      recoverReviews: vi.fn(async () => { calls.push("reviews"); }),
      resumeCodeGeneration: vi.fn(async () => { calls.push("codegen"); }),
      reconcileSandboxes: vi.fn(async () => { calls.push("reconcile"); }),
      startSandboxReconciler: vi.fn(() => { calls.push("start"); }),
      stopSandboxReconciler: vi.fn(() => { calls.push("stop"); }),
    });

    expect(calls).toEqual(["reviews", "codegen", "reconcile", "start"]);
    lifecycle.stop();
    lifecycle.stop();
    expect(calls).toEqual(["reviews", "codegen", "reconcile", "start", "stop"]);
  });

  it("starts periodic reconciliation after an initial best-effort failure", async () => {
    const onInitialReconcileError = vi.fn();
    const startSandboxReconciler = vi.fn();

    await startRuntimeRecovery({
      recoverReviews: vi.fn().mockResolvedValue(undefined),
      resumeCodeGeneration: vi.fn().mockResolvedValue(undefined),
      reconcileSandboxes: vi.fn().mockRejectedValue(new Error("gateway unavailable")),
      startSandboxReconciler,
      stopSandboxReconciler: vi.fn(),
      onInitialReconcileError,
    });

    expect(onInitialReconcileError).toHaveBeenCalledWith(expect.objectContaining({ message: "gateway unavailable" }));
    expect(startSandboxReconciler).toHaveBeenCalledOnce();
  });
});