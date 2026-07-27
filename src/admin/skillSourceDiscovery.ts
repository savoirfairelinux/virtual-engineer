import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveSshSkillSourceUrl, sshSkillSourceCommandPort } from "../workspace/skillSources.js";
import { getLogger } from "../logger.js";
import { readSshFileSecure } from "../utils/sshFilePath.js";

const execFileAsync = promisify(execFile);
const log = getLogger("skill-source-discovery");

const DEFAULT_SKILLS_CLI_PACKAGE = "skills@1.5.16";
const OUTPUT_LIMIT = 4000;
export const SKILL_LIST_TIMEOUT_MS = 30_000;
export const SKILL_SSH_CONNECT_TIMEOUT_MS = 10_000;

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

function normalizedSourcePrefix(source: string): string {
  return source.trimStart().toLowerCase();
}

function isSshUrlSource(source: string): boolean {
  return normalizedSourcePrefix(source).startsWith("ssh://");
}

function isSshSkillSource(source: SkillSourceDiscoveryInput): boolean {
  const normalized = normalizedSourcePrefix(source.source);
  return normalized.startsWith("ssh://") || normalized.startsWith("git@");
}

function sshConnectionSpec(source: SkillSourceDiscoveryInput): { target: string; port?: number } | undefined {
  const sourceValue = source.source.trimStart();
  if (isSshUrlSource(sourceValue)) {
    const resolved = new URL(resolveSkillSourceUrl(source));
    const user = resolved.username ? `${decodeURIComponent(resolved.username)}@` : "";
    return {
      target: `${user}${resolved.hostname}`,
      ...(resolved.port ? { port: Number(resolved.port) } : {}),
    };
  }

  const scpLike = /^([^@\s]+@[^:\s]+):/.exec(sourceValue);
  if (!scpLike?.[1]) return undefined;
  return {
    target: scpLike[1],
    ...(source.sshPort !== undefined ? { port: source.sshPort } : {}),
  };
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
  const sshPort = sshSkillSourceCommandPort(source);
  const hostKeyOpts = source.sshKnownHostsPath
    ? ["-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${quoteSshArg(source.sshKnownHostsPath)}`]
    : ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null"];
  return {
    ...env,
    GIT_SSH_COMMAND: [
      "ssh",
      ...(source.sshKeyPath ? ["-i", quoteSshArg(source.sshKeyPath), "-o", "IdentitiesOnly=yes"] : []),
      ...hostKeyOpts,
      ...(sshPort !== undefined ? ["-p", String(sshPort)] : []),
    ].join(" "),
  };
}

export function buildSshConnectionArgs(source: SkillSourceDiscoveryInput): string[] | undefined {
  const spec = sshConnectionSpec(source);
  if (!spec) return undefined;
  return [
    "-T",
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${Math.ceil(SKILL_SSH_CONNECT_TIMEOUT_MS / 1000)}`,
    ...(source.sshKeyPath ? ["-i", source.sshKeyPath, "-o", "IdentitiesOnly=yes"] : []),
    ...(source.sshKnownHostsPath
      ? ["-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${source.sshKnownHostsPath}`]
      : ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null"]),
    ...(spec.port !== undefined ? ["-p", String(spec.port)] : []),
    spec.target,
  ];
}

export async function validateSkillSourceSshAuth(source: SkillSourceDiscoveryInput): Promise<void> {
  if (!isSshSkillSource(source)) return;
  if (!source.sshKeyPath) {
    if (!process.env["SSH_AUTH_SOCK"]) {
      throw new Error("SSH skill sources require the orchestrator to run with SSH_AUTH_SOCK, or an SSH private key path on the skill source.");
    }
  } else {
    try {
      readSshFileSecure(source.sshKeyPath, "SSH private key");
    } catch {
      throw new Error(`SSH private key path is not readable as a regular file inside an approved secrets directory or as a file generated by this process: ${source.sshKeyPath}. If the orchestrator runs in Docker, use a path mounted inside the container or leave the key path blank to use the forwarded SSH_AUTH_SOCK.`);
    }
  }
  if (source.sshKnownHostsPath) {
    try {
      readSshFileSecure(source.sshKnownHostsPath, "SSH known_hosts");
    } catch {
      throw new Error(`SSH known_hosts path is not readable as a regular file inside an approved secrets directory or as a file generated by this process: ${source.sshKnownHostsPath}.`);
    }
  }
}

export async function validateSkillSourceSshConnection(source: SkillSourceDiscoveryInput, index?: number): Promise<void> {
  const args = buildSshConnectionArgs(source);
  if (!args) return;
  await validateSkillSourceSshAuth(source);
  const spec = sshConnectionSpec(source);
  log.info(
    {
      ...(index !== undefined ? { skillSourceIndex: index + 1 } : {}),
      skillSource: source.source,
      ...(spec ? { sshTarget: spec.target } : {}),
      ...(spec?.port !== undefined ? { sshPort: spec.port } : {}),
    },
    "checking SSH access for skill source"
  );
  try {
    await execFileAsync("ssh", args, {
      env: buildSkillListEnv(source),
      encoding: "utf8",
      timeout: SKILL_SSH_CONNECT_TIMEOUT_MS,
    });
  } catch (err) {
    const error = err as { stdout?: unknown; stderr?: unknown; message?: unknown; code?: unknown; signal?: unknown; killed?: unknown };
    const stdout = typeof error.stdout === "string" ? error.stdout.trim() : "";
    const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
    const output = `${stdout}\n${stderr}`;
    if (error.code === 1 || /successfully connected over SSH/i.test(output)) return;
    const message = typeof error.message === "string" ? error.message : "ssh connection check failed";
    const details = [
      ...(error.killed === true || error.signal === "SIGTERM" ? [`timed out after ${SKILL_SSH_CONNECT_TIMEOUT_MS / 1000}s`] : []),
      ...(typeof error.code === "number" ? [`exit code ${error.code}`] : []),
      ...(stderr ? [`stderr: ${stderr}`] : []),
      ...(stdout ? [`stdout: ${stdout}`] : []),
      ...(!stderr && !stdout ? [message] : []),
    ].join("; ").slice(0, OUTPUT_LIMIT);
    throw new Error(`SSH connection check failed for skill source "${source.source}": ${details || message}`);
  }
}

export async function validateSkillSourcesConnection(sources: SkillSourceDiscoveryInput[]): Promise<void> {
  for (const [index, source] of sources.entries()) {
    try {
      await validateSkillSourceSshConnection(source, index);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Skill source #${index + 1} "${source.source}": ${message}`);
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
