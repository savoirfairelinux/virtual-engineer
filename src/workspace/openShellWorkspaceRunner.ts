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
import { join, basename } from "path";
import { createHash, randomUUID } from "node:crypto";
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
import { credentialFreeUrl, type HostGitExecutor } from "./hostGitExecutor.js";
import type { OpenShellClient } from "../openshell/openShellClient.js";
import { redactOpenShellText } from "../openshell/openShellClient.js";
import { decodeReviewWorkerOutput } from "./agentWorkerProtocol.js";
import { parseDenialEvent, type DenialSink } from "../openshell/denyEventPoller.js";
import { sandboxOwnershipLabels, sandboxTaskHash } from "../openshell/sandboxOwnership.js";
import type { ManagedOpenShellProviderRecord } from "../state/stores/openShellProviderStore.js";

const log = getLogger("openshell-workspace-runner");

/** Where the workspace is mounted inside the sandbox and where the prompt lands. */
// OpenShell's default sandbox policy makes `/sandbox` the writable working
// directory (read_write). `/workspace` is read-only under that policy, so the
// repo upload/exec/download all target `/sandbox`.
const SANDBOX_WORKSPACE = "/sandbox";
const SANDBOX_PROMPT_FILE = "/tmp/user-prompt.txt";
const MAX_DENIAL_FINGERPRINTS_PER_SANDBOX = 1_000;
const AGENT_CREDENTIAL_PROVIDER_TYPES = {
  GITHUB_TOKEN: "copilot",
  ANTHROPIC_API_KEY: "claude-code",
  CLAUDE_CODE_OAUTH_TOKEN: "generic",
} as const;

interface ManagedProviderSpec {
  name: string;
  type: string;
  credentials: Record<string, string>;
}

function splitManagedProviderEnv(
  sandboxName: string,
  source: Readonly<Record<string, string>>,
): { env: Record<string, string>; provider?: ManagedProviderSpec | undefined } {
  const env: Record<string, string> = {};
  let provider: ManagedProviderSpec | undefined;
  for (const [key, value] of Object.entries(source)) {
    const type = AGENT_CREDENTIAL_PROVIDER_TYPES[key as keyof typeof AGENT_CREDENTIAL_PROVIDER_TYPES];
    if (type === undefined) {
      env[key] = value;
      continue;
    }
    if (provider !== undefined) {
      throw new Error("Agent sandbox spec contains multiple managed credentials");
    }
    provider = {
      name: `${sandboxName}-agent`,
      type,
      credentials: { [key]: value },
    };
  }
  return { env, ...(provider !== undefined ? { provider } : {}) };
}

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
  egress?: { hosts: string[]; binaries: string[] } | undefined;
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
}) => string | undefined | Promise<string | undefined>;

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
  /** Best-effort sink for policy denials observed in sandbox logs. */
  recordDenial?: DenialSink | undefined;
  /** Restart-safe ownership ledger for temporary credential providers. */
  managedProviderStore: {
    recordManagedOpenShellProvider(record: ManagedOpenShellProviderRecord): Promise<void>;
    deleteManagedOpenShellProvider(providerName: string): Promise<void>;
  };
}

/** Build the Gerrit-style change ref (`refs/changes/NN/NNNN/P`). */
function changeRef(revisionNumber: number, patchset: number): string {
  const shard = String(revisionNumber % 100).padStart(2, "0");
  return `refs/changes/${shard}/${revisionNumber}/${patchset}`;
}

export class OpenShellWorkspaceRunner implements WorkspaceRunner {
  private readonly dirs = new Map<string, string>();
  private readonly sandboxNames = new Map<string, string>();
  private readonly providerNames = new Map<string, string>();
  private readonly removedSandboxes = new Set<string>();
  private readonly trustedRemotes = new Map<string, Map<string, string>>();
  private readonly postCloneScripts = new Map<string, string>();
  private readonly denialFingerprints = new Map<string, Set<string>>();

  constructor(private readonly deps: OpenShellRunnerDeps) {}

