/** Docker named volume helpers for creating, removing, and running commands inside ephemeral workspaces. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getLogger } from "../logger.js";
import { redactUrls } from "../utils/redactUrl.js";
import { readSshFileSecure } from "../utils/sshFilePath.js";

const execFileAsync = promisify(execFile);
const log = getLogger("docker-volume");

const DOCKER_TIMEOUT_MS = 30_000;

/** Create a named Docker volume. */
export async function createVolume(name: string, purpose?: string): Promise<void> {
  await execFileAsync("docker", ["volume", "create", name], { timeout: DOCKER_TIMEOUT_MS });
  log.debug({ volume: name, ...(purpose !== undefined ? { purpose } : {}) }, "created docker volume");
}

/**
 * Stop all containers currently using the given named volume.
 * Called before volume removal so that a timed-out agent container does not
 * leave the volume locked.
 */
export async function stopContainersUsingVolume(name: string): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "docker",
      ["ps", "-q", "--filter", `volume=${name}`],
      { timeout: DOCKER_TIMEOUT_MS }
    ));
  } catch {
    return; // docker not available or command failed — skip
  }
  const containerIds = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  if (containerIds.length === 0) return;
  try {
    await execFileAsync("docker", ["stop", "--time", "5", ...containerIds], { timeout: 30_000 });
    log.debug({ volume: name, containerIds }, "stopped containers using volume before removal");
  } catch {
    // ignore — container may have already exited by the time we stop it
  }
}

/** Remove a named Docker volume (force — ignores "not found"). */
export async function removeVolume(name: string): Promise<void> {
  try {
    await execFileAsync("docker", ["volume", "rm", "-f", name], { timeout: DOCKER_TIMEOUT_MS });
    log.debug({ volume: name }, "removed docker volume");
  } catch (err) {
    // Swallow "no such volume" — it may have been removed already.
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("no such volume") && !msg.includes("No such volume")) {
      throw err;
    }
    log.debug({ volume: name }, "volume already removed (no-op)");
  }
}

export interface ExecInVolumeOptions {
  /** Named volume to mount at /workspace */
  volumeName: string;
  /** Docker image to use for the helper container */
  image: string;
  /** Command + args to run inside the container */
  command: string[];
  /** Environment variables */
  env?: Record<string, string> | undefined;
  /**
   * SSH private-key path on the orchestrator filesystem.
   * The key is base64-encoded and injected as VE_SSH_KEY_B64 rather than
   * bind-mounted, because the host Docker daemon resolves bind paths against
   * the HOST filesystem and orchestrator-internal paths would fail.
   * Omit to use SSH agent mode (requires SSH_AUTH_SOCK to be available).
   */
  sshKeyPath?: string | undefined;
  /**
   * SSH agent public-key path for identity pinning (`.pub` file).
   * Only used when `sshKeyPath` is absent (agent mode).
   * Injected as VE_SSH_AGENT_PUB_B64; the container decodes it to a temp
   * file and uses `-o IdentitiesOnly=yes` to pin the correct agent key.
   */
  sshAgentPubKeyPath?: string | undefined;
  /** SSH port to include in GIT_SSH_COMMAND (e.g. 29418 for Gerrit) */
  sshPort?: number | undefined;
  /** Path to a known_hosts file on the orchestrator filesystem. When set alongside sshKeyPath, SSH uses strict host key verification. */
  sshKnownHostsPath?: string | undefined;
  /** Docker network to attach the container to */
  networkMode?: string | undefined;
  /** Additional bind mounts (source:target:options) */
  additionalMounts?: string[] | undefined;
  /** Forward host SSH_AUTH_SOCK for helper commands that need SSH agent auth. Defaults to true. */
  forwardSshAgent?: boolean | undefined;
  /** Timeout in milliseconds (default 10 minutes) */
  timeout?: number | undefined;
  /** Mount the workspace as read-only */
  readOnly?: boolean | undefined;
  /** Run as specific uid:gid */
  user?: string | undefined;
}

export interface ExecInVolumeResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run a command inside a temporary container that mounts the given named volume
 * at `/workspace`. Used for clone, push, and script operations.
 */
