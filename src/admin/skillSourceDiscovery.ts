import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { promisify } from "node:util";
import { resolveSshSkillSourceUrl } from "../workspace/skillSources.js";

const execFileAsync = promisify(execFile);

const DEFAULT_SKILLS_CLI_PACKAGE = "skills@1.5.16";
const OUTPUT_LIMIT = 4000;
export const SKILL_LIST_TIMEOUT_MS = 30_000;

export interface SkillSourceDiscoveryInput {
  source: string;
  sshUser?: string;
  sshPort?: number;
  sshKeyPath?: string;
  sshKnownHostsPath?: string;
}

function skillsCliPackage(): string {
  return process.env["SKILLS_CLI_PACKAGE"]?.trim() || DEFAULT_SKILLS_CLI_PACKAGE;
}

function quoteSshArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function copyEnv(env: NodeJS.ProcessEnv, key: string, target: NodeJS.ProcessEnv): void {
  const value = env[key];
  if (value !== undefined) target[key] = value;
}

function skillListSubprocessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NPM_CONFIG_UPDATE_NOTIFIER: "false" };
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "TMPDIR",
    "XDG_RUNTIME_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
  ]) {
    copyEnv(process.env, key, env);
  }
  return env;
}

function isSshSkillSource(source: SkillSourceDiscoveryInput): boolean {
  return source.source.startsWith("ssh://") || source.source.startsWith("git@");
}

export function resolveSkillSourceUrl(source: SkillSourceDiscoveryInput): string {
  return resolveSshSkillSourceUrl(source);
}

export function buildSkillListArgs(source: SkillSourceDiscoveryInput): string[] {
  return ["--yes", skillsCliPackage(), "add", "-l", resolveSkillSourceUrl(source)];
}

export function buildSkillListEnv(source: SkillSourceDiscoveryInput): NodeJS.ProcessEnv {
  const env = skillListSubprocessEnv();
  if (!isSshSkillSource(source)) return env;
  if (!source.sshKeyPath) copyEnv(process.env, "SSH_AUTH_SOCK", env);
  const hostKeyOpts = source.sshKnownHostsPath
    ? ["-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${quoteSshArg(source.sshKnownHostsPath)}`]
    : ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null"];
  return {
    ...env,
    GIT_SSH_COMMAND: [
      "ssh",
      ...(source.sshKeyPath ? ["-i", quoteSshArg(source.sshKeyPath), "-o", "IdentitiesOnly=yes"] : []),
      ...hostKeyOpts,
      ...(source.sshPort !== undefined ? ["-p", String(source.sshPort)] : []),
    ].join(" "),
  };
}

export async function validateSkillSourceSshAuth(source: SkillSourceDiscoveryInput): Promise<void> {
  if (!source.source.startsWith("ssh://") && !source.source.startsWith("git@")) return;
  if (!source.sshKeyPath) {
    if (!process.env["SSH_AUTH_SOCK"]) {
      throw new Error("SSH skill sources require the orchestrator to run with SSH_AUTH_SOCK, or an SSH private key path on the skill source.");
    }
  } else {
    try {
      await access(source.sshKeyPath, constants.R_OK);
    } catch {
      throw new Error(`SSH private key path is not readable by the orchestrator process: ${source.sshKeyPath}. If the orchestrator runs in Docker, use a path mounted inside the container or leave the key path blank to use the forwarded SSH_AUTH_SOCK.`);
    }
  }
  if (source.sshKnownHostsPath) {
    try {
      await access(source.sshKnownHostsPath, constants.R_OK);
    } catch {
      throw new Error(`SSH known_hosts path is not readable by the orchestrator process: ${source.sshKnownHostsPath}.`);
    }
  }
}

export function parseSkillListOutput(output: string): string[] {
  const skills = new Set<string>();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine
      .replace(/^[\s│┃|]+/, "")
      .replace(/^[-*•]\s+/, "")
      .trim();
    const match = /^(?:skill\s+)?([a-zA-Z0-9][a-zA-Z0-9._-]*)(?:\s|:|—|-|$)/i.exec(line);
    if (!match?.[1]) continue;
    const name = match[1];
    if (["name", "skills", "source", "found", "available", "installing", "failed"].includes(name.toLowerCase())) continue;
    skills.add(name);
  }
  return Array.from(skills).sort((a, b) => a.localeCompare(b));
}

export async function listSkillSourceSkills(source: SkillSourceDiscoveryInput): Promise<{ skills: string[]; output: string }> {
  await validateSkillSourceSshAuth(source);
  try {
    const { stdout, stderr } = await execFileAsync("npx", buildSkillListArgs(source), {
      env: buildSkillListEnv(source),
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: SKILL_LIST_TIMEOUT_MS,
    });
    const output = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim().slice(0, OUTPUT_LIMIT);
    return { skills: parseSkillListOutput(output), output };
  } catch (err) {
    const error = err as { stdout?: unknown; stderr?: unknown; message?: unknown; code?: unknown; signal?: unknown; killed?: unknown };
    const stdout = typeof error.stdout === "string" ? error.stdout.trim() : "";
    const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
    const message = typeof error.message === "string" ? error.message : "npx skills list failed";
    const details = [
      ...(error.killed === true || error.signal === "SIGTERM" ? [`timed out after ${SKILL_LIST_TIMEOUT_MS / 1000}s`] : []),
      ...(typeof error.code === "number" ? [`exit code ${error.code}`] : []),
      ...(stderr ? [`stderr: ${stderr}`] : []),
      ...(stdout ? [`stdout: ${stdout}`] : []),
      ...(!stderr && !stdout ? [message] : []),
    ].join("; ").slice(0, OUTPUT_LIMIT);
    throw new Error(details || message);
  }
}