  private handleFor(taskId: TaskId, dir: string, sandboxName: string): WorkspaceHandle {
    return {
      taskId,
      containerId: `openshell:${sandboxName}`,
      volumeName: dir,
      homeVolumeName: dir,
      hostWorkspacePath: dir,
      containerImage: this.deps.sandboxImage,
    };
  }

  async createWorkspace(taskId: TaskId): Promise<WorkspaceHandle> {
    const ws = await this.deps.git.createWorkspace(String(taskId));
    const sandboxName = `ve-${String(taskId)}-${randomUUID().slice(0, 8)}`;
    const handle = this.handleFor(taskId, ws.dir, sandboxName);
    this.dirs.set(handle.containerId, ws.dir);
    this.sandboxNames.set(handle.containerId, sandboxName);
    return handle;
  }

  private attemptKey(taskId: string, runtimeHandleId?: string): string {
    return runtimeHandleId ?? `openshell:${taskId}`;
  }

  private sandboxName(taskId: string, runtimeHandleId?: string): string {
    return this.sandboxNames.get(this.attemptKey(taskId, runtimeHandleId)) ?? `ve-${taskId}`;
  }

  async cloneRepo(handle: WorkspaceHandle, repoUrl: string, branch: string): Promise<CloneResult> {
    try {
      await this.deps.git.cloneRepo(handle.hostWorkspacePath, repoUrl, branch);
      this.rememberTrustedRemote(handle.containerId, ".", repoUrl);
      return { success: true, localPath: handle.hostWorkspacePath };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { success: false, localPath: handle.hostWorkspacePath, error };
    }
  }

