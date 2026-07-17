import { getLogger } from "../logger.js";

const log = getLogger("runtime-startup");

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
  checkGatewayHealth?: (() => Promise<boolean>) | undefined;
}

export interface RuntimeRecoveryLifecycle {
  stop(): void;
}

export async function startRuntimeRecovery(
  deps: RuntimeRecoveryDeps,
): Promise<RuntimeRecoveryLifecycle> {
  if (deps.checkGatewayHealth !== undefined) {
    const healthy = await deps.checkGatewayHealth().catch(() => false);
    if (!healthy) {
      log.warn("OpenShell gateway unreachable — sandbox execution will fail until connectivity is restored");
    }
  }
  await Promise.all([
    deps.recoverReviews(),
    deps.resumeCodeGeneration(),
    deps.reconcileSandboxes().catch((error: unknown) => {
      deps.onInitialReconcileError?.(error);
    }),
  ]);
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