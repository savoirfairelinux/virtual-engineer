import path from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { parse as parseYaml } from "yaml";

export const WORKSPACE_MANIFEST_MAX_BYTES = 256 * 1024;
export const WORKSPACE_MANIFEST_MAX_FILES = 200;

export type WorkspaceManifestRelation = "gitlink" | "manifest_member" | "contains";

export interface WorkspaceManifestFile {
  path: string;
  content: string;
}

export interface WorkspaceManifestRepository {
  cloneUrl: string | null;
  localPath: string;
  revision: string | null;
  relation: WorkspaceManifestRelation;
  sourcePath: string;
}

export interface WorkspaceManifestDiagnostic {
  sourcePath: string;
  severity: "info" | "warning" | "error";
  message: string;
}

export interface WorkspaceManifestScanResult {
  repositories: WorkspaceManifestRepository[];
  diagnostics: WorkspaceManifestDiagnostic[];
}

export interface WorkspaceManifestScanInput {
  rootCloneUrl: string;
  files: WorkspaceManifestFile[];
}

interface MutableScanResult extends WorkspaceManifestScanResult {
  repositories: WorkspaceManifestRepository[];
  diagnostics: WorkspaceManifestDiagnostic[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeLocalPath(value: string): string | null {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!normalized || normalized === "." || normalized.startsWith("/") || normalized.includes("\0")) return null;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  return normalized;
}

function isAbsoluteRepositoryUrl(value: string): boolean {
  return /^[a-z][a-z\d+.-]*:\/\//i.test(value) || /^(?:[^@/\s]+@)?[^:/\s]+:.+/.test(value);
}

function appendRepositoryPath(base: string, repositoryPath: string): string {
  const suffix = repositoryPath.replace(/^\/+/, "");
  if (!base.includes("://") && /^(?:[^@/\s]+@)?[^:/\s]+:.+/.test(base)) {
    return `${base.replace(/\/+$/, "")}/${suffix}`;
  }
  return `${base.replace(/\/+$/, "")}/${suffix}`;
}

function resolveRelativeRepositoryUrl(rootCloneUrl: string, repositoryUrl: string): string {
  const value = repositoryUrl.trim();
  if (isAbsoluteRepositoryUrl(value)) return value;

  if (!rootCloneUrl.includes("://")) {
    const match = /^((?:[^@/\s]+@)?[^:/\s]+:)(.+)$/.exec(rootCloneUrl);
    if (!match) return value;
    const resolvedPath = path.posix.normalize(path.posix.join(match[2] ?? "", value));
    return `${match[1]}${resolvedPath}`;
  }

  try {
    const base = new URL(rootCloneUrl.endsWith("/") ? rootCloneUrl : `${rootCloneUrl}/`);
    return new URL(value, base).toString();
  } catch {
    return value;
  }
}

function addRepository(
  result: MutableScanResult,
  sourcePath: string,
  candidate: Omit<WorkspaceManifestRepository, "sourcePath">
): void {
  const manifestDirectory = path.posix.dirname(sourcePath);
  const candidatePath = manifestDirectory === "."
    ? candidate.localPath
    : path.posix.join(manifestDirectory, candidate.localPath);
  const localPath = normalizeLocalPath(candidatePath);
  if (!localPath) {
    result.diagnostics.push({
      sourcePath,
      severity: "warning",
      message: `Ignored repository with unsafe or empty local path '${candidate.localPath}'.`,
    });
    return;
  }
  result.repositories.push({ ...candidate, localPath, sourcePath });
}

function addWorkspaceRootRepository(
  result: MutableScanResult,
  sourcePath: string,
  candidate: Omit<WorkspaceManifestRepository, "sourcePath">
): void {
  const localPath = normalizeLocalPath(candidate.localPath);
  if (!localPath) {
    result.diagnostics.push({ sourcePath, severity: "warning", message: `Ignored dependency with unsafe local path '${candidate.localPath}'.` });
    return;
  }
  result.repositories.push({ ...candidate, localPath, sourcePath });
}

function unquote(value: string): string {
  return value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ? value.slice(1, -1)
    : value;
}

function staticDependencyValue(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = unquote(value.trim());
  return !normalized || normalized.includes("${") || normalized.includes("$<") ? null : normalized;
}

function repositoryUrlFromDownloadUrl(sourceUrl: string): { cloneUrl: string; revision: string | null } | null {
  try {
    const parsed = new URL(sourceUrl);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (parsed.hostname.toLowerCase() === "github.com" && segments.length >= 2) {
      const [owner, repository] = segments;
      if (!owner || !repository) return null;
      const marker = segments[2];
      if (marker === "archive" || (marker === "releases" && segments[3] === "download")) {
        const tagIndex = marker === "archive" && segments[3] === "refs" && segments[4] === "tags" ? 5 : marker === "releases" ? 4 : 3;
        const rawRevision = segments[tagIndex];
        return {
          cloneUrl: `${parsed.protocol}//${parsed.host}/${owner}/${repository.replace(/\.git$/i, "")}.git`,
          revision: rawRevision ? rawRevision.replace(/\.(?:zip|tar(?:\.(?:gz|bz2|xz))?)$/i, "") : null,
        };
      }
    }
    const archiveIndex = segments.indexOf("-");
    if (archiveIndex > 0 && segments[archiveIndex + 1] === "archive") {
      const repositoryPath = segments.slice(0, archiveIndex).join("/").replace(/\.git$/i, "");
      const rawRevision = segments[archiveIndex + 2];
      return {
        cloneUrl: `${parsed.protocol}//${parsed.host}/${repositoryPath}.git`,
        revision: rawRevision ? rawRevision.replace(/\.(?:zip|tar(?:\.(?:gz|bz2|xz))?)$/i, "") : null,
      };
    }
    if (parsed.pathname.endsWith(".git")) return { cloneUrl: sourceUrl, revision: null };
  } catch {
    return null;
  }
  return null;
}

function scanContribPackage(file: WorkspaceManifestFile, result: MutableScanResult): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.content);
  } catch {
    result.diagnostics.push({ sourcePath: file.path, severity: "error", message: "Invalid contrib package JSON." });
    return;
  }
  const manifest = asRecord(parsed);
  const name = asString(manifest?.["name"]);
  const sourceUrl = asString(manifest?.["url"]);
  const version = asString(manifest?.["version"]);
  if (!name || !sourceUrl || !version || !/^[a-zA-Z0-9._+-]+$/.test(name)) {
    result.diagnostics.push({ sourcePath: file.path, severity: "warning", message: "Ignored contrib package without safe name, URL, and version fields." });
    return;
  }
  const repository = repositoryUrlFromDownloadUrl(sourceUrl.replaceAll("__VERSION__", version));
  if (!repository) {
    result.diagnostics.push({ sourcePath: file.path, severity: "info", message: `Contrib package '${name}' does not expose an inferable Git repository URL.` });
    return;
  }
  addWorkspaceRootRepository(result, file.path, {
    cloneUrl: repository.cloneUrl,
    localPath: `.ve-deps/${name}`,
    revision: version,
    relation: "manifest_member",
  });
}