  async prepareProjectWorkspace(
    handle: WorkspaceHandle,
    pushTargets: ProjectPushTargetRecord[],
    postCloneScript?: string,
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
      this.rememberTrustedRemote(handle.containerId, root.localPath, root.cloneUrl);
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
          this.rememberTrustedRemote(handle.containerId, target.localPath, target.cloneUrl);
        } catch (err) {
          // Per-target failures are non-fatal (mirrors the Docker runner).
          log.warn({ repoKey: target.repoKey, err }, "secondary push-target clone failed");
        }
      }
      if (postCloneScript?.trim()) this.postCloneScripts.set(handle.containerId, postCloneScript);
      return { success: true, localPath: handle.hostWorkspacePath };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { success: false, localPath: handle.hostWorkspacePath, error };
    }
  }

  private rememberTrustedRemote(taskId: string, localPath: string, cloneUrl: string): void {
    const remotes = this.trustedRemotes.get(taskId) ?? new Map<string, string>();
    remotes.set(localPath, credentialFreeUrl(cloneUrl));
    this.trustedRemotes.set(taskId, remotes);
  }

  private async restoreTrustedRemotes(taskId: string, dir: string): Promise<void> {
    const remotes = this.trustedRemotes.get(taskId);
    if (!remotes || remotes.size === 0) {
      throw new Error(`No trusted Git remotes recorded for task ${taskId}`);
    }
    await this.deps.git.rebuildTrustedMetadata(dir, remotes);
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

  private resolvePolicy(taskId: string, mode: "coding" | "review"): Promise<string | undefined> {
    return Promise.resolve(this.deps.resolvePolicy?.({ taskId, mode }));
  }

  /**
   * Open the agent's required network egress on a freshly-created sandbox.
   * OpenShell is deny-by-default; without this the agent's CLI cannot reach the
   * model API (CONNECT is rejected with 403). No-op when the spec declares none.
   */
  private async applyEgress(
    name: string,
    egress: AgentSpec["egress"],
    signal?: AbortSignal,
  ): Promise<void> {
    if (!egress || egress.hosts.length === 0) return;
    await this.deps.client.allowEgress({
      name,
      hosts: egress.hosts,
      binaries: egress.binaries,
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  /**
   * `openshell sandbox upload <dir> /sandbox` nests the directory under
   * `/sandbox/<basename(dir)>` (it always nests by basename — trailing `/` or
   * `/.` do not change this, and there is no rename form). Rather than copy the
   * (potentially large) repo back up to `/sandbox` — a slow cross-device move —
   * the runner runs the agent with its working directory set to this nested repo
   * path. `download` is contents-based (no nesting), so the coding flow downloads
   * this path straight back onto the host workspace dir.
   */
  private sandboxRepoPath(localPath: string): string {
    return `${SANDBOX_WORKSPACE}/${basename(localPath)}`;
  }

  /** Write the prompt to a host temp file, upload it into the sandbox, return the sandbox path. */
  private async uploadPrompt(name: string, content: string, signal?: AbortSignal): Promise<string> {
    const tmp = join(tmpdir(), `ve-prompt-${randomUUID()}.txt`);
    await writeFile(tmp, content, "utf8");
    try {
      await this.deps.client.uploadToSandbox({
        name,
        localPath: tmp,
        dest: SANDBOX_PROMPT_FILE,
        ...(signal !== undefined ? { signal } : {}),
      });
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
    return SANDBOX_PROMPT_FILE;
  }

  private execTimeout(): { timeout: number } | Record<string, never> {
    return this.deps.execTimeoutSec !== undefined ? { timeout: this.deps.execTimeoutSec } : {};
  }

  private assertExecSucceeded(result: { code: number; stderr: string }): void {
    if (result.code !== 0) {
      throw new Error(`OpenShell agent exited with code ${result.code}: ${redactOpenShellText(result.stderr).slice(0, 500)}`);
    }
  }

  private async collectPolicyDenials(name: string, taskId: string, projectId?: string): Promise<void> {
    if (this.deps.recordDenial === undefined) return;
    try {
      const logs = await this.deps.client.getSandboxLogs({ name, lines: 200, since: "75m" });
      const seen = this.denialFingerprints.get(name) ?? new Set<string>();
      this.denialFingerprints.set(name, seen);
      for (const line of logs.split(/\r?\n/)) {
        const denial = parseDenialEvent(line);
        if (denial === null) continue;
        const fingerprint = createHash("sha256").update(line.trim().replace(/\s+/g, " ")).digest("hex");
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        if (seen.size > MAX_DENIAL_FINGERPRINTS_PER_SANDBOX) {
          const oldest = seen.values().next().value;
          if (oldest !== undefined) seen.delete(oldest);
        }
        try {
          await this.deps.recordDenial({
            ...denial,
            taskId,
            ...(projectId !== undefined ? { projectId } : {}),
          });
        } catch (err) {
          seen.delete(fingerprint);
          throw err;
        }
      }
    } catch (err) {
      log.warn({ err, taskId, sandbox: name }, "failed to collect OpenShell policy denials");
    }
  }

  private async runPostCloneScript(
    name: string,
    attemptKey: string,
    repoDir: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const postCloneScript = this.postCloneScripts.get(attemptKey);
    if (postCloneScript === undefined) return;
    const result = await this.deps.client.execInSandbox({
      name,
      command: ["sh", "-lc", postCloneScript],
      workdir: repoDir,
      ...this.execTimeout(),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (result.code !== 0) {
      throw new Error(`OpenShell post-clone script failed with code ${result.code}: ${redactOpenShellText(result.stderr).slice(0, 500)}`);
    }
  }

  async runReviewInDocker(
    handle: WorkspaceHandle,
    input: ReviewWorkspaceInput,
    callbacks?: { onStderrChunk?: ((chunk: string) => void) | undefined } | undefined
  ): Promise<{ rawOutput: string }> {
    const taskId = String(handle.taskId);
    const name = this.sandboxName(taskId, handle.containerId);
    const dir = this.dirs.get(handle.containerId) ?? handle.hostWorkspacePath;
    const adapter = this.deps.agentAdapter;
    if (!adapter || !hasReviewSpec(adapter)) {
      throw new Error("OpenShellWorkspaceRunner.runReviewInDocker requires a review-capable agent adapter");
    }
    const spec = adapter.buildReviewContainerSpec(input);
    const providerEnv = splitManagedProviderEnv(name, spec.env);

    const policyYaml = await this.resolvePolicy(taskId, "review");
    try {
      if (providerEnv.provider !== undefined) {
        this.providerNames.set(handle.containerId, providerEnv.provider.name);
        await this.deps.managedProviderStore.recordManagedOpenShellProvider({
          providerName: providerEnv.provider.name,
          sandboxName: name,
          taskHash: sandboxTaskHash(taskId),
          createdAt: new Date(),
        });
        await this.deps.client.createProvider({
          ...providerEnv.provider,
          ...(input.abortSignal !== undefined ? { signal: input.abortSignal } : {}),
        });
      }
      await this.deps.client.createSandbox({
        name,
        from: spec.image,
        env: providerEnv.env,
        ...(providerEnv.provider !== undefined ? { providers: [providerEnv.provider.name] } : {}),
        labels: sandboxOwnershipLabels(taskId),
        ...(policyYaml !== undefined ? { policyYaml } : {}),
        beforeRetryCleanup: () => this.collectPolicyDenials(name, taskId, input.projectId),
        ...(input.abortSignal !== undefined ? { signal: input.abortSignal } : {}),
      });
      await this.applyEgress(name, spec.egress, input.abortSignal);
      // Read-only workspace: upload the repo so the review agent sees the diff. No download back.
      await this.deps.client.uploadToSandbox({
        name,
        localPath: dir,
        dest: SANDBOX_WORKSPACE,
        noGitIgnore: true,
        ...(input.abortSignal !== undefined ? { signal: input.abortSignal } : {}),
      });
      const repoDir = this.sandboxRepoPath(dir);
      await this.runPostCloneScript(name, handle.containerId, repoDir, input.abortSignal);
      const env = {
        USER_PROMPT_FILE: await this.uploadPrompt(name, input.prompt, input.abortSignal),
      };
      const result = await this.deps.client.execInSandbox({
        name,
        command: spec.command,
        env,
        workdir: repoDir,
        ...this.execTimeout(),
        ...(callbacks?.onStderrChunk !== undefined ? { onStderrChunk: callbacks.onStderrChunk } : {}),
        ...(input.abortSignal !== undefined ? { signal: input.abortSignal } : {}),
      });
      this.assertExecSucceeded(result);
      return { rawOutput: decodeReviewWorkerOutput(result.stdout) };
    } finally {
      await this.collectPolicyDenials(name, taskId, input.projectId);
    }
  }

  async runAgentInDocker(
    adapter: AgentAdapter,
    context: TaskContext,
    authEnv: Record<string, string> = {},
    callbacks?: {
      onStdoutChunk?: ((chunk: string) => void) | undefined;
      onStderrChunk?: ((chunk: string) => void) | undefined;
    } | undefined
  ): Promise<{ stdout: string; stderr: string }> {
    // `authEnv` carries the agent's own inference credential (e.g. GITHUB_TOKEN
    // for Copilot), which the agent legitimately needs and is baked into the
    // adapter spec env below. Push/review-system credentials are handled entirely
    // host-side in src/vcs and are never passed to this method.
    const taskId = String(context.taskId);
    const attemptKey = this.attemptKey(taskId, context.runtimeHandleId);
    const name = this.sandboxName(taskId, context.runtimeHandleId);
    const dir = this.dirs.get(attemptKey) ?? context.workspacePath;
    const spec = isPromptAware(adapter)
      ? await adapter.buildContainerSpecWithPrompts(context, authEnv)
      : adapter.buildContainerSpec(context, authEnv);
    const providerEnv = splitManagedProviderEnv(name, spec.env);

    const policyYaml = await this.resolvePolicy(taskId, "coding");
    try {
      if (providerEnv.provider !== undefined) {
        this.providerNames.set(attemptKey, providerEnv.provider.name);
        await this.deps.managedProviderStore.recordManagedOpenShellProvider({
          providerName: providerEnv.provider.name,
          sandboxName: name,
          taskHash: sandboxTaskHash(taskId),
          createdAt: new Date(),
        });
        await this.deps.client.createProvider({
          ...providerEnv.provider,
          ...(context.abortSignal !== undefined ? { signal: context.abortSignal } : {}),
        });
      }
      await this.deps.client.createSandbox({
        name,
        from: spec.image,
        env: providerEnv.env,
        ...(providerEnv.provider !== undefined ? { providers: [providerEnv.provider.name] } : {}),
        labels: sandboxOwnershipLabels(taskId),
        ...(policyYaml !== undefined ? { policyYaml } : {}),
        beforeRetryCleanup: () => this.collectPolicyDenials(name, taskId, context.projectId),
        ...(context.abortSignal !== undefined ? { signal: context.abortSignal } : {}),
      });
      await this.applyEgress(name, spec.egress, context.abortSignal);
      // Upload the full workspace (incl. .git) so the agent can commit inside the sandbox.
      await this.deps.client.uploadToSandbox({
        name,
        localPath: dir,
        dest: SANDBOX_WORKSPACE,
        noGitIgnore: true,
        ...(context.abortSignal !== undefined ? { signal: context.abortSignal } : {}),
      });
      const repoDir = this.sandboxRepoPath(dir);
      await this.runPostCloneScript(name, attemptKey, repoDir, context.abortSignal);
      const env: Record<string, string> = {};
      if (spec.userPromptContent !== undefined) {
        env["USER_PROMPT_FILE"] = await this.uploadPrompt(name, spec.userPromptContent, context.abortSignal);
      }
      const result = await this.deps.client.execInSandbox({
        name,
        command: spec.command,
        env,
        workdir: repoDir,
        ...this.execTimeout(),
        ...(callbacks?.onStdoutChunk !== undefined ? { onStdoutChunk: callbacks.onStdoutChunk } : {}),
        ...(callbacks?.onStderrChunk !== undefined ? { onStderrChunk: callbacks.onStderrChunk } : {}),
        ...(context.abortSignal !== undefined ? { signal: context.abortSignal } : {}),
      });
      this.assertExecSucceeded(result);
      // Pull the agent's commits/changes back to the host for host-side push.
      await this.deps.client.downloadFromSandbox({
        name,
        sandboxPath: repoDir,
        localDest: dir,
        ...(context.abortSignal !== undefined ? { signal: context.abortSignal } : {}),
      });
      await this.restoreTrustedRemotes(attemptKey, dir);
      return { stdout: result.stdout, stderr: result.stderr };
    } finally {
      await this.collectPolicyDenials(name, taskId, context.projectId);
    }
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
    return resolved.execute({ ...context, runtimeHandleId: _handle.containerId });
  }

  async destroyWorkspace(handle: WorkspaceHandle): Promise<void> {
    let sandboxRemoved = false;
    let providerRemoved = false;
    const sandboxName = handle.containerId.startsWith("openshell:")
      ? handle.containerId.slice("openshell:".length)
      : this.sandboxName(String(handle.taskId));
    const managedSandboxName = sandboxName.startsWith("ve-") ? sandboxName : `ve-${sandboxName}`;
    const providerName = this.providerNames.get(handle.containerId);
    try {
      if (!this.removedSandboxes.has(handle.containerId)) {
        await this.deps.client.removeSandbox(managedSandboxName);
        this.removedSandboxes.add(handle.containerId);
      }
      sandboxRemoved = true;
      if (providerName !== undefined) {
        await this.deps.client.removeProvider(providerName);
        await this.deps.managedProviderStore.deleteManagedOpenShellProvider(providerName);
      }
      providerRemoved = true;
    } finally {
      await this.deps.git.destroyWorkspace(handle.hostWorkspacePath);
      this.dirs.delete(handle.containerId);
      if (sandboxRemoved && providerRemoved) {
        this.sandboxNames.delete(handle.containerId);
        this.providerNames.delete(handle.containerId);
        this.removedSandboxes.delete(handle.containerId);
        this.trustedRemotes.delete(handle.containerId);
        this.postCloneScripts.delete(handle.containerId);
        this.denialFingerprints.delete(sandboxName);
      }
    }
  }
}
