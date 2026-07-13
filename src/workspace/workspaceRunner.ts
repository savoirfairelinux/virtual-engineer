import { spawn } from "child_process";
import { randomUUID } from "node:crypto";
import type {
  WorkspaceRunner,
  WorkspaceHandle,
  AgentResult,
  TaskContext,
  TaskId,
  CloneResult,
  PatchsetCheckoutOptions,
  ReviewWorkspaceInput,
  ProjectPushTargetRecord,
} from "../interfaces.js";
import type { AgentAdapter } from "../interfaces.js";
import { createVolume, removeVolume, execInVolume, stopContainersUsingVolume } from "./dockerVolume.js";
import { getLogger } from "../logger.js";
import { buildSkillsCliArgs, isSshSkillSource, parseRemoteSkillSources, skillsAgentId } from "./skillSources.js";
import type { AgentProvider } from "./skillSources.js";

const log = getLogger("workspace-runner");

interface SkillInstallSpec {
  homeVolumeName: string;
  image: string;
  skillSourcesJson?: string | undefined;
  provider: AgentProvider;
  networkMode?: string | undefined;
  taskId: TaskId;
  onStderrChunk?: ((chunk: string) => void) | undefined;
}

function emitSkillFetchEvent(type: string, source: string, skills: string[] | "all", provider: AgentProvider, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    __ve_event: true,
    type,
    data: { source, skills, agent: skillsAgentId(provider), ...extra },
    ts: new Date().toISOString(),
  });
}

function skillInstallError(result: { stdout: string; stderr: string; exitCode: number }): string {
  const stderr = result.stderr.trim().slice(0, 1000);
  const stdout = result.stdout.trim().slice(0, 1000);
  return [
    `exit code ${result.exitCode}`,
    ...(stderr ? [`stderr: ${stderr}`] : []),
    ...(stdout ? [`stdout: ${stdout}`] : []),
  ].join("; ");
}

type PromptAwareAgentAdapter = AgentAdapter & {
  buildContainerSpecWithPrompts(
    context: TaskContext,
    authEnv?: Record<string, string>
  ): Promise<{ env: Record<string, string>; image: string; command: string[]; networkMode?: string; additionalDockerArgs?: string[]; userPromptContent?: string }>;
};

export interface WorkspaceRunnerConfig {
  /** Docker image used for helper containers (clone, push, scripts) */
  agentContainerImage: string;
  agentTimeoutMs: number;
}

interface DockerStreamCallbacks {
  onStdoutChunk?: ((chunk: string) => void) | undefined;
  onStderrChunk?: ((chunk: string) => void) | undefined;
}

/**
 * Manages ephemeral workspaces via Docker named volumes.
 * Each cycle creates an isolated workspace+home volume pair; VCS operations run inside
 * temporary helper containers that mount the workspace volume.
 */
export class DockerWorkspaceRunner implements WorkspaceRunner {
  private agentAdapter: AgentAdapter;

  constructor(
    private readonly config: WorkspaceRunnerConfig,
    agentAdapter: AgentAdapter
  ) {
    this.agentAdapter = agentAdapter;
  }

  /** Hot-swap the agent adapter at runtime without recreating the runner. */
  updateRuntime(runtime: {
    agentAdapter?: AgentAdapter;
  }): void {
    if (runtime.agentAdapter) {
      this.agentAdapter = runtime.agentAdapter;
    }
  }