function cmakeDeclareBodies(content: string): string[] {
  const bodies: string[] = [];
  const declaration = /FetchContent_Declare\s*\(/gi;
  for (let match = declaration.exec(content); match; match = declaration.exec(content)) {
    const start = declaration.lastIndex;
    let depth = 1;
    let quote: string | null = null;
    let index = start;
    for (; index < content.length && depth > 0; index += 1) {
      const character = content[index];
      if (quote) {
        if (character === quote && content[index - 1] !== "\\") quote = null;
      } else if (character === '"' || character === "'") quote = character;
      else if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
    }
    if (depth === 0) bodies.push(content.slice(start, index - 1));
    declaration.lastIndex = Math.max(declaration.lastIndex, index);
  }
  return bodies;
}

function scanCmake(file: WorkspaceManifestFile, result: MutableScanResult): void {
  for (const body of cmakeDeclareBodies(file.content)) {
    const tokens = body.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s()]+/g) ?? [];
    const name = staticDependencyValue(tokens[0]);
    if (!name || !/^[a-zA-Z0-9._+-]+$/.test(name)) continue;
    const valueAfter = (keyword: string): string | null => {
      const index = tokens.findIndex((token) => token.toUpperCase() === keyword);
      return staticDependencyValue(index >= 0 ? tokens[index + 1] : undefined);
    };
    const gitRepository = valueAfter("GIT_REPOSITORY");
    const downloadUrl = valueAfter("URL");
    const repository = gitRepository
      ? repositoryUrlFromDownloadUrl(gitRepository)
      : downloadUrl ? repositoryUrlFromDownloadUrl(downloadUrl) : null;
    if (!repository) {
      result.diagnostics.push({ sourcePath: file.path, severity: "info", message: `FetchContent dependency '${name}' has no static inferable Git repository URL.` });
      continue;
    }
    addWorkspaceRootRepository(result, file.path, {
      cloneUrl: repository.cloneUrl,
      localPath: `.ve-deps/${name}`,
      revision: valueAfter("GIT_TAG") ?? repository.revision,
      relation: "manifest_member",
    });
  }
}

