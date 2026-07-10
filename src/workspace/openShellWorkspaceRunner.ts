/**
 * OpenShellWorkspaceRunner — the `openshell` runtime backend implementing the
 * shared {@link WorkspaceRunner} contract.
 *
 * Composition (per the locked design):
 * - Git plumbing (clone / checkout / cherry-pick / diff) runs natively on the
 *   orchestrator via {@link HostGitExecutor}. Push stays host-side (src/vcs),
 *   so push credentials never enter the agent sandbox.
 * - Agent execution runs in an OpenShell sandbox via {@link OpenShellClient}
 *   using an upload → exec → download lifecycle, with a deny-by-default policy
 *   applied before the agent starts.
 *
 * This is the sole workspace runtime: the gateway's Kubernetes driver schedules
 * each sandbox as an ephemeral Pod on the cluster (k3s).
 */

import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "node:crypto";
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

/** Where the workspace is mounted inside the sandbox and where the prompt lands. */
const SANDBOX_WORKSPACE = "/workspace";
const SANDBOX_PROMPT_FILE = "/tmp/user-prompt.txt";

/** Adapter shape that resolves prompts (SYSTEM/USER) at container-spec build time. */
type PromptAwareAgentAdapter = AgentAdapter & {
  buildContainerSpecWithPrompts(
    context: TaskContext,
    authEnv?: Record<string, string>
  ): Promise<AgentSpec>;
};

/** Adapter shape that builds a review container spec. */
type ReviewAgentAdapter = AgentAdapter & {
  buildReviewContainerSpec(input: ReviewWorkspaceInput, authEnv?: Record<string, string>): AgentSpec;
};

interface AgentSpec {
  env: Record<string, string>;
  image: string;
  command: string[];
  networkMode?: string | undefined;
  additionalDockerArgs?: string[] | undefined;
  userPromptContent?: string | undefined;
}

function isPromptAware(adapter: AgentAdapter): adapter is PromptAwareAgentAdapter {
  return typeof (adapter as Partial<PromptAwareAgentAdapter>).buildContainerSpecWithPrompts === "function";
}

