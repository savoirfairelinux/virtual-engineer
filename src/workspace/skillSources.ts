export type AgentProvider = "copilot" | "claude";

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

const DEFAULT_SKILLS_CLI_PACKAGE = "skills@1.5.16";
const MAX_TCP_PORT = 65_535;

function skillsCliPackage(): string {
  return process.env["SKILLS_CLI_PACKAGE"]?.trim() || DEFAULT_SKILLS_CLI_PACKAGE;
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
  return provider === "claude" ? "claude-code" : "github-copilot";
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

export function buildSkillsCliArgs(source: RemoteSkillSource, provider: AgentProvider): string[] {
  const args = ["--yes", skillsCliPackage(), "add", resolveSkillSourceUrl(source)];
  if (source.installAll !== true) {
    for (const skill of source.skills) {
      args.push("--skill", skill);
    }
  }
  args.push("-g", "-a", skillsAgentId(provider), "--copy", "-y");
  return args;
}

export function isSshSkillSource(source: RemoteSkillSource): boolean {
  const normalized = source.source.trimStart().toLowerCase();
  return normalized.startsWith("ssh://") || normalized.startsWith("git@");
}