function scanGitmodules(
  file: WorkspaceManifestFile,
  rootCloneUrl: string,
  result: MutableScanResult
): void {
  const sections: Array<Record<string, string>> = [];
  let current: Record<string, string> | null = null;
  for (const rawLine of file.content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (/^\[submodule\s+"[^"]+"\]$/.test(line)) {
      current = {};
      sections.push(current);
      continue;
    }
    const separator = line.indexOf("=");
    if (!current || separator < 1) continue;
    current[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }

  for (const section of sections) {
    const localPath = section["path"];
    const repositoryUrl = section["url"];
    if (!localPath || !repositoryUrl) {
      result.diagnostics.push({
        sourcePath: file.path,
        severity: "warning",
        message: "Ignored submodule without both path and URL.",
      });
      continue;
    }
    addRepository(result, file.path, {
      cloneUrl: resolveRelativeRepositoryUrl(rootCloneUrl, repositoryUrl),
      localPath,
      revision: section["branch"] ?? null,
      relation: "gitlink",
    });
  }
}

function scanWest(file: WorkspaceManifestFile, result: MutableScanResult): void {
  let parsed: unknown;
  try {
    parsed = parseYaml(file.content);
  } catch (error) {
    result.diagnostics.push({ sourcePath: file.path, severity: "error", message: `Invalid west manifest: ${String(error)}` });
    return;
  }
  const manifest = asRecord(asRecord(parsed)?.["manifest"]);
  if (!manifest) {
    result.diagnostics.push({ sourcePath: file.path, severity: "error", message: "Invalid west manifest: missing manifest object." });
    return;
  }
  const remotes = new Map<string, string>();
  if (Array.isArray(manifest["remotes"])) {
    for (const remoteValue of manifest["remotes"]) {
      const remote = asRecord(remoteValue);
      const name = asString(remote?.["name"]);
      const urlBase = asString(remote?.["url-base"]);
      if (name && urlBase) remotes.set(name, urlBase);
    }
  }
  const defaults = asRecord(manifest["defaults"]);
  const defaultRemote = asString(defaults?.["remote"]);
  const defaultRevision = asString(defaults?.["revision"]);
  const projects = manifest["projects"];
  if (!Array.isArray(projects)) return;

  for (const projectValue of projects) {
    const project = asRecord(projectValue);
    const name = asString(project?.["name"]);
    if (!project || !name) continue;
    const explicitUrl = asString(project["url"]);
    const remoteName = asString(project["remote"]) ?? defaultRemote;
    const remoteBase = remoteName ? remotes.get(remoteName) : undefined;
    const repoPath = asString(project["repo-path"]) ?? name;
    const cloneUrl = explicitUrl ?? (remoteBase ? appendRepositoryPath(remoteBase, repoPath) : null);
    if (!cloneUrl) {
      result.diagnostics.push({
        sourcePath: file.path,
        severity: "warning",
        message: `West project '${name}' has no resolvable URL or remote.`,
      });
      continue;
    }
    addRepository(result, file.path, {
      cloneUrl,
      localPath: asString(project["path"]) ?? name,
      revision: asString(project["revision"]) ?? defaultRevision,
      relation: "manifest_member",
    });
  }
}

function scanRepoXml(file: WorkspaceManifestFile, result: MutableScanResult): void {
  if (/<!DOCTYPE/i.test(file.content)) {
    result.diagnostics.push({ sourcePath: file.path, severity: "error", message: "Repo XML manifests must not contain a DOCTYPE declaration." });
    return;
  }
  const validation = XMLValidator.validate(file.content);
  if (validation !== true) {
    result.diagnostics.push({ sourcePath: file.path, severity: "error", message: "Invalid repo XML manifest." });
    return;
  }
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    isArray: (name, _jPath, _isLeafNode, isAttribute): boolean => !isAttribute && (name === "remote" || name === "project"),
  });
  const manifest = asRecord(asRecord(parser.parse(file.content) as unknown)?.["manifest"]);
  if (!manifest) {
    result.diagnostics.push({ sourcePath: file.path, severity: "error", message: "Invalid repo XML manifest: missing manifest element." });
    return;
  }
  const remotes = new Map<string, { fetch: string; revision: string | null }>();
  for (const remoteValue of Array.isArray(manifest["remote"]) ? manifest["remote"] : []) {
    const remote = asRecord(remoteValue);
    const name = asString(remote?.["name"]);
    const fetch = asString(remote?.["fetch"]);
    if (name && fetch) remotes.set(name, { fetch, revision: asString(remote?.["revision"]) });
  }
  const defaults = asRecord(manifest["default"]);
  const defaultRemote = asString(defaults?.["remote"]);
  const defaultRevision = asString(defaults?.["revision"]);
  for (const projectValue of Array.isArray(manifest["project"]) ? manifest["project"] : []) {
    const project = asRecord(projectValue);
    const name = asString(project?.["name"]);
    const remoteName = asString(project?.["remote"]) ?? defaultRemote;
    const remote = remoteName ? remotes.get(remoteName) : undefined;
    if (!project || !name || !remote) {
      result.diagnostics.push({
        sourcePath: file.path,
        severity: "warning",
        message: `Repo project '${name ?? "unknown"}' has no resolvable remote.`,
      });
      continue;
    }
    addRepository(result, file.path, {
      cloneUrl: appendRepositoryPath(remote.fetch, name),
      localPath: asString(project["path"]) ?? name.replace(/\.git$/i, ""),
      revision: asString(project["revision"]) ?? remote.revision ?? defaultRevision,
      relation: "manifest_member",
    });
  }
}

