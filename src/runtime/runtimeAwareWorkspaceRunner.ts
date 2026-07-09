/**
 * RuntimeAwareWorkspaceRunner — a {@link WorkspaceRunner} facade that resolves,
 * per task, which concrete runner (docker | openshell) to delegate to.
 *
 * The orchestrator, polling loop, and review trigger depend only on the
 * {@link WorkspaceRunner} contract; this facade injects runtime selection so
 * they stay runtime-agnostic. A `SelectionResolver` maps a task id to its
 * {@link RuntimeSelection} (project → agent overrides); when unset or when only
 * one runtime is registered, resolution collapses to the registry default,
 * making behaviour identical to the previous single-runner setup.
 */

import type {
  AgentAdapter,
  AgentResult,
  CloneResult,
  PatchsetCheckoutOptions,
  ProjectPushTargetRecord,
  ReviewWorkspaceInput,
  TaskContext,
  TaskId,
  WorkspaceHandle,
  WorkspaceRunner,
} from "../interfaces.js";
import type { RuntimeRegistry } from "./runtimeRegistry.js";
import type { RuntimeSelection } from "./runtimeProfile.js";

/** Resolve the runtime selection for a task. Sync or async. */
export type SelectionResolver = (taskId: TaskId) => RuntimeSelection | Promise<RuntimeSelection>;

export class RuntimeAwareWorkspaceRunner implements WorkspaceRunner {
  private readonly runnersByTask = new Map<string, WorkspaceRunner>();

  constructor(
    private readonly registry: RuntimeRegistry,
    private readonly resolveSelection: SelectionResolver
  ) {}

  private async runnerFor(taskId: TaskId): Promise<WorkspaceRunner> {
    const pinned = this.runnersByTask.get(String(taskId));
    if (pinned) return pinned;
    const selection = await this.resolveSelection(taskId);
    return this.registry.resolve(selection);
  }

  async createWorkspace(taskId: TaskId): Promise<WorkspaceHandle> {
    const runner = await this.runnerFor(taskId);
    const handle = await runner.createWorkspace(taskId);
    this.runnersByTask.set(String(taskId), runner);
    return handle;
  }

  async cloneRepo(
    handle: WorkspaceHandle,
    repoUrl: string,
    branch: string,
    sshKeyPath?: string,
    sshKnownHostsPath?: string
  ): Promise<CloneResult> {
    return (await this.runnerFor(handle.taskId)).cloneRepo(handle, repoUrl, branch, sshKeyPath, sshKnownHostsPath);
  }

  async prepareProjectWorkspace(
    handle: WorkspaceHandle,
    pushTargets: ProjectPushTargetRecord[],
    postCloneScript?: string,
    sshKnownHostsPath?: string
  ): Promise<CloneResult> {
    const runner = await this.runnerFor(handle.taskId);
    if (!runner.prepareProjectWorkspace) {
      throw new Error("resolved runtime does not support prepareProjectWorkspace");
    }
    return runner.prepareProjectWorkspace(handle, pushTargets, postCloneScript, sshKnownHostsPath);
  }

  async applyPriorPatchset(handle: WorkspaceHandle, opts: PatchsetCheckoutOptions): Promise<void> {
    const runner = await this.runnerFor(handle.taskId);
    if (!runner.applyPriorPatchset) throw new Error("resolved runtime does not support applyPriorPatchset");
    return runner.applyPriorPatchset(handle, opts);
  }

  async cherryPickPriorPatchset(handle: WorkspaceHandle, opts: PatchsetCheckoutOptions): Promise<void> {
    const runner = await this.runnerFor(handle.taskId);
    if (!runner.cherryPickPriorPatchset) throw new Error("resolved runtime does not support cherryPickPriorPatchset");
    return runner.cherryPickPriorPatchset(handle, opts);
  }

  async runReviewInDocker(
    handle: WorkspaceHandle,
    input: ReviewWorkspaceInput,
    callbacks?: { onStderrChunk?: ((chunk: string) => void) | undefined } | undefined
  ): Promise<{ rawOutput: string }> {
    const runner = await this.runnerFor(handle.taskId);
    if (!runner.runReviewInDocker) throw new Error("resolved runtime does not support runReviewInDocker");
    return runner.runReviewInDocker(handle, input, callbacks);
  }

  async runAgentInDocker(
    adapter: AgentAdapter,
    context: TaskContext,
    authEnv?: Record<string, string>,
    callbacks?:
      | { onStdoutChunk?: ((chunk: string) => void) | undefined; onStderrChunk?: ((chunk: string) => void) | undefined }
      | undefined
  ): Promise<{ stdout: string; stderr: string }> {
    const runner = await this.runnerFor(context.taskId);
    if (!runner.runAgentInDocker) throw new Error("resolved runtime does not support runAgentInDocker");
    return runner.runAgentInDocker(adapter, context, authEnv, callbacks);
  }

  async runAgent(handle: WorkspaceHandle, context: TaskContext, adapter?: AgentAdapter): Promise<AgentResult> {
    return (await this.runnerFor(handle.taskId)).runAgent(handle, context, adapter);
  }

  async execGitInVolume(handle: WorkspaceHandle, args: string[], subPath?: string): Promise<string> {
    const runner = await this.runnerFor(handle.taskId);
    if (!runner.execGitInVolume) throw new Error("resolved runtime does not support execGitInVolume");
    return runner.execGitInVolume(handle, args, subPath);
  }

  async destroyWorkspace(handle: WorkspaceHandle): Promise<void> {
    const taskId = String(handle.taskId);
    const runner = await this.runnerFor(handle.taskId);
    try {
      await runner.destroyWorkspace(handle);
    } finally {
      this.runnersByTask.delete(taskId);
    }
  }
}
