export type AgentProvider = "copilot" | "claude" | "goose" | "codex";

export interface RemoteSkillSource {
  source: string;
  skills: string[];
  installAll?: boolean;
  sshUser?: string;
  sshPort?: number;
  sshKeyPath?: string;
  sshKnownHostsPath?: string;
}

export interface SkillSourceUrlInput {
  source: string;
  sshUser?: string;
  sshPort?: number;
}

/** Minimal shape shared by admin discovery and the host-side installer for SSH/env resolution. */
export interface SkillSourceConnectionInput {
  source: string;
  sshUser?: string;
  sshPort?: number;
  sshKeyPath?: string;
  sshKnownHostsPath?: string;
}

const DEFAULT_SKILLS_CLI_PACKAGE = "skills@1.5.16";
const MAX_TCP_PORT = 65_535;

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

function skillSourceSubprocessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    // `npx` can run with `cwd` inside a freshly cloned, untrusted repository
    // (the install path). npm applies env-var config over any `.npmrc` file,
    // including a project-level one in cwd, so pin the settings a malicious
    // repo could otherwise abuse to redirect package resolution to an
    // attacker-controlled registry/proxy or weaken TLS/script execution.
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_proxy: process.env["HTTP_PROXY"] ?? process.env["http_proxy"] ?? "",
    npm_config_https_proxy: process.env["HTTPS_PROXY"] ?? process.env["https_proxy"] ?? "",
    npm_config_noproxy: process.env["NO_PROXY"] ?? process.env["no_proxy"] ?? "",
    npm_config_strict_ssl: "true",
    npm_config_ignore_scripts: "true",
    npm_config_userconfig: "/dev/null",
    npm_config_globalconfig: "/dev/null",
  };
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