  private async installRemoteSkillsIntoHomeVolume(spec: SkillInstallSpec): Promise<void> {
    if (!spec.skillSourcesJson) return;
    const sources = parseRemoteSkillSources(spec.skillSourcesJson);
    if (sources.length === 0) return;

    for (const source of sources) {
      const skills = source.installAll === true ? "all" : source.skills;
      const needsSsh = isSshSkillSource(source);
      if (needsSsh && !source.sshKeyPath && !process.env["SSH_AUTH_SOCK"]) {
        throw new Error(`Remote SSH skill source ${source.source} requires SSH_AUTH_SOCK or sshKeyPath to be configured`);
      }
      log.info({ taskId: spec.taskId, source: source.source, skills }, "installing remote skills into agent home volume");
      spec.onStderrChunk?.(`${emitSkillFetchEvent("skills.fetch_start", source.source, skills, spec.provider)}\n`);
      const result = await execInVolume({
        volumeName: spec.homeVolumeName,
        image: spec.image,
        command: ["npx", ...buildSkillsCliArgs(source, spec.provider)],
        env: {
          HOME: "/workspace",
          NPM_CONFIG_UPDATE_NOTIFIER: "false",
        },
        ...(needsSsh ? {
          ...(source.sshKeyPath ? { sshKeyPath: source.sshKeyPath } : {}),
          ...(source.sshKnownHostsPath ? { sshKnownHostsPath: source.sshKnownHostsPath } : {}),
          ...(source.sshPort !== undefined ? { sshPort: source.sshPort } : {}),
        } : {}),
        forwardSshAgent: needsSsh && !source.sshKeyPath,
        networkMode: spec.networkMode,
        timeout: 600_000,
      });
      if (result.exitCode !== 0) {
        const detail = skillInstallError(result);
        spec.onStderrChunk?.(`${emitSkillFetchEvent("skills.fetch_failed", source.source, skills, spec.provider, { message: detail })}\n`);
        log.warn({ taskId: spec.taskId, source: source.source, err: detail.slice(0, 500) }, "remote skill installation failed");
        throw new Error(`failed to fetch skills from ${source.source}: ${detail}`);
      }
      spec.onStderrChunk?.(`${emitSkillFetchEvent("skills.fetch_complete", source.source, skills, spec.provider)}\n`);
    }
  }