function scanVcstool(file: WorkspaceManifestFile, result: MutableScanResult): void {
  let parsed: unknown;
  try {
    parsed = parseYaml(file.content);
  } catch (error) {
    result.diagnostics.push({ sourcePath: file.path, severity: "error", message: `Invalid vcstool manifest: ${String(error)}` });
    return;
  }
  const repositories = asRecord(asRecord(parsed)?.["repositories"]);
  if (!repositories) {
    result.diagnostics.push({ sourcePath: file.path, severity: "error", message: "Invalid vcstool manifest: missing repositories object." });
    return;
  }
  for (const [localPath, repositoryValue] of Object.entries(repositories)) {
    const repository = asRecord(repositoryValue);
    if (!repository) {
      result.diagnostics.push({ sourcePath: file.path, severity: "warning", message: `Ignored invalid vcstool entry '${localPath}'.` });
      continue;
    }
    const type = asString(repository["type"]);
    const cloneUrl = asString(repository["url"]);
    if (type !== "git") {
      result.diagnostics.push({ sourcePath: file.path, severity: "info", message: `Ignored non-Git vcstool entry '${localPath}'.` });
      continue;
    }
    if (!cloneUrl) {
      result.diagnostics.push({ sourcePath: file.path, severity: "warning", message: `Ignored vcstool entry '${localPath}' without URL.` });
      continue;
    }
    addRepository(result, file.path, {
      cloneUrl,
      localPath,
      revision: asString(repository["version"]),
      relation: "manifest_member",
    });
  }
}