function hasReviewSpec(adapter: AgentAdapter): adapter is ReviewAgentAdapter {
  return typeof (adapter as Partial<ReviewAgentAdapter>).buildReviewContainerSpec === "function";
}

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
  /** Agent adapter used to build the sandbox spec (env/image/command) and review specs. */
  agentAdapter?: AgentAdapter | undefined;
  /** Optional per-task policy resolver; when it returns YAML, it is applied pre-exec. */
  resolvePolicy?: PolicyResolver | undefined;
  /** Exec timeout in seconds (0 = no timeout). */
  execTimeoutSec?: number | undefined;
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
    pushTargets: ProjectPushTargetRecord[],
    _postCloneScript?: string,
    sshKnownHostsPath?: string,
  ): Promise<CloneResult> {
    const ordered = [...pushTargets].sort((a, b) => a.commitOrder - b.commitOrder);
    const root = ordered.find((t) => t.localPath === ".") ?? ordered[0];
    if (!root) {
      return { success: false, localPath: handle.hostWorkspacePath, error: "no push targets" };
    }
    try {
      await this.deps.git.cloneRepo(
        handle.hostWorkspacePath,
        root.cloneUrl,
        root.targetBranch,
        root.localPath,
        root.sshKeyPath,
        sshKnownHostsPath,
      );
      for (const target of ordered) {
        if (target === root) continue;
        try {
          await this.deps.git.cloneRepo(
            handle.hostWorkspacePath,
            target.cloneUrl,
            target.targetBranch,
            target.localPath,
            target.sshKeyPath,
            sshKnownHostsPath,
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
      changeRef(opts.revisionNumber, opts.patchset),
      ".",
      opts.sshKeyPath ?? null,
      opts.sshKnownHostsPath ?? null,
    );
  }

  async cherryPickPriorPatchset(handle: WorkspaceHandle, opts: PatchsetCheckoutOptions): Promise<void> {
    await this.deps.git.fetchAndCherryPick(
      handle.hostWorkspacePath,
      opts.vcsBaseUrl,
      changeRef(opts.revisionNumber, opts.patchset),
      ".",
      opts.sshKeyPath ?? null,
      opts.sshKnownHostsPath ?? null,
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

  /** Write the prompt to a host temp file, upload it into the sandbox, return the sandbox path. */
  private async uploadPrompt(name: string, content: string): Promise<string> {
    const tmp = join(tmpdir(), `ve-prompt-${randomUUID()}.txt`);
    await writeFile(tmp, content, "utf8");
    try {
      await this.deps.client.uploadToSandbox({ name, localPath: tmp, dest: SANDBOX_PROMPT_FILE });
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
    return SANDBOX_PROMPT_FILE;
  }

  private execTimeout(): { timeout: number } | Record<string, never> {
    return this.deps.execTimeoutSec !== undefined ? { timeout: this.deps.execTimeoutSec } : {};
  }

  async runReviewInDocker(
    handle: WorkspaceHandle,
    input: ReviewWorkspaceInput
  ): Promise<{ rawOutput: string }> {
    const taskId = String(handle.taskId);
    const name = `ve-${taskId}`;
    const dir = this.dirs.get(taskId) ?? handle.hostWorkspacePath;
    const adapter = this.deps.agentAdapter;
    if (!adapter || !hasReviewSpec(adapter)) {
      throw new Error("OpenShellWorkspaceRunner.runReviewInDocker requires a review-capable agent adapter");
    }
    const spec = adapter.buildReviewContainerSpec(input);

    await this.deps.client.createSandbox({ name, from: spec.image });
    await this.applyPolicy(taskId, "review");
    // Read-only workspace: upload the repo so the review agent sees the diff. No download back.
    await this.deps.client.uploadToSandbox({
      name,
      localPath: dir,
      dest: SANDBOX_WORKSPACE,
      noGitIgnore: true,
    });
    const env = { ...spec.env, USER_PROMPT_FILE: await this.uploadPrompt(name, input.prompt) };
    const result = await this.deps.client.execInSandbox({
      name,
      command: spec.command,
      env,
      workdir: SANDBOX_WORKSPACE,
      ...this.execTimeout(),
    });
    return { rawOutput: result.stdout };
  }

  async runAgentInDocker(
    adapter: AgentAdapter,
    context: TaskContext,
    authEnv: Record<string, string> = {}
  ): Promise<{ stdout: string; stderr: string }> {
    // `authEnv` carries the agent's own inference credential (e.g. GITHUB_TOKEN
    // for Copilot), which the agent legitimately needs and is baked into the
    // adapter spec env below. Push/review-system credentials are handled entirely
    // host-side in src/vcs and are never passed to this method.
    const taskId = String(context.taskId);
    const name = `ve-${taskId}`;
    const dir = this.dirs.get(taskId) ?? context.workspacePath;
    const spec = isPromptAware(adapter)
      ? await adapter.buildContainerSpecWithPrompts(context, authEnv)
      : adapter.buildContainerSpec(context, authEnv);

    await this.deps.client.createSandbox({ name, from: spec.image, env: spec.env });
    await this.applyPolicy(taskId, "coding");
    // Upload the full workspace (incl. .git) so the agent can commit inside the sandbox.
    await this.deps.client.uploadToSandbox({
      name,
      localPath: dir,
      dest: SANDBOX_WORKSPACE,
      noGitIgnore: true,
    });
    const env = { ...spec.env };
    if (spec.userPromptContent !== undefined) {
      env["USER_PROMPT_FILE"] = await this.uploadPrompt(name, spec.userPromptContent);
    }
    const result = await this.deps.client.execInSandbox({
      name,
      command: spec.command,
      env,
      workdir: SANDBOX_WORKSPACE,
      ...this.execTimeout(),
    });
    // Pull the agent's commits/changes back to the host for host-side push.
    await this.deps.client.downloadFromSandbox({
      name,
      sandboxPath: SANDBOX_WORKSPACE,
      localDest: dir,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  }

  async runAgent(_handle: WorkspaceHandle, context: TaskContext, adapter?: AgentAdapter): Promise<AgentResult> {
    const resolved = adapter ?? this.deps.agentAdapter;
    if (!resolved) {
      throw new Error("OpenShellWorkspaceRunner.runAgent requires an agent adapter");
    }
    // Delegate to the adapter, exactly like the former Docker runner: the adapter
    // resolves auth, builds prompts, invokes the configured docker-invoker
    // (this runner's runAgentInDocker → sandbox upload/exec/download), and parses
    // the streamed output into an AgentResult (commits, cost, change-ids).
    return resolved.execute(context);
  }

  async destroyWorkspace(handle: WorkspaceHandle): Promise<void> {
    await this.deps.client.removeSandbox(`ve-${String(handle.taskId)}`);
    await this.deps.git.destroyWorkspace(handle.hostWorkspacePath);
    this.dirs.delete(String(handle.taskId));
  }
}
