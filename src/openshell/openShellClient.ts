/**
 * OpenShell client — the single point of contact with the `openshell` CLI /
 * gateway. Every OpenShell interaction goes through here so an upstream
 * breaking change touches exactly one file. The command runner is injectable so
 * the client is fully unit-testable without a real gateway.
 *
 * Security notes:
 * - The client never receives push/review-system credentials; only agent-facing
 *   provider credentials (inference keys, scoped read tokens) are passed as
 *   provider env at sandbox creation.
 * - Policies are applied via `policySet` before the agent runs.
 */

import { spawn } from "child_process";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "node:crypto";
import { getLogger } from "../logger.js";

const log = getLogger("openshell-client");

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandCallbacks {
  onStdoutChunk?: ((chunk: string) => void) | undefined;
  onStderrChunk?: ((chunk: string) => void) | undefined;
}

/** Runs an argv against a binary and resolves the captured result (never rejects on non-zero). */
export type CommandRunner = (
  bin: string,
  args: string[],
  input?: string,
  callbacks?: CommandCallbacks
) => Promise<CommandResult>;

const MAX_COMMAND_OUTPUT_BYTES = 32 * 1024 * 1024;

const defaultRunner: CommandRunner = (bin, args, input, callbacks) =>
  new Promise<CommandResult>((resolve) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let outputBytes = 0;
    let outputLimitExceeded = false;
    let settled = false;

    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const collect = (target: string[], chunk: Buffer, callback?: (value: string) => void): void => {
      const value = chunk.toString();
      target.push(value);
      outputBytes += chunk.byteLength;
      callback?.(value);
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES && !outputLimitExceeded) {
        outputLimitExceeded = true;
        child.kill("SIGTERM");
      }
    };

    child.stdout.on("data", (chunk: Buffer) => collect(stdoutChunks, chunk, callbacks?.onStdoutChunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderrChunks, chunk, callbacks?.onStderrChunk));
    child.once("error", (err) => {
      finish({ code: 1, stdout: stdoutChunks.join(""), stderr: `${stderrChunks.join("")}${err.message}` });
    });
    child.once("close", (code) => {
      const stderr = stderrChunks.join("");
      finish({
        code: outputLimitExceeded ? 1 : code ?? 1,
        stdout: stdoutChunks.join(""),
        stderr: outputLimitExceeded ? `${stderr}\nopenshell command output exceeded 32 MiB` : stderr,
      });
    });
    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });

export interface OpenShellClientOptions {
  /** Path to the `openshell` binary. */
  bin?: string;
  /** Gateway address (`--gateway`), when not using the ambient default. */
  gateway?: string | undefined;
  runner?: CommandRunner;
  /** Base backoff (ms) between transient sandbox-create retries. Default 3000. */
  retryBaseDelayMs?: number | undefined;
}

export interface CreateSandboxInput {
  /** Sandbox name (VE uses the task id). */
  name: string;
  /** Base image or community/BYOC reference (`--from`). */
  from?: string | undefined;
  /** Environment variables to inject (`--env KEY=VALUE`, repeatable). */
  env?: Record<string, string> | undefined;
  /** Provider credential bundles to inject (names, not secret values). */
  providers?: string[] | undefined;
  /** CPU limit (e.g. `500m`, `1`, `2.5`) mapped to the driver (k8s pod request/limit). */
  cpu?: string | undefined;
  /** Memory limit (e.g. `512Mi`, `4Gi`) mapped to the driver. */
  memory?: string | undefined;
}

export interface UploadInput {
  name: string;
  /** Local path (file or directory) to upload. */
  localPath: string;
  /** Destination path inside the sandbox. */
  dest: string;
  /** Upload everything, including files matched by `.gitignore` (needed for `.git`). */
  noGitIgnore?: boolean | undefined;
}

export interface DownloadInput {
  name: string;
  /** Path inside the sandbox to download. */
  sandboxPath: string;
  /** Local destination directory. */
  localDest: string;
}

export interface ExecSandboxInput {
  name: string;
  /** Command argv to run inside the sandbox. */
  command: string[];
  /** Environment variables to set for the command (`--env KEY=VALUE`, repeatable). */
  env?: Record<string, string> | undefined;
  /** Working directory inside the sandbox. */
  workdir?: string | undefined;
  /** Timeout in seconds (0 = no timeout). */
  timeout?: number | undefined;
  /** Incremental command output callbacks. The final result remains fully buffered. */
  onStdoutChunk?: ((chunk: string) => void) | undefined;
  onStderrChunk?: ((chunk: string) => void) | undefined;
}