function scanCodeWorkspace(file: WorkspaceManifestFile, result: MutableScanResult): void {
  const errors: ParseError[] = [];
  const parsed = parseJsonc(file.content, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    result.diagnostics.push({ sourcePath: file.path, severity: "error", message: "Invalid VS Code workspace JSONC." });
    return;
  }
  const folders = asRecord(parsed)?.["folders"];
  if (!Array.isArray(folders)) {
    result.diagnostics.push({ sourcePath: file.path, severity: "error", message: "Invalid VS Code workspace: missing folders array." });
    return;
  }
  for (const folderValue of folders) {
    const folder = asRecord(folderValue);
    const folderPath = asString(folder?.["path"]);
    const uri = asString(folder?.["uri"]);
    const name = asString(folder?.["name"]);
    if (folderPath === ".") continue;
    const cloneUrl = uri && isAbsoluteRepositoryUrl(uri) ? uri : null;
    let derivedLocalPath: string | null = null;
    if (cloneUrl) {
      try {
        const remotePath = cloneUrl.includes("://")
          ? new URL(cloneUrl).pathname
          : cloneUrl.split(":", 2)[1] ?? "";
        derivedLocalPath = path.posix.basename(remotePath).replace(/\.git$/i, "");
      } catch {
        derivedLocalPath = null;
      }
    }
    const localPath = folderPath ?? name ?? derivedLocalPath;
    if (!localPath) continue;
    addRepository(result, file.path, {
      cloneUrl,
      localPath,
      revision: null,
      relation: "contains",
    });
    if (!cloneUrl) {
      result.diagnostics.push({
        sourcePath: file.path,
        severity: "warning",
        message: `Workspace folder '${localPath}' does not declare a repository URL and requires manual binding.`,
      });
    }
  }
}

/** Parse supported workspace manifests without network access or side effects. */
export function scanWorkspaceManifests(input: WorkspaceManifestScanInput): WorkspaceManifestScanResult {
  const result: MutableScanResult = { repositories: [], diagnostics: [] };
  if (input.files.length > WORKSPACE_MANIFEST_MAX_FILES) {
    result.diagnostics.push({
      sourcePath: "workspace",
      severity: "error",
      message: `Only the first ${WORKSPACE_MANIFEST_MAX_FILES} of ${input.files.length} manifests were scanned.`,
    });
  }
  for (const file of input.files.slice(0, WORKSPACE_MANIFEST_MAX_FILES)) {
    if (Buffer.byteLength(file.content, "utf8") > WORKSPACE_MANIFEST_MAX_BYTES) {
      result.diagnostics.push({ sourcePath: file.path, severity: "error", message: "Manifest exceeds the 256 KiB limit." });
      continue;
    }
    if (file.path === ".gitmodules") scanGitmodules(file, input.rootCloneUrl, result);
    else if (path.posix.basename(file.path) === "west.yml") scanWest(file, result);
    else if (file.path.endsWith(".xml")) scanRepoXml(file, result);
    else if (file.path.endsWith(".repos")) scanVcstool(file, result);
    else if (file.path.endsWith(".code-workspace")) scanCodeWorkspace(file, result);
    else if (path.posix.basename(file.path) === "package.json" && file.path.split("/").includes("contrib")) scanContribPackage(file, result);
    else if (path.posix.basename(file.path) === "CMakeLists.txt") scanCmake(file, result);
  }
  return result;
}