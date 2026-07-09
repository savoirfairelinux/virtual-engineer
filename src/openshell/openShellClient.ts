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

import { execFile } from "child_process";
import { getLogger } from "../logger.js";

const log = getLogger("openshell-client");

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs an argv against a binary and resolves the captured result (never rejects on non-zero). */
export type CommandRunner = (bin: string, args: string[], input?: string) => Promise<CommandResult>;

const defaultRunner: CommandRunner = (bin, args, input) =>
  new Promise<CommandResult>((resolve) => {
    const child = execFile(bin, args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, stdout: stdout.toString(), stderr: stderr.toString() });
    });
    if (input !== undefined && child.stdin) {
      child.stdin.end(input);
    }
  });

export interface OpenShellClientOptions {
  /** Path to the `openshell` binary. */
  bin?: string;
  /** Gateway address (`--gateway`), when not using the ambient default. */
  gateway?: string | undefined;
  runner?: CommandRunner;
}

export interface CreateSandboxInput {
  /** Sandbox name (VE uses the task id). */
  name: string;
  /** Agent to launch (`claude` | `codex` | `opencode` | `copilot`). */
  agent?: string | undefined;
  /** Base image or community/BYOC reference (`--from`). */
  from?: string | undefined;
  /** Provider credential bundles to inject (names, not secret values). */
  providers?: string[];
}

export interface ExecSandboxInput {
  name: string;
  /** Command argv to run inside the sandbox. */
  command: string[];
}

export class OpenShellClient {
  private readonly bin: string;
  private readonly gateway: string | undefined;
  private readonly run: CommandRunner;

  constructor(options: OpenShellClientOptions = {}) {
    this.bin = options.bin ?? "openshell";
    this.gateway = options.gateway;
    this.run = options.runner ?? defaultRunner;
  }

  private baseArgs(): string[] {
    return this.gateway ? ["--gateway", this.gateway] : [];
  }

  private async exec(args: string[], input?: string): Promise<CommandResult> {
    const result = await this.run(this.bin, [...this.baseArgs(), ...args], input);
    if (result.code !== 0) {
      log.warn({ args, code: result.code, stderr: result.stderr.slice(0, 500) }, "openshell command failed");
    }
    return result;
  }

  /** Create (and optionally launch an agent in) a sandbox. Throws on failure. */
  async createSandbox(input: CreateSandboxInput): Promise<void> {
    const args = ["sandbox", "create", "--name", input.name];
    if (input.from) args.push("--from", input.from);
    for (const provider of input.providers ?? []) args.push("--provider", provider);
    if (input.agent) args.push("--", input.agent);
    const result = await this.exec(args);
    if (result.code !== 0) {
      throw new Error(`openshell sandbox create failed (${result.code}): ${result.stderr.slice(0, 500)}`);
    }
  }

  /** Run a command inside a sandbox and return its captured output. */
  async execInSandbox(input: ExecSandboxInput): Promise<CommandResult> {
    return this.exec(["sandbox", "exec", input.name, "--", ...input.command]);
  }

  /** Apply (hot-reload) a policy YAML on a running sandbox. Throws on failure. */
  async setPolicy(name: string, policyYaml: string): Promise<void> {
    const result = await this.exec(["policy", "set", name, "--policy", "-"], policyYaml);
    if (result.code !== 0) {
      throw new Error(`openshell policy set failed (${result.code}): ${result.stderr.slice(0, 500)}`);
    }
  }

  /** Destroy a sandbox. Never throws — cleanup is best-effort. */
  async removeSandbox(name: string): Promise<void> {
    await this.exec(["sandbox", "rm", "--force", name]);
  }

  /** Return true when the gateway responds healthy. */
  async gatewayHealthy(): Promise<boolean> {
    // Prefer an HTTP health probe (dedicated health port at /healthz) over a
    // CLI subcommand — the `gateway status` subcommand does not exist in current
    // OpenShell releases. The health port is separate from the gRPC/API port.
    const base = this.gateway ? `http://${this.gateway.replace(/^https?:\/\//, "").replace(/:\d+$/, "")}` : "http://127.0.0.1";
    // Try the dedicated health port (8081 by default), then fall back to the main port.
    for (const url of [`${base}:8081/healthz`, `${base}:8080/healthz`, `${base}:8081/health`, `${base}:8080/health`]) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (res.ok || res.status < 500) return true;
      } catch {
        // try next
      }
    }
    return false;
  }
}
