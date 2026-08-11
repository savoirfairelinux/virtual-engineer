import { createHash } from "node:crypto";

export const VE_SANDBOX_MANAGER_LABEL = "app.kubernetes.io/managed-by";
export const VE_SANDBOX_MANAGER_VALUE = "virtual-engineer";
export const VE_SANDBOX_TASK_HASH_LABEL = "virtual-engineer/task-hash";

export function sandboxTaskHash(taskId: string): string {
  return createHash("sha256").update(taskId).digest("hex").slice(0, 16);
}

export function sandboxOwnershipLabels(taskId: string): Record<string, string> {
  return {
    [VE_SANDBOX_MANAGER_LABEL]: VE_SANDBOX_MANAGER_VALUE,
    [VE_SANDBOX_TASK_HASH_LABEL]: sandboxTaskHash(taskId),
  };
}