/** Subprocess env for any `skills` CLI invocation (list or install) against `source`. */
export function buildSkillSourceSubprocessEnv(source: SkillSourceConnectionInput): NodeJS.ProcessEnv {
  const env = skillSourceSubprocessEnv();
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseRemoteSkillSource(value: unknown, index: number): RemoteSkillSource {
  const prefix = `Invalid skill source at index ${index}:`;
  if (!isRecord(value) || typeof value["source"] !== "string") {
    throw new Error(`${prefix} source must be a non-empty string`);
  }
  const source = value["source"].trim();
  if (!source) throw new Error(`${prefix} source must be a non-empty string`);
  const installAll = value["installAll"] === true;
  const sshUser = value["sshUser"];
  if (sshUser !== undefined && (typeof sshUser !== "string" || !sshUser.trim())) {
    throw new Error(`${prefix} sshUser must be a non-empty string`);
  }
  const sshPort = value["sshPort"];
  if (sshPort !== undefined && (typeof sshPort !== "number" || !Number.isInteger(sshPort) || sshPort <= 0 || sshPort > MAX_TCP_PORT)) {
    throw new Error(`${prefix} sshPort must be between 1 and 65535`);
  }
  const sshKeyPath = value["sshKeyPath"];
  if (sshKeyPath !== undefined && (typeof sshKeyPath !== "string" || !sshKeyPath.trim())) {
    throw new Error(`${prefix} sshKeyPath must be a non-empty string`);
  }
  const sshKnownHostsPath = value["sshKnownHostsPath"];
  if (sshKnownHostsPath !== undefined && (typeof sshKnownHostsPath !== "string" || !sshKnownHostsPath.trim())) {
    throw new Error(`${prefix} sshKnownHostsPath must be a non-empty string`);
  }
  const rawSkills = value["skills"];
  if (rawSkills !== undefined && !Array.isArray(rawSkills)) {
    throw new Error(`${prefix} skills must be an array`);
  }
  const skills = rawSkills === undefined ? [] : rawSkills.map((skill) => {
    if (typeof skill !== "string" || !skill.trim()) {
      throw new Error(`${prefix} skills must contain only non-empty strings`);
    }
    return skill.trim();
  });
  if (!installAll && skills.length === 0) {
    throw new Error(`${prefix} select at least one skill, or enable installAll`);
  }
  const ssh = {
    ...(typeof sshUser === "string" ? { sshUser: sshUser.trim() } : {}),
    ...(typeof sshPort === "number" ? { sshPort } : {}),
    ...(typeof sshKeyPath === "string" ? { sshKeyPath: sshKeyPath.trim() } : {}),
    ...(typeof sshKnownHostsPath === "string" ? { sshKnownHostsPath: sshKnownHostsPath.trim() } : {}),
  };
  return installAll
    ? { source, skills: [], installAll: true, ...ssh }
    : { source, skills: Array.from(new Set(skills)), ...ssh };
}

export function parseRemoteSkillSources(raw: string): RemoteSkillSource[] {
  if (!raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`skillSourcesJson must be valid JSON: ${message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("skillSourcesJson must be a JSON array");
  }
  return parsed.map((source, index) => parseRemoteSkillSource(source, index));
}

export function skillsAgentId(provider: AgentProvider): string {
  if (provider === "claude") return "claude-code";
  if (provider === "goose") return "goose";
  if (provider === "codex") return "codex";
  return "github-copilot";
}

function isSshUrlSource(source: string): boolean {
  return source.trimStart().toLowerCase().startsWith("ssh://");
}

export function resolveSshSkillSourceUrl(source: SkillSourceUrlInput): string {
  if (!isSshUrlSource(source.source)) {
    return source.source;
  }
  const url = parseSshSkillSourceUrl(source.source);
  rejectConflictingSshPorts(source, url);
  if (source.sshUser === undefined && source.sshPort === undefined) return source.source;
  if (!url.username && source.sshUser !== undefined) url.username = source.sshUser;
  if (!url.port && source.sshPort !== undefined) url.port = String(source.sshPort);
  return url.toString();
}

export function sshSkillSourceCommandPort(source: SkillSourceUrlInput): number | undefined {
  if (source.sshPort === undefined) return undefined;
  if (!isSshUrlSource(source.source)) return source.sshPort;
  const url = parseSshSkillSourceUrl(source.source);
  rejectConflictingSshPorts(source, url);
  return url.port ? undefined : source.sshPort;
}

function parseSshSkillSourceUrl(source: string): URL {
  try {
    const url = new URL(source);
    if (!url.hostname) throw new Error("missing host");
    return url;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid SSH skill source URL "${source}": ${message}`);
  }
}

function rejectConflictingSshPorts(source: SkillSourceUrlInput, url: URL): void {
  if (source.sshPort === undefined || !url.port || Number(url.port) === source.sshPort) return;
  throw new Error(
    `Conflicting SSH ports for skill source "${source.source}": URL uses port ${url.port} but sshPort is ${source.sshPort}. Remove sshPort or make both ports match.`
  );
}

export function resolveSkillSourceUrl(source: RemoteSkillSource): string {
  return resolveSshSkillSourceUrl(source);
}

/** Builds a non-interactive `npx skills add` invocation, project-scoped (no `-g`) so
 * installed skill files land at agent-relative paths inside the given workspace
 * (e.g. `.claude/skills/`) rather than a global HOME directory. */
export function buildSkillsCliArgs(source: RemoteSkillSource, provider: AgentProvider): string[] {
  const args = ["--yes", skillsCliPackage(), "add", resolveSkillSourceUrl(source)];
  if (source.installAll !== true) {
    for (const skill of source.skills) {
      args.push("--skill", skill);
    }
  }
  args.push("-a", skillsAgentId(provider), "--copy", "-y");
  return args;
}

export function isSshSkillSource(source: SkillSourceConnectionInput): boolean {
  const normalized = source.source.trimStart().toLowerCase();
  return normalized.startsWith("ssh://") || normalized.startsWith("git@");
}