/** Access level for an egress endpoint. Copilot needs `full` (POST completions). */
export type EgressAccess = "read-only" | "read-write" | "full";

export interface AllowEgressInput {
  name: string;
  /** Hostnames to allow on port 443. */
  hosts: string[];
  /** Absolute paths of the executables permitted to use the egress. */
  binaries?: string[] | undefined;
  /** Access level (default `full`). */
  access?: EgressAccess | undefined;
}

export class OpenShellClient {
  private readonly bin: string;
  private readonly gateway: string | undefined;
  private readonly run: CommandRunner;
  private readonly retryBaseDelayMs: number;

  /**
   * Gateway/SSH errors that are transient on a cold start: the sandbox Pod is
   * still provisioning, or its supervisor has not yet brought up (or briefly
   * dropped) the SSH relay the CLI uses to attach. A short retry (after cleaning
   * up the half-created sandbox) lets the sandbox settle. All of these are the
   * relay/supervisor warming up — a genuinely bad request (invalid image,
   * permission denied) does not surface as an SSH-transport error.
   */
  private static readonly TRANSIENT_CREATE_PATTERNS = [
    "service is currently unavailable",
    "supervisor session not connected",
    "supervisor relay",
    "sandbox is not ready",
    "sandbox not ready",
    "connection closed by remote host",
    "kex_exchange_identification",
    "broken pipe",
    "ssh exited with status",
  ];

  constructor(options: OpenShellClientOptions = {}) {
    this.bin = options.bin ?? "openshell";
    this.gateway = options.gateway;
    this.run = options.runner ?? defaultRunner;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 4000;
  }

  private async exec(args: string[], input?: string, callbacks?: CommandCallbacks): Promise<CommandResult> {
    // OPENSHELL_GATEWAY_ENDPOINT is injected by start.sh (e.g.
    // "http://127.0.0.1:8080"). The CLI reads it directly and connects without
    // any local gateway-registry lookup, so no 'gateway add' is required.
    const result = await this.run(this.bin, args, input, callbacks);
    if (result.code !== 0) {
      log.warn({ args, code: result.code, stderr: result.stderr.slice(0, 500) }, "openshell command failed");
    }
    return result;
  }

