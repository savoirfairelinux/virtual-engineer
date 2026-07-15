export function resolveOpenShellGateway(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  return env["OPENSHELL_GATEWAY"] ?? env["OPENSHELL_GATEWAY_ENDPOINT"];
}

export interface RuntimeRecoveryDeps {
  recoverReviews: () => Promise<void>;
  resumeCodeGeneration: () => Promise<void>;
  reconcileSandboxes: () => Promise<void>;
  startSandboxReconciler: () => void;
  stopSandboxReconciler: () => void;
  onInitialReconcileError?: ((error: unknown) => void) | undefined;
}

export interface RuntimeRecoveryLifecycle {
  stop(): void;
}

export async function startRuntimeRecovery(
  deps: RuntimeRecoveryDeps,
): Promise<RuntimeRecoveryLifecycle> {
  await deps.recoverReviews();
  await deps.resumeCodeGeneration();
  try {
    await deps.reconcileSandboxes();
  } catch (error) {
    deps.onInitialReconcileError?.(error);
  }
  deps.startSandboxReconciler();

  let stopped = false;
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      deps.stopSandboxReconciler();
    },
  };
}