import type { Task } from "../interfaces.js";
import { getLogger } from "../logger.js";
import type { ManagedOpenShellProviderRecord } from "../state/stores/openShellProviderStore.js";
import type { ListSandboxesInput, SandboxInventoryItem } from "./openShellClient.js";
import {
  VE_SANDBOX_MANAGER_LABEL,
  VE_SANDBOX_MANAGER_VALUE,
  VE_SANDBOX_TASK_HASH_LABEL,
  sandboxTaskHash,
} from "./sandboxOwnership.js";

const log = getLogger("openshell-sandbox-reconciler");
const INVENTORY_PAGE_SIZE = 100;
const MAX_INVENTORY_PAGES = 10;

export interface SandboxReconcileResult {
  scanned: number;
  deleted: number;
  failed: number;
  skippedActive: number;
  skippedRecent: number;
  skippedForeign: number;
  providers: {
    scanned: number;
    deleted: number;
    failed: number;
    skippedActive: number;
    skippedRecent: number;
    skippedAttached: number;
  };
}

export interface OpenShellSandboxReconcilerDeps {
  client: {
    listSandboxes(input: ListSandboxesInput): Promise<SandboxInventoryItem[]>;
    removeSandbox(name: string): Promise<void>;
    removeProvider(name: string): Promise<void>;
  };
  store: {
    getActiveTasks(): Promise<Task[]>;
    listManagedOpenShellProviders(): Promise<ManagedOpenShellProviderRecord[]>;
    deleteManagedOpenShellProvider(providerName: string): Promise<void>;
  };
  now?: (() => Date) | undefined;
  minAgeMs?: number | undefined;
}

export async function reconcileOpenShellSandboxes(
  deps: OpenShellSandboxReconcilerDeps
): Promise<SandboxReconcileResult> {
  const result: SandboxReconcileResult = {
    scanned: 0,
    deleted: 0,
    failed: 0,
    skippedActive: 0,
    skippedRecent: 0,
    skippedForeign: 0,
    providers: {
      scanned: 0,
      deleted: 0,
      failed: 0,
      skippedActive: 0,
      skippedRecent: 0,
      skippedAttached: 0,
    },
  };
  const selector = `${VE_SANDBOX_MANAGER_LABEL}=${VE_SANDBOX_MANAGER_VALUE}`;
  const sandboxes: SandboxInventoryItem[] = [];
  const activeTasksPromise = deps.store.getActiveTasks();
  const managedProvidersPromise = deps.store.listManagedOpenShellProviders();
  for (let page = 0; page < MAX_INVENTORY_PAGES; page++) {
    const items = await deps.client.listSandboxes({
      limit: INVENTORY_PAGE_SIZE,
      offset: page * INVENTORY_PAGE_SIZE,
      selector,
    });
    sandboxes.push(...items);
    if (items.length < INVENTORY_PAGE_SIZE) break;
  }
  const activeTasks = await activeTasksPromise;
  const managedProviders = await managedProvidersPromise;
  result.scanned = sandboxes.length;
  result.providers.scanned = managedProviders.length;
  const activeTaskHashes = new Set(activeTasks.map((task) => sandboxTaskHash(String(task.taskId))));
  const nowMs = (deps.now?.() ?? new Date()).getTime();
  const minAgeMs = deps.minAgeMs ?? 10 * 60_000;
  const existingSandboxNames = new Set(sandboxes.map((sandbox) => sandbox.name));
  const removedSandboxNames = new Set<string>();

  for (const sandbox of sandboxes) {
    const managed = sandbox.labels[VE_SANDBOX_MANAGER_LABEL] === VE_SANDBOX_MANAGER_VALUE;
    const taskHash = sandbox.labels[VE_SANDBOX_TASK_HASH_LABEL];
    if (!managed || taskHash === undefined || !sandbox.name.startsWith("ve-")) {
      result.skippedForeign += 1;
      continue;
    }
    if (activeTaskHashes.has(taskHash)) {
      result.skippedActive += 1;
      continue;
    }
    if (nowMs - sandbox.createdAt.getTime() < minAgeMs) {
      result.skippedRecent += 1;
      continue;
    }
    try {
      await deps.client.removeSandbox(sandbox.name);
      removedSandboxNames.add(sandbox.name);
      result.deleted += 1;
      log.info({ sandbox: sandbox.name, phase: sandbox.phase }, "deleted orphaned VE sandbox");
    } catch (err) {
      result.failed += 1;
      log.warn({ err, sandbox: sandbox.name }, "failed to delete orphaned VE sandbox");
    }
  }

  for (const provider of managedProviders) {
    if (activeTaskHashes.has(provider.taskHash)) {
      result.providers.skippedActive += 1;
      continue;
    }
    if (nowMs - provider.createdAt.getTime() < minAgeMs) {
      result.providers.skippedRecent += 1;
      continue;
    }
    if (existingSandboxNames.has(provider.sandboxName) && !removedSandboxNames.has(provider.sandboxName)) {
      result.providers.skippedAttached += 1;
      continue;
    }
    try {
      await deps.client.removeProvider(provider.providerName);
      await deps.store.deleteManagedOpenShellProvider(provider.providerName);
      result.providers.deleted += 1;
      log.info({ provider: provider.providerName }, "deleted orphaned VE provider");
    } catch (err) {
      result.providers.failed += 1;
      log.warn({ err, provider: provider.providerName }, "failed to delete orphaned VE provider");
    }
  }

  return result;
}

export class OpenShellSandboxReconciler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly deps: OpenShellSandboxReconcilerDeps,
    private readonly intervalMs = 15 * 60_000,
  ) {}

  async run(): Promise<SandboxReconcileResult | null> {
    if (this.running) return null;
    this.running = true;
    try {
      return await reconcileOpenShellSandboxes(this.deps);
    } finally {
      this.running = false;
    }
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      this.run().catch((err: unknown) => {
        log.warn({ err }, "periodic sandbox reconciliation failed");
      });
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