  /**
   * Create a persistent sandbox (no `--no-keep`) from a base image with env vars
   * and optional resource limits. The workspace is uploaded separately; the agent
   * is launched later via {@link execInSandbox}. Throws on failure.
   */
  async createSandbox(input: CreateSandboxInput): Promise<void> {
    const args = ["sandbox", "create", "--name", input.name];
    if (input.from) args.push("--from", input.from);
    if (input.cpu) args.push("--cpu", input.cpu);
    if (input.memory) args.push("--memory", input.memory);
    for (const provider of input.providers ?? []) args.push("--provider", provider);
    for (const [key, value] of Object.entries(input.env ?? {})) args.push("--env", `${key}=${value}`);
    // Without a trailing command, `sandbox create` defaults to attaching an
    // interactive shell and blocks forever (there is no TTY to drive it), which
    // wedges the orchestrator since the command never exits. Run a no-op instead
    // and disable PTY allocation: the sandbox is created and, because `--no-keep`
    // is omitted, kept alive for the subsequent upload/exec calls.
    args.push("--no-tty", "--", "true");

    const maxAttempts = 6;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await this.exec(args);
      if (result.code === 0) return;

      const transient =
        attempt < maxAttempts &&
        OpenShellClient.TRANSIENT_CREATE_PATTERNS.some((p) => result.stderr.toLowerCase().includes(p));
      if (!transient) {
        throw new Error(`openshell sandbox create failed (${result.code}): ${result.stderr.slice(0, 500)}`);
      }

      log.warn({ name: input.name, attempt }, "sandbox create hit a transient error — cleaning up and retrying");
      // A half-created sandbox keeps the name reserved; remove it before retrying.
      await this.exec(["sandbox", "delete", input.name]);
      await new Promise((resolve) => setTimeout(resolve, this.retryBaseDelayMs * attempt));
    }
  }

  /** Upload a local file/directory into a running sandbox. Throws on failure. */
  async uploadToSandbox(input: UploadInput): Promise<void> {
    const args = ["sandbox", "upload"];
    if (input.noGitIgnore) args.push("--no-git-ignore");
    args.push(input.name, input.localPath, input.dest);
    const result = await this.exec(args);
    if (result.code !== 0) {
      throw new Error(`openshell sandbox upload failed (${result.code}): ${result.stderr.slice(0, 500)}`);
    }
  }

  /** Download a path from a sandbox to a local destination. Throws on failure. */
  async downloadFromSandbox(input: DownloadInput): Promise<void> {
    const result = await this.exec(["sandbox", "download", input.name, input.sandboxPath, input.localDest]);
    if (result.code !== 0) {
      throw new Error(`openshell sandbox download failed (${result.code}): ${result.stderr.slice(0, 500)}`);
    }
  }

  /** Run a command inside a sandbox and return its captured output. */
  async execInSandbox(input: ExecSandboxInput): Promise<CommandResult> {
    const args = ["sandbox", "exec", "--no-tty", "--name", input.name];
    if (input.workdir) args.push("--workdir", input.workdir);
    if (input.timeout !== undefined) args.push("--timeout", String(input.timeout));
    for (const [key, value] of Object.entries(input.env ?? {})) args.push("--env", `${key}=${value}`);
    args.push("--", ...input.command);
    return this.exec(args, undefined, {
      ...(input.onStdoutChunk !== undefined ? { onStdoutChunk: input.onStdoutChunk } : {}),
      ...(input.onStderrChunk !== undefined ? { onStderrChunk: input.onStderrChunk } : {}),
    });
  }

  /** Apply (hot-reload) a policy YAML on a running sandbox. Throws on failure. */
  async setPolicy(name: string, policyYaml: string): Promise<void> {
    // `policy set` requires a file path (no stdin support). Write to a temp file,
    // apply, then clean up. Sandbox name is a positional arg after --policy.
    const tmpPath = join(tmpdir(), `ve-policy-${randomUUID()}.yaml`);
    try {
      await writeFile(tmpPath, policyYaml, "utf8");
      const result = await this.exec(["policy", "set", "--policy", tmpPath, name]);
      if (result.code !== 0) {
        throw new Error(`openshell policy set failed (${result.code}): ${result.stderr.slice(0, 500)}`);
      }
    } finally {
      await unlink(tmpPath).catch(() => undefined);
    }
  }

  /**
   * Incrementally open egress to `hosts` (port 443) on a running sandbox, scoped
   * to `binaries`. OpenShell is deny-by-default: without an allow rule the egress
   * proxy rejects the CONNECT (403), and without `binaries` scoping the CONNECT is
   * denied even for allowed hosts. Uses `policy update` (incremental) so the static
   * filesystem/landlock sections — locked at sandbox creation — are left untouched.
   * Throws on failure. No-op when `hosts` is empty.
   */
  async allowEgress(input: AllowEgressInput): Promise<void> {
    if (input.hosts.length === 0) return;
    const access = input.access ?? "full";
    const args = ["policy", "update"];
    // `host:port:access:protocol` — REST over TLS is the shape the proxy enforces.
    for (const host of input.hosts) args.push("--add-endpoint", `${host}:443:${access}:rest`);
    // `--binary` applies to every `--add-endpoint` rule in the same invocation.
    for (const bin of input.binaries ?? []) args.push("--binary", bin);
    args.push("--wait", input.name);
    const result = await this.exec(args);
    if (result.code !== 0) {
      throw new Error(`openshell policy update (egress) failed (${result.code}): ${result.stderr.slice(0, 500)}`);
    }
  }

  /** Destroy a sandbox. Never throws — cleanup is best-effort. */
  async removeSandbox(name: string): Promise<void> {
    // `sandbox delete` takes sandbox name(s) as positional arguments.
    await this.exec(["sandbox", "delete", name]);
  }

  /** Return true when the gateway responds healthy. */
  async gatewayHealthy(): Promise<boolean> {
    // Probe the gateway URL directly — supports both a dedicated health port
    // (e.g. http://127.0.0.1:8081) and a NodePort URL (http://127.0.0.1:30808).
    // When gateway is unset fall back to localhost defaults.
    const base = this.gateway
      ? this.gateway.replace(/\/$/, "")
      : "http://127.0.0.1:8081";
    for (const path of ["/healthz", "/health"]) {
      try {
        const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(3000) });
        if (res.ok || res.status < 500) return true;
      } catch {
        // try next
      }
    }
    return false;
  }
}
