/**
 * OpenShellWorkspaceRunner — the `openshell` runtime backend implementing the
 * shared {@link WorkspaceRunner} contract.
 *
 * Composition (per the locked design):
 * - Git plumbing (clone / checkout / cherry-pick / diff) runs natively on the
 *   orchestrator via {@link HostGitExecutor}. Push stays host-side (src/vcs),
 *   so push credentials never enter the agent sandbox.
 * - Agent execution runs in an OpenShell sandbox via {@link OpenShellClient},
 *   with a deny-by-default policy applied before the agent starts.
 *
 * The default runtime remains Docker; this backend is selected per project/agent
 * once registered in the RuntimeRegistry.
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
import { getLogger } from "../logger.js";
import type { HostGitExecutor } from "./hostGitExecutor.js";
import type { OpenShellClient } from "../openshell/openShellClient.js";

const log = getLogger("openshell-workspace-runner");

/** Resolves the policy YAML to apply for a given task + execution mode. */
export type PolicyResolver = (input: {
  taskId: string;
  mode: "coding" | "review";
}) => string | undefined;

export interface OpenShellRunnerDeps {
  git: HostGitExecutor;
  client: OpenShellClient;
  /** Reported on WorkspaceHandle.containerImage (sandbox base image / BYOC ref). */
  sandboxImage: string;
  /** Agent to launch in the sandbox (`claude` | `codex` | `opencode` | `copilot`). */
  agent?: string | undefined;
  /** Optional per-task policy resolver; when it returns YAML, it is applied pre-exec. */
  resolvePolicy?: PolicyResolver | undefined;
}

/** Build the Gerrit-style change ref (`refs/changes/NN/NNNN/P`). */
function changeRef(revisionNumber: number, patchset: number): string {
  const shard = String(revisionNumber % 100).padStart(2, "0");
  return `refs/changes/${shard}/${revisionNumber}/${patchset}`;
}

export class OpenShellWorkspaceRunner implements WorkspaceRunner {
  private readonly dirs = new Map<string, string>();

  constructor(private readonly deps: OpenShellRunnerDeps) {}

  private handleFor(taskId: TaskId, dir: string): WorkspaceHandle {
    return {
      taskId,
      containerId: `openshell:${taskId}`,
      volumeName: dir,
      homeVolumeName: dir,
      hostWorkspacePath: dir,
      containerImage: this.deps.sandboxImage,
    };
  }

  async createWorkspace(taskId: TaskId): Promise<WorkspaceHandle> {
    const ws = await this.deps.git.createWorkspace(String(taskId));
    this.dirs.set(String(taskId), ws.dir);
    return this.handleFor(taskId, ws.dir);
  }

  async cloneRepo(handle: WorkspaceHandle, repoUrl: string, branch: string): Promise<CloneResult> {
    try {
      await this.deps.git.cloneRepo(handle.hostWorkspacePath, repoUrl, branch);
      return { success: true, localPath: handle.hostWorkspacePath };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { success: false, localPath: handle.hostWorkspacePath, error };
    }
  }

  async prepareProjectWorkspace(
    handle: WorkspaceHandle,
    pushTargets: ProjectPushTargetRecord[]
  ): Promise<CloneResult> {
    const ordered = [...pushTargets].sort((a, b) => a.commitOrder - b.commitOrder);
    const root = ordered.find((t) => t.localPath === ".") ?? ordered[0];
    if (!root) {
      return { success: false, localPath: handle.hostWorkspacePath, error: "no push targets" };
    }
    try {
      await this.deps.git.cloneRepo(handle.hostWorkspacePath, root.cloneUrl, root.targetBranch, root.localPath);
      for (const target of ordered) {
        if (target === root) continue;
        try {
          await this.deps.git.cloneRepo(
            handle.hostWorkspacePath,
            target.cloneUrl,
            target.targetBranch,
            target.localPath
          );
        } catch (err) {
          // Per-target failures are non-fatal (mirrors the Docker runner).
          log.warn({ repoKey: target.repoKey, err }, "secondary push-target clone failed");
        }
      }
      return { success: true, localPath: handle.hostWorkspacePath };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { success: false, localPath: handle.hostWorkspacePath, error };
    }
  }

  async applyPriorPatchset(handle: WorkspaceHandle, opts: PatchsetCheckoutOptions): Promise<void> {
    await this.deps.git.fetchAndCheckout(
      handle.hostWorkspacePath,
      opts.vcsBaseUrl,
      changeRef(opts.revisionNumber, opts.patchset)
    );
  }

  async cherryPickPriorPatchset(handle: WorkspaceHandle, opts: PatchsetCheckoutOptions): Promise<void> {
    await this.deps.git.fetchAndCherryPick(
      handle.hostWorkspacePath,
      opts.vcsBaseUrl,
      changeRef(opts.revisionNumber, opts.patchset)
    );
  }

  async execGitInVolume(handle: WorkspaceHandle, args: string[], subPath?: string): Promise<string> {
    return this.deps.git.execGit(handle.hostWorkspacePath, args, subPath);
  }

  /** Apply the resolved policy (if any) to a freshly-created sandbox. */
  private async applyPolicy(taskId: string, mode: "coding" | "review"): Promise<void> {
    const yaml = this.deps.resolvePolicy?.({ taskId, mode });
    if (yaml) {
      await this.deps.client.setPolicy(`ve-${taskId}`, yaml);
    }
  }

  async runReviewInDocker(
    handle: WorkspaceHandle,
    input: ReviewWorkspaceInput
  ): Promise<{ rawOutput: string }> {
    const taskId = String(handle.taskId);
    const name = `ve-${taskId}`;
    const agent = this.deps.agent;
    await this.deps.client.createSandbox({ name, ...(agent ? { agent } : {}) });
    await this.applyPolicy(taskId, "review");
    const result = await this.deps.client.execInSandbox({
      name,
      command: ["ve-run-review", "--change", String(input.changeId)],
    });
    return { rawOutput: result.stdout };
  }

  async runAgentInDocker(
    _adapter: AgentAdapter,
    context: TaskContext
  ): Promise<{ stdout: string; stderr: string }> {
    const taskId = String(context.taskId);
    const name = `ve-${taskId}`;
    const agent = this.deps.agent;
    await this.deps.client.createSandbox({ name, ...(agent ? { agent } : {}) });
    await this.applyPolicy(taskId, "coding");
    const result = await this.deps.client.execInSandbox({ name, command: ["ve-run-agent"] });
    return { stdout: result.stdout, stderr: result.stderr };
  }

  async runAgent(handle: WorkspaceHandle, context: TaskContext, adapter?: AgentAdapter): Promise<AgentResult> {
    if (!adapter) {
      throw new Error("OpenShellWorkspaceRunner.runAgent requires an agent adapter");
    }
    const { stdout, stderr } = await this.runAgentInDocker(adapter, context);
    const modifiedFiles = await this.deps.git
      .listModifiedFiles(handle.hostWorkspacePath)
      .catch(() => [] as string[]);
    return {
      status: modifiedFiles.length > 0 ? "success" : "no_change",
      modifiedFiles,
      summary: stdout.slice(0, 4000),
      agentLogs: `${stdout}\n${stderr}`,
      metadata: { runtime: "openshell" },
    };
  }

  async destroyWorkspace(handle: WorkspaceHandle): Promise<void> {
    await this.deps.client.removeSandbox(`ve-${String(handle.taskId)}`);
    await this.deps.git.destroyWorkspace(handle.hostWorkspacePath);
    this.dirs.delete(String(handle.taskId));
  }
}