export async function execInVolume(opts: ExecInVolumeOptions): Promise<ExecInVolumeResult> {
  const timeout = opts.timeout ?? 600_000;
  const volumeMount = opts.readOnly
    ? `${opts.volumeName}:/workspace:ro`
    : `${opts.volumeName}:/workspace`;

  const dockerArgs = [
    "run",
    "--rm",
    "-v",
    volumeMount,
  ];

  if (opts.user) {
    dockerArgs.push("--user", opts.user);
  }

  const agentSock = opts.sshKeyPath || opts.forwardSshAgent === false ? undefined : process.env["SSH_AUTH_SOCK"];

  if (opts.sshKeyPath) {
    // ── Private-key mode ────────────────────────────────────────────────────
    // SSH key is injected via base64 env var rather than bind-mount: when the
    // orchestrator runs inside Docker, the daemon resolves bind paths against
    // the HOST filesystem, so container-internal paths would fail.
    const keyContent = readSshFileSecure(opts.sshKeyPath, "SSH key");
    const keyB64 = keyContent.toString("base64");
    dockerArgs.push("-e", `VE_SSH_KEY_B64=${keyB64}`);
    const portFlag = opts.sshPort ? ` -p ${opts.sshPort}` : "";

    if (opts.sshKnownHostsPath) {
      const khContent = readSshFileSecure(opts.sshKnownHostsPath, "SSH known_hosts");
      dockerArgs.push("-e", `VE_SSH_KNOWN_HOSTS_B64=${khContent.toString("base64")}`);
      dockerArgs.push("-e", `GIT_SSH_COMMAND=ssh -i /tmp/ssh-key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/tmp/ssh-known-hosts${portFlag}`);
    } else {
      dockerArgs.push("-e", `GIT_SSH_COMMAND=ssh -i /tmp/ssh-key -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null${portFlag}`);
    }
  } else {
    // ── SSH agent mode ───────────────────────────────────────────────────────
    // Forward the host SSH agent socket using the same-path trick: the
    // orchestrator mounts $SSH_AUTH_SOCK with its original host path, so when
    // it passes that path to the Docker daemon, the daemon resolves it on the
    // host and finds the socket.
    if (opts.sshAgentPubKeyPath && !agentSock) {
      throw new Error(
        "SSH agent identity pinning is configured (sshAgentPubKeyPath) but " +
        "SSH_AUTH_SOCK is not set. Ensure the SSH agent socket is available " +
        "and forwarded to this process."
      );
    }
    if (agentSock) {
      // Same-path bind-mount so child containers launched from this container
      // can forward the socket using the same path.
      dockerArgs.push("-v", `${agentSock}:${agentSock}`);
      dockerArgs.push("-e", `SSH_AUTH_SOCK=${agentSock}`);
    }
    const portFlag = opts.sshPort ? ` -p ${opts.sshPort}` : "";
    const hostKeyOpts = opts.sshKnownHostsPath
      ? `-o StrictHostKeyChecking=yes -o UserKnownHostsFile=/tmp/ssh-known-hosts`
      : `-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;

    if (opts.sshAgentPubKeyPath && agentSock) {
      // Agent identity pinning: inject the public key so the container can
      // instruct the agent to offer only the matching private key.
      const pubContent = readSshFileSecure(opts.sshAgentPubKeyPath, "SSH agent public key");
      dockerArgs.push("-e", `VE_SSH_AGENT_PUB_B64=${pubContent.toString("base64")}`);
      dockerArgs.push("-e", `GIT_SSH_COMMAND=ssh -o IdentitiesOnly=yes -i /tmp/agent-pub.pub${portFlag} ${hostKeyOpts}`);
    } else if (agentSock) {
      dockerArgs.push("-e", `GIT_SSH_COMMAND=ssh${portFlag} ${hostKeyOpts}`);
    }

    if (opts.sshKnownHostsPath && agentSock) {
      const khContent = readSshFileSecure(opts.sshKnownHostsPath, "SSH known_hosts");
      dockerArgs.push("-e", `VE_SSH_KNOWN_HOSTS_B64=${khContent.toString("base64")}`);
    }
  }

  if (opts.env) {
    for (const [key, value] of Object.entries(opts.env)) {
      dockerArgs.push("-e", `${key}=${value}`);
    }
  }

  if (opts.networkMode) {
    dockerArgs.push("--network", opts.networkMode);
  }

  if (opts.additionalMounts) {
    for (const mount of opts.additionalMounts) {
      dockerArgs.push("-v", mount);
    }
  }

  // Wrap the command in a shell preamble that decodes any injected key
  // material. Built as a list of independent parts so every combination of
  // (private key file) x (known_hosts file) x (agent identity pinning) is
  // handled correctly — e.g. plain agent mode (no pinning) with a known_hosts
  // file still needs its own decode step, which previous exclusive-branch
  // logic missed.
  const preambleParts: string[] = [];
  if (opts.sshKeyPath) {
    preambleParts.push(`echo "$VE_SSH_KEY_B64" | base64 -d > /tmp/ssh-key && chmod 600 /tmp/ssh-key && unset VE_SSH_KEY_B64`);
  }
  if (opts.sshAgentPubKeyPath && agentSock) {
    preambleParts.push(`echo "$VE_SSH_AGENT_PUB_B64" | base64 -d > /tmp/agent-pub.pub && chmod 644 /tmp/agent-pub.pub && unset VE_SSH_AGENT_PUB_B64`);
  }
  if (opts.sshKnownHostsPath && (opts.sshKeyPath || agentSock)) {
    preambleParts.push(`echo "$VE_SSH_KNOWN_HOSTS_B64" | base64 -d > /tmp/ssh-known-hosts && chmod 644 /tmp/ssh-known-hosts && unset VE_SSH_KNOWN_HOSTS_B64`);
  }

  if (preambleParts.length > 0) {
    const escaped = opts.command.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
    const preamble = `${preambleParts.join(" && ")} && exec ${escaped}`;
    dockerArgs.push(opts.image, "sh", "-c", preamble);
  } else {
    dockerArgs.push(opts.image, ...opts.command);
  }

  log.debug({ volumeName: opts.volumeName, command: opts.command.map(redactUrls) }, "execInVolume");

  try {
    const { stdout, stderr } = await execFileAsync("docker", dockerArgs, { timeout });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    if (err && typeof err === "object" && "stdout" in err) {
      const execErr = err as { stdout: string; stderr: string; code?: number };
      return {
        stdout: execErr.stdout ?? "",
        stderr: execErr.stderr ?? "",
        exitCode: execErr.code ?? 1,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { stdout: "", stderr: msg, exitCode: 1 };
  }
}