  /**
   * Spawn the adapter container and return raw stdout/stderr.
   * Security: only task-specific vars reach the container; agent-worker/src/index.ts further
   * filters to a minimal allowlist to prevent leaking host secrets.
   */
  async runAgentInDocker(
    adapter: AgentAdapter,
    context: TaskContext,
    authEnv: Record<string, string> = {},
    callbacks: DockerStreamCallbacks = {}
  ): Promise<{ stdout: string; stderr: string }> {
    log.info(
      { taskId: context.taskId, adapter: adapter.name, cycle: context.cycleNumber },
      "invoking agent in docker container"
    );

    const spec = isPromptAwareAgentAdapter(adapter)
      ? await adapter.buildContainerSpecWithPrompts(context, authEnv)
      : adapter.buildContainerSpec(context, authEnv);

      // Write prompt to home volume; base64 encoding avoids shell escaping issues.
    if (spec.userPromptContent !== undefined) {
      const encoded = Buffer.from(spec.userPromptContent).toString("base64");
      await execInVolume({
        volumeName: context.homeVolumeName,
        image: this.config.agentContainerImage,
        command: ["bash", "-c", 'echo "$VE_PROMPT_B64" | base64 -d > /workspace/user-prompt.txt'],
        env: { VE_PROMPT_B64: encoded },
      });
      spec.env["USER_PROMPT_FILE"] = "/ve-home/user-prompt.txt";
    }

    await this.installRemoteSkillsIntoHomeVolume({
      homeVolumeName: context.homeVolumeName,
      image: this.config.agentContainerImage,
      skillSourcesJson: context.agentSession.skillDiscoveryEnabled ? context.agentSession.skillSourcesJson : undefined,
      provider: adapter.name === "claude" ? "claude" : "copilot",
      networkMode: spec.networkMode,
      taskId: context.taskId,
      onStderrChunk: callbacks.onStderrChunk,
    });
    delete spec.env["SKILL_SOURCES_JSON"];
    delete spec.env["SSH_AUTH_SOCK"];
    delete spec.env["GIT_SSH_COMMAND"];

    const dockerArgs = [
      "run",
      "--rm",
      "-e",
      "HOME=/ve-home",
      "-v",
      `${context.homeVolumeName}:/ve-home`,
      "-v",
      `${context.volumeName}:/workspace`,
    ];

    if (spec.additionalDockerArgs?.length) {
      dockerArgs.push(...spec.additionalDockerArgs);
    }

    for (const [key, value] of Object.entries(spec.env)) {
      dockerArgs.push("-e", `${key}=${value}`);
    }

    if (spec.networkMode) {
      dockerArgs.push("--network", spec.networkMode);
    }

    dockerArgs.push(spec.image, ...spec.command);

    log.debug({ taskId: context.taskId, dockerArgs }, "agent container command");

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    return await new Promise<{ stdout: string; stderr: string }>((resolvePromise) => {
      const child = spawn("docker", dockerArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let settled = false;
      let spawnErrorMessage = "";

      const finalize = (): void => {
        if (settled) {
          return;
        }
        settled = true;

        const stdout = stdoutChunks.join("");
        const stderr = stderrChunks.join("") || spawnErrorMessage;

        if (spawnErrorMessage && !stdout.trim()) {
          log.error(
            { taskId: context.taskId, err: stderr.slice(0, 500) },
            "agent container crashed"
          );
        }

        resolvePromise({ stdout, stderr });
      };

      child.stdout?.on("data", (chunk: Buffer | string) => {
        const text = String(chunk);
        stdoutChunks.push(text);
        callbacks.onStdoutChunk?.(text);
      });

      child.stderr?.on("data", (chunk: Buffer | string) => {
        const text = String(chunk);
        stderrChunks.push(text);
        callbacks.onStderrChunk?.(text);
      });

      child.on("error", (err) => {
        spawnErrorMessage = err.message;
        finalize();
      });

      child.on("close", () => {
        if (!spawnErrorMessage && !stdoutChunks.join("").trim() && stderrChunks.length > 0) {
          log.error(
            { taskId: context.taskId, err: stderrChunks.join("").slice(0, 500) },
            "agent container crashed"
          );
        }
        finalize();
      });
    });
  }

  /** Create a new workspace/home Docker volume pair for the given task and return its handle. */
  async createWorkspace(taskId: TaskId): Promise<WorkspaceHandle> {
    const suffix = randomUUID().slice(0, 8);
    const volumeName = `ve-ws-${taskId}-${suffix}`;
    const homeVolumeName = `ve-home-${taskId}-${suffix}`;

    await createVolume(volumeName, "workspace");
    await createVolume(homeVolumeName, "agent-home");

    log.info({ taskId, volumeName, homeVolumeName }, "workspace volumes created");

    return {
      taskId,
      containerId: "",
      volumeName,
      homeVolumeName,
      hostWorkspacePath: "/workspace",
      containerImage: this.config.agentContainerImage,
    };
  }

  /** Invoke the agent adapter's execute method against the given workspace handle. */
  async runAgent(handle: WorkspaceHandle, context: TaskContext, adapter?: AgentAdapter): Promise<AgentResult> {
    const resolvedAdapter = adapter ?? this.agentAdapter;
    log.info(
      { taskId: handle.taskId, adapter: resolvedAdapter.name, cycle: context.cycleNumber },
      "starting agent execution"
    );
    return resolvedAdapter.execute(context);
  }

  /** Clone a single repository into the workspace volume using a helper container. */
  async cloneRepo(
    handle: WorkspaceHandle,
    repoUrl: string,
    branch: string,
    sshKeyPath?: string,
    sshKnownHostsPath?: string
  ): Promise<CloneResult> {
    try {
      log.info(
        { taskId: handle.taskId, repoUrl, branch, volume: handle.volumeName },
        "cloning repository into volume"
      );
      const result = await execInVolume({
        volumeName: handle.volumeName,
        image: this.config.agentContainerImage,
        command: ["git", "clone", "--branch", branch, "--depth", "1", repoUrl, "/workspace"],
        ...(sshKeyPath ? { sshKeyPath } : {}),
        ...(sshKnownHostsPath !== undefined ? { sshKnownHostsPath } : {}),
      });
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.slice(0, 500));
      }
      return { success: true, localPath: "/workspace" };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error(
        { taskId: handle.taskId, repoUrl, branch, error: errorMsg },
        "failed to clone repository"
      );
      return { success: false, localPath: "/workspace", error: errorMsg };
    }
  }

  /**
   * Phase 4: clone all push targets of a project into the workspace volume,
   * sorted by `commitOrder`. The push target with `localPath === "."` (or the
   * lowest commitOrder when none is `"."`) is treated as the workspace root.
   *
   * Per-target clone failures are logged and recorded in the result `error`
   * field but do NOT abort the operation — only the root clone failing is a
   * hard failure.
   *
   * After all clones, runs `postCloneScript` inside a helper container
   * (cwd = /workspace) if non-empty.
   */
  async prepareProjectWorkspace(
    handle: WorkspaceHandle,
    pushTargets: ProjectPushTargetRecord[],
    postCloneScript?: string,
    sshKnownHostsPath?: string
  ): Promise<CloneResult> {
    if (pushTargets.length === 0) {
      return { success: false, localPath: "/workspace", error: "no push targets configured" };
    }

    const sorted = [...pushTargets].sort((a, b) => a.commitOrder - b.commitOrder);
    const root = sorted.find((t) => t.localPath === ".") ?? sorted[0];
    if (!root) {
      return { success: false, localPath: "/workspace", error: "no root push target" };
    }

    // Safety: ensure no two targets share the same localPath.
    const seenPaths = new Set<string>();
    for (const t of sorted) {
      if (seenPaths.has(t.localPath)) {
        return {
          success: false,
          localPath: "/workspace",
          error: `duplicate localPath "${t.localPath}" in push targets (repoKey: ${t.repoKey})`,
        };
      }
      seenPaths.add(t.localPath);
    }

    log.info(
      {
        taskId: handle.taskId,
        targetCount: sorted.length,
        rootRepoKey: root.repoKey,
        rootCloneUrl: root.cloneUrl,
      },
      "preparing project workspace (multi push target via volume)"
    );

    // Clone root repo into /workspace
    const rootResult = await execInVolume({
      volumeName: handle.volumeName,
      image: this.config.agentContainerImage,
      command: ["git", "clone", "--branch", root.targetBranch, "--depth", "1", root.cloneUrl, "/workspace"],
      sshKeyPath: root.sshKeyPath ?? undefined,
      ...(root.sshAgentPubKeyPath !== undefined && root.sshAgentPubKeyPath !== null ? { sshAgentPubKeyPath: root.sshAgentPubKeyPath } : {}),
      ...(sshKnownHostsPath !== undefined ? { sshKnownHostsPath } : {}),
    });
    if (rootResult.exitCode !== 0) {
      const errorMsg = rootResult.stderr.slice(0, 500);
      log.error(
        { taskId: handle.taskId, repoKey: root.repoKey, error: errorMsg },
        "root push target clone failed"
      );
      return { success: false, localPath: "/workspace", error: `root clone failed: ${errorMsg}` };
    }

    const errors: string[] = [];
    for (const target of sorted) {
      if (target.id === root.id) continue;

      // Create parent directory for the local path
      const parentDir = target.localPath.includes("/")
        ? target.localPath.slice(0, target.localPath.lastIndexOf("/"))
        : "";
      if (parentDir) {
        await execInVolume({
          volumeName: handle.volumeName,
          image: this.config.agentContainerImage,
          command: ["mkdir", "-p", `/workspace/${parentDir}`],
        });
      }

      // Clone into the target sub-path
      const cloneResult = await execInVolume({
        volumeName: handle.volumeName,
        image: this.config.agentContainerImage,
        command: ["git", "clone", "--branch", target.targetBranch, "--depth", "1", target.cloneUrl, `/workspace/${target.localPath}`],
        sshKeyPath: target.sshKeyPath ?? undefined,
        ...(target.sshAgentPubKeyPath !== undefined && target.sshAgentPubKeyPath !== null ? { sshAgentPubKeyPath: target.sshAgentPubKeyPath } : {}),
        ...(sshKnownHostsPath !== undefined ? { sshKnownHostsPath } : {}),
      });
      if (cloneResult.exitCode !== 0) {
        const errorMsg = cloneResult.stderr.slice(0, 300);
        log.warn(
          { taskId: handle.taskId, repoKey: target.repoKey, localPath: target.localPath, error: errorMsg },
          "push target clone failed; continuing with remaining targets"
        );
        errors.push(`${target.repoKey}: ${errorMsg}`);
      } else {
        log.info(
          { taskId: handle.taskId, repoKey: target.repoKey, localPath: target.localPath },
          "cloned push target"
        );
      }
    }

    if (postCloneScript && postCloneScript.trim().length > 0) {
      log.info({ taskId: handle.taskId }, "running postCloneScript in helper container");
      const scriptResult = await execInVolume({
        volumeName: handle.volumeName,
        image: this.config.agentContainerImage,
        command: ["bash", "-c", postCloneScript],
        sshKeyPath: root.sshKeyPath ?? undefined,
        ...(root.sshAgentPubKeyPath !== undefined && root.sshAgentPubKeyPath !== null ? { sshAgentPubKeyPath: root.sshAgentPubKeyPath } : {}),
        ...(sshKnownHostsPath !== undefined ? { sshKnownHostsPath } : {}),
      });
      if (scriptResult.exitCode !== 0) {
        const errorMsg = scriptResult.stderr.slice(0, 500);
        return { success: false, localPath: "/workspace", error: `postCloneScript failed: ${errorMsg}` };
      }
    }

    const result: CloneResult = { success: true, localPath: "/workspace" };
    if (errors.length > 0) result.error = errors.join("; ");
    return result;
  }


  /**
   * Apply a prior patchset on top of an already-cloned workspace.
   * Fetches `refs/changes/NN/CHANGE/PATCHSET` from the git remote and
   * checks it out as a detached HEAD using a helper container.
   */
  async applyPriorPatchset(
    handle: WorkspaceHandle,
    opts: PatchsetCheckoutOptions
  ): Promise<void> {
    const nn = String(opts.revisionNumber % 100).padStart(2, "0");
    const patchsetRef = `refs/changes/${nn}/${opts.revisionNumber}/${opts.patchset}`;

    log.info(
      { taskId: handle.taskId, revisionNumber: opts.revisionNumber, patchset: opts.patchset, patchsetRef },
      "applying prior patchset via helper container"
    );

    const sshKeyPath = opts.sshKeyPath;
    if (!opts.sshHost) {
      throw new Error("Patchset application requires sshHost");
    }
    // sshKeyPath may be absent when using SSH agent mode; dockerVolume.ts handles both cases.
    const sshPort = opts.sshPort ?? 29418;

    const fetchResult = await execInVolume({
      volumeName: handle.volumeName,
      image: this.config.agentContainerImage,
      command: ["git", "fetch", "origin", patchsetRef],
      ...(sshKeyPath !== undefined ? { sshKeyPath } : {}),
      ...(opts.sshAgentPubKeyPath !== undefined ? { sshAgentPubKeyPath: opts.sshAgentPubKeyPath } : {}),
      ...(opts.sshKnownHostsPath !== undefined ? { sshKnownHostsPath: opts.sshKnownHostsPath } : {}),
      sshPort,
      env: {},
    });
    if (fetchResult.exitCode !== 0) {
      const msg = fetchResult.stderr.slice(0, 500);
      log.error(
        { taskId: handle.taskId, revisionNumber: opts.revisionNumber, patchset: opts.patchset, error: msg },
        "failed to fetch prior patchset"
      );
      throw new Error(`Failed to apply patchset ${opts.revisionNumber}/${opts.patchset}: ${msg}`);
    }

    const checkoutResult = await execInVolume({
      volumeName: handle.volumeName,
      image: this.config.agentContainerImage,
      command: ["git", "checkout", "FETCH_HEAD"],
    });
    if (checkoutResult.exitCode !== 0) {
      const msg = checkoutResult.stderr.slice(0, 500);
      throw new Error(`Failed to checkout FETCH_HEAD for patchset ${opts.revisionNumber}/${opts.patchset}: ${msg}`);
    }

    log.info(
      { taskId: handle.taskId, revisionNumber: opts.revisionNumber, patchset: opts.patchset },
      "prior patchset applied successfully"
    );
  }

  /**
   * Fetch a prior patchset and cherry-pick it on top of the current HEAD.
   * Used on retry cycles to restore commits at indices 1..N after the primary
   * patchset (index 0) has been checked out via `applyPriorPatchset`.
   * Failures are non-fatal — the caller logs a warning and continues.
   */
  async cherryPickPriorPatchset(
    handle: WorkspaceHandle,
    opts: PatchsetCheckoutOptions
  ): Promise<void> {
    const nn = String(opts.revisionNumber % 100).padStart(2, "0");
    const patchsetRef = `refs/changes/${nn}/${opts.revisionNumber}/${opts.patchset}`;

    log.info(
      { taskId: handle.taskId, revisionNumber: opts.revisionNumber, patchset: opts.patchset, patchsetRef },
      "cherry-picking prior patchset on top of current HEAD"
    );

    const sshKeyPath = opts.sshKeyPath;
    if (!opts.sshHost) {
      throw new Error("Patchset cherry-pick requires sshHost");
    }
    // sshKeyPath may be absent when using SSH agent mode; dockerVolume.ts handles both cases.
    const sshPort = opts.sshPort ?? 29418;

    const fetchResult = await execInVolume({
      volumeName: handle.volumeName,
      image: this.config.agentContainerImage,
      command: ["git", "fetch", "origin", patchsetRef],
      ...(sshKeyPath !== undefined ? { sshKeyPath } : {}),
      ...(opts.sshAgentPubKeyPath !== undefined ? { sshAgentPubKeyPath: opts.sshAgentPubKeyPath } : {}),
      ...(opts.sshKnownHostsPath !== undefined ? { sshKnownHostsPath: opts.sshKnownHostsPath } : {}),
      sshPort,
      env: {},
    });
    if (fetchResult.exitCode !== 0) {
      const msg = fetchResult.stderr.slice(0, 500);
      throw new Error(`Failed to fetch patchset ${opts.revisionNumber}/${opts.patchset}: ${msg}`);
    }

    const cherryPickResult = await execInVolume({
      volumeName: handle.volumeName,
      image: this.config.agentContainerImage,
      command: ["git", "cherry-pick", "FETCH_HEAD"],
    });
    if (cherryPickResult.exitCode !== 0) {
      // Abort cherry-pick if in progress to leave workspace clean
      await execInVolume({
        volumeName: handle.volumeName,
        image: this.config.agentContainerImage,
        command: ["git", "cherry-pick", "--abort"],
      }).catch(() => { /* ignore */ });
      const msg = cherryPickResult.stderr.slice(0, 500);
      throw new Error(`Cherry-pick failed for patchset ${opts.revisionNumber}/${opts.patchset}: ${msg}`);
    }

    log.info(
      { taskId: handle.taskId, revisionNumber: opts.revisionNumber, patchset: opts.patchset },
      "prior patchset cherry-picked successfully"
    );
  }

  /**
   * Run the code-review agent inside a Docker container against the workspace volume.
   * Writes the review prompt into the home volume via a helper container, then runs
   * agent-worker with REVIEW_MODE=1. Returns the raw LLM output for the host to
   * parse with parseReviewResult().
   */
  async runReviewInDocker(
    handle: WorkspaceHandle,
    input: ReviewWorkspaceInput,
    callbacks: DockerStreamCallbacks = {}
  ): Promise<{ rawOutput: string }> {
    // Write prompt into the home volume (mounted at /workspace in this helper container).
    // The review container later mounts the home volume at /ve-home, so the file
    // will be available at /ve-home/user-prompt.txt.
    // Base64 encoding avoids shell escaping issues with arbitrary prompt content.
    const encodedPrompt = Buffer.from(input.prompt).toString("base64");
    await execInVolume({
      volumeName: handle.homeVolumeName,
      image: this.config.agentContainerImage,
      command: ["bash", "-c", 'echo "$VE_PROMPT_B64" | base64 -d > /workspace/user-prompt.txt'],
      env: { VE_PROMPT_B64: encodedPrompt },
    });

    log.info(
      { taskId: handle.taskId, changeId: input.changeId, patchset: input.patchset, repositoryName: input.repositoryName },
      "running review agent in Docker container"
    );

    const adapter = this.agentAdapter;
    let spec: { env: Record<string, string>; image: string; command: string[]; networkMode?: string; additionalDockerArgs?: string[] };

    if ("buildReviewContainerSpec" in adapter && typeof (adapter as Record<string, unknown>)["buildReviewContainerSpec"] === "function") {
      spec = (adapter as { buildReviewContainerSpec: (input: ReviewWorkspaceInput) => typeof spec })
        .buildReviewContainerSpec(input);
    } else {
      throw new Error("Agent adapter does not support buildReviewContainerSpec; cannot run review in Docker");
    }

    await this.installRemoteSkillsIntoHomeVolume({
      homeVolumeName: handle.homeVolumeName,
      image: this.config.agentContainerImage,
      skillSourcesJson: input.skillDiscoveryEnabled ? input.skillSourcesJson : undefined,
      provider: adapter.name === "claude" ? "claude" : "copilot",
      networkMode: spec.networkMode,
      taskId: handle.taskId,
      onStderrChunk: callbacks.onStderrChunk,
    });
    delete spec.env["SKILL_SOURCES_JSON"];
    delete spec.env["SSH_AUTH_SOCK"];
    delete spec.env["GIT_SSH_COMMAND"];

    const dockerArgs = [
      "run",
      "--rm",
      "-e",
      "HOME=/ve-home",
      "-v",
      `${handle.homeVolumeName}:/ve-home`,
      // Mount workspace read-only — review agent must not modify files.
      "-v",
      `${handle.volumeName}:/workspace:ro`,
    ];

    if (spec.additionalDockerArgs?.length) {
      dockerArgs.push(...spec.additionalDockerArgs);
    }

    for (const [key, value] of Object.entries(spec.env)) {
      dockerArgs.push("-e", `${key}=${value}`);
    }

    if (spec.networkMode) {
      dockerArgs.push("--network", spec.networkMode);
    }

    dockerArgs.push(spec.image, ...spec.command);

    log.debug({ taskId: handle.taskId, dockerArgs }, "review container command");

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn("docker", dockerArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdoutChunks.push(String(chunk));
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        const line = String(chunk);
        stderrChunks.push(line);
        callbacks.onStderrChunk?.(line);
        log.debug({ taskId: handle.taskId }, `[review-agent] ${line.trim()}`);
      });
      child.on("error", (err) => rejectPromise(err));
      child.on("close", () => resolvePromise());
    });

    const stdout = stdoutChunks.join("").trim();
    if (!stdout) {
      throw new Error(`Review container produced no output. stderr: ${stderrChunks.join("").slice(0, 500)}`);
    }

    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      return { rawOutput: stdout };
    }
    if (parsed["status"] === "failed") {
      const msg = typeof parsed["summary"] === "string" ? parsed["summary"] : "Review agent reported a failure";
      throw new Error(msg);
    }
    const rawOutput = typeof parsed["rawOutput"] === "string" ? parsed["rawOutput"] : stdout;
    return { rawOutput };
  }

  /**
   * Run a git command inside the workspace volume via a helper container.
   * Returns stdout on success, throws on non-zero exit.
   */
  async execGitInVolume(
    handle: WorkspaceHandle,
    args: string[],
    subPath?: string
  ): Promise<string> {
    const cwd = subPath && subPath !== "."
      ? `/workspace/${subPath}`
      : "/workspace";
    const result = await execInVolume({
      volumeName: handle.volumeName,
      image: this.config.agentContainerImage,
      command: ["git", "-C", cwd, ...args],
    });
    if (result.exitCode !== 0) {
      throw new Error(`git ${args[0]}: ${result.stderr.slice(0, 500)}`);
    }
    return result.stdout;
  }

  /** Remove the workspace and home Docker volumes associated with a handle. */
  async destroyWorkspace(handle: WorkspaceHandle): Promise<void> {
    log.info({ taskId: handle.taskId, volumeName: handle.volumeName, homeVolumeName: handle.homeVolumeName }, "destroying workspace volumes");
    // Stop any containers still using the workspace volume (e.g. after an agent timeout)
    await stopContainersUsingVolume(handle.volumeName);
    try {
      await removeVolume(handle.volumeName);
    } catch (err) {
      log.warn({ taskId: handle.taskId, err }, "failed to remove workspace volume");
    }
    try {
      await removeVolume(handle.homeVolumeName);
    } catch {
      // ignore — home volume may not exist if agent never ran
    }
  }

}

/** Return true when the adapter exposes the prompt-aware container spec builder. */
function isPromptAwareAgentAdapter(adapter: AgentAdapter): adapter is PromptAwareAgentAdapter {
  return "buildContainerSpecWithPrompts" in adapter
    && typeof adapter.buildContainerSpecWithPrompts === "function";
}
