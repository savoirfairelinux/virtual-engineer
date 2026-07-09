/**
 * Runtime registry — maps {@link RuntimeId}s to concrete {@link WorkspaceRunner}
 * instances and resolves a runner for a given task's runtime selection.
 *
 * The registry holds live runner instances (runners are stateful and support
 * hot-swapping their agent adapter via `updateRuntime`). Selection uses the
 * project → agent → default fallback chain; if the resolved id is not
 * registered, the registry falls back to its configured default runtime so a
 * mis-configured project can never leave a task without a runner.
 */

import type { WorkspaceRunner } from "../interfaces.js";
import { getLogger } from "../logger.js";
import {
  DEFAULT_RUNTIME_ID,
  resolveRuntimeId,
  type RuntimeId,
  type RuntimeSelection,
} from "./runtimeProfile.js";

const log = getLogger("runtime-registry");

export class RuntimeRegistry {
  private readonly runners = new Map<RuntimeId, WorkspaceRunner>();
  private defaultId: RuntimeId;

  constructor(defaultId: RuntimeId = DEFAULT_RUNTIME_ID) {
    this.defaultId = defaultId;
  }

  /** Register (or replace) the runner for a runtime id. Chainable. */
  register(id: RuntimeId, runner: WorkspaceRunner): this {
    this.runners.set(id, runner);
    return this;
  }

  /** Is a runner registered for this id? */
  has(id: RuntimeId): boolean {
    return this.runners.has(id);
  }

  /** Get the runner for an id, or throw if none is registered. */
  get(id: RuntimeId): WorkspaceRunner {
    const runner = this.runners.get(id);
    if (!runner) {
      throw new Error(`No workspace runner registered for runtime '${id}'`);
    }
    return runner;
  }

  /** All registered runtime ids. */
  list(): RuntimeId[] {
    return [...this.runners.keys()];
  }

  /** The current default runtime id. */
  getDefaultId(): RuntimeId {
    return this.defaultId;
  }

  /** Set the default runtime id. Throws if no runner is registered for it. */
  setDefault(id: RuntimeId): void {
    if (!this.runners.has(id)) {
      throw new Error(`Cannot set default runtime to unregistered runtime '${id}'`);
    }
    this.defaultId = id;
  }

  /**
   * Resolve a {@link WorkspaceRunner} for a task's runtime selection. The
   * registry's own default fills the `default` tier when the caller leaves it
   * unset. If the resolved runtime has no registered runner, it degrades to the
   * default runner and logs a warning rather than throwing.
   */
  resolve(selection: RuntimeSelection = {}): WorkspaceRunner {
    const resolved = resolveRuntimeId({ ...selection, default: selection.default ?? this.defaultId });
    if (this.runners.has(resolved)) {
      return this.get(resolved);
    }
    log.warn(
      { requested: resolved, fallback: this.defaultId },
      "resolved runtime has no registered runner; falling back to default"
    );
    return this.get(this.defaultId);
  }
}
