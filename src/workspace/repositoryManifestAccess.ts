import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildSshHostKeyOptions, type GerritSshConfig } from "../connectors/gerritSshClient.js";
import { WORKSPACE_MANIFEST_MAX_BYTES, WORKSPACE_MANIFEST_MAX_FILES, type WorkspaceManifestFile } from "./workspaceManifestScanner.js";

const execFileAsync = promisify(execFile);
const REMOTE_READ_TIMEOUT_MS = 60_000;
const MAX_ROOT_PAGES = 10;
const MAX_MANIFEST_DIRECTORY_DEPTH = 4;
const MAX_DEPENDENCY_FILE_DIRECTORY_DEPTH = 8;
const GENERATED_DIRECTORY_NAMES = new Set([".cache", ".git", ".venv", "build", "dist", "node_modules", "out", "_deps"]);

export function isWorkspaceManifestPath(filePath: string): boolean {
  if (!filePath || filePath.startsWith("/") || filePath.includes("\\") || /[\0\r\n]/.test(filePath)) return false;
  const segments = filePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return false;
  const fileName = segments.at(-1) ?? "";
  const directorySegments = segments.slice(0, -1);
  const generated = directorySegments.some((segment) => GENERATED_DIRECTORY_NAMES.has(segment) || segment.startsWith("cmake-build-"));
  if (fileName === "CMakeLists.txt" || (fileName === "package.json" && segments.includes("contrib"))) {
    return !generated && directorySegments.length <= MAX_DEPENDENCY_FILE_DIRECTORY_DEPTH;
  }
  if (directorySegments.length > MAX_MANIFEST_DIRECTORY_DEPTH) return false;
  return fileName === ".gitmodules"
    || fileName === "west.yml"
    || fileName === "manifest.xml"
    || fileName === "default.xml"
    || fileName.endsWith(".repos")
    || fileName.endsWith(".code-workspace");
}

function assertRepositoryKey(repoKey: string): void {
  const segments = repoKey.split("/");
  if (!repoKey || repoKey.startsWith("/") || /[\0\r\n]/.test(repoKey) || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Invalid repository key");
  }
}

function assertManifestSize(filePath: string, content: string): void {
  if (Buffer.byteLength(content, "utf8") > WORKSPACE_MANIFEST_MAX_BYTES) {
    throw new Error(`Workspace manifest '${filePath}' exceeds the 256 KiB limit`);
  }
}

function assertManifestCount(paths: string[]): void {
  if (paths.length > WORKSPACE_MANIFEST_MAX_FILES) {
    throw new Error(`Repository exposes ${paths.length} workspace manifests; the scan limit is ${WORKSPACE_MANIFEST_MAX_FILES}`);
  }
}

async function responseText(response: Response, label: string): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > WORKSPACE_MANIFEST_MAX_BYTES) {
    throw new Error(`${label} exceeds the 256 KiB limit`);
  }
  const content = await response.text();
  assertManifestSize(label, content);
  return content;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function encodeRepoKey(repoKey: string): string {
  return repoKey.split("/").map(encodeURIComponent).join("/");
}

export async function readGitHubWorkspaceManifestFiles(input: {
  apiBaseUrl: string;
  token: string;
  repoKey: string;
  revision?: string | undefined;
}): Promise<WorkspaceManifestFile[]> {
  assertRepositoryKey(input.repoKey);
  const repoPath = encodeRepoKey(input.repoKey);
  const refQuery = input.revision ? `?ref=${encodeURIComponent(input.revision)}` : "";
  const treeRef = encodeURIComponent(input.revision ?? "HEAD");
  const listingUrl = `${input.apiBaseUrl}/repos/${repoPath}/git/trees/${treeRef}?recursive=1`;
  const listingResponse = await globalThis.fetch(listingUrl, { headers: githubHeaders(input.token) });
  if (!listingResponse.ok) {
    throw new Error(`GitHub repository listing failed (${listingResponse.status})`);
  }
  const listing: unknown = await listingResponse.json();
  if (listing === null || typeof listing !== "object" || Array.isArray(listing)) {
    throw new Error("GitHub repository listing returned an invalid response");
  }
  const listingValue = listing as Record<string, unknown>;
  if (listingValue["truncated"] === true) {
    throw new Error("GitHub repository tree was truncated; workspace scan cannot safely continue");
  }
  const tree = listingValue["tree"];
  if (!Array.isArray(tree)) throw new Error("GitHub repository listing returned an invalid response");
  const paths = tree.flatMap((entry): string[] => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
    const value = entry as Record<string, unknown>;
    return value["type"] === "blob" && typeof value["path"] === "string" && isWorkspaceManifestPath(value["path"])
      ? [value["path"]]
      : [];
  }).sort();
  assertManifestCount(paths);

  return Promise.all(paths.map(async (filePath): Promise<WorkspaceManifestFile> => {
    const fileUrl = `${input.apiBaseUrl}/repos/${repoPath}/contents/${encodeRepoKey(filePath)}${refQuery}`;
    const response = await globalThis.fetch(fileUrl, { headers: githubHeaders(input.token) });
    if (!response.ok) throw new Error(`GitHub manifest read failed for '${filePath}' (${response.status})`);
    const payload: unknown = await response.json();
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error(`GitHub manifest '${filePath}' returned an invalid response`);
    }
    const value = payload as Record<string, unknown>;
    if (value["encoding"] !== "base64" || typeof value["content"] !== "string") {
      throw new Error(`GitHub manifest '${filePath}' did not contain base64 content`);
    }
    const content = Buffer.from(value["content"].replace(/\s/g, ""), "base64").toString("utf8");
    assertManifestSize(filePath, content);
    return { path: filePath, content };
  }));
}

function gitLabHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export async function readGitLabWorkspaceManifestFiles(input: {
  baseUrl: string;
  token: string;
  repoKey: string;
  revision?: string | undefined;
}): Promise<WorkspaceManifestFile[]> {
  assertRepositoryKey(input.repoKey);
  const project = encodeURIComponent(input.repoKey);
  const apiBase = `${input.baseUrl.replace(/\/+$/, "")}/api/v4/projects/${project}`;
  const paths = new Set<string>();
  let page = 1;
  while (page <= MAX_ROOT_PAGES) {
    const query = new URLSearchParams({ per_page: "100", page: String(page), recursive: "true" });
    if (input.revision) query.set("ref", input.revision);
    const response = await globalThis.fetch(`${apiBase}/repository/tree?${query}`, { headers: gitLabHeaders(input.token) });
    if (!response.ok) throw new Error(`GitLab repository listing failed (${response.status})`);
    const listing: unknown = await response.json();
    if (!Array.isArray(listing)) throw new Error("GitLab repository listing returned an invalid response");
    for (const entry of listing) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const value = entry as Record<string, unknown>;
      if (value["type"] === "blob" && typeof value["path"] === "string" && isWorkspaceManifestPath(value["path"])) {
        paths.add(value["path"]);
      }
    }
    const nextPage = response.headers.get("x-next-page")?.trim();
    if (!nextPage) break;
    const parsedPage = Number(nextPage);
    if (!Number.isSafeInteger(parsedPage) || parsedPage <= page) break;
    page = parsedPage;
  }

  const sortedPaths = [...paths].sort();
  assertManifestCount(sortedPaths);
  return Promise.all(sortedPaths.map(async (filePath): Promise<WorkspaceManifestFile> => {
    const query = new URLSearchParams({ ref: input.revision ?? "HEAD" });
    const response = await globalThis.fetch(
      `${apiBase}/repository/files/${encodeURIComponent(filePath)}/raw?${query}`,
      { headers: gitLabHeaders(input.token) },
    );
    if (!response.ok) throw new Error(`GitLab manifest read failed for '${filePath}' (${response.status})`);
    return { path: filePath, content: await responseText(response, filePath) };
  }));
}

function quoteSshPath(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

function buildGerritGitEnv(config: GerritSshConfig): NodeJS.ProcessEnv {
  const identity = config.keyPath
    ? ["-i", quoteSshPath(config.keyPath), "-o", "IdentitiesOnly=yes"]
    : config.agentPubKeyPath
      ? ["-o", "IdentitiesOnly=yes", "-i", quoteSshPath(config.agentPubKeyPath)]
      : [];
  return {
    ...process.env,
    GIT_SSH_COMMAND: [
      "ssh",
      "-p", String(config.port),
      ...identity,
      ...buildSshHostKeyOptions(config.knownHostsPath),
    ].join(" "),
  };
}

export async function readGerritWorkspaceManifestFiles(input: {
  ssh: GerritSshConfig;
  repoKey: string;
  revision?: string | undefined;
}): Promise<WorkspaceManifestFile[]> {
  assertRepositoryKey(input.repoKey);
  const directory = await mkdtemp(path.join(tmpdir(), "ve-workspace-scan-"));
  const env = buildGerritGitEnv(input.ssh);
  const git = async (args: string[], maxBuffer = WORKSPACE_MANIFEST_MAX_BYTES * 2): Promise<string> => {
    const { stdout } = await execFileAsync("git", ["-C", directory, ...args], {
      env,
      timeout: REMOTE_READ_TIMEOUT_MS,
      maxBuffer,
      encoding: "utf8",
    });
    return stdout;
  };
  try {
    const repositoryUrl = `ssh://${input.ssh.user}@${input.ssh.host}:${input.ssh.port}/${input.repoKey}`;
    await git(["init", "--quiet"]);
    await git(["remote", "add", "origin", repositoryUrl]);
    try {
      await git(["fetch", "--quiet", "--depth=1", "--filter=blob:none", "origin", input.revision ?? "HEAD"]);
    } catch {
      await git(["fetch", "--quiet", "--depth=1", "origin", input.revision ?? "HEAD"]);
    }
    const manifestPaths = (await git(["ls-tree", "-r", "--name-only", "FETCH_HEAD"]))
      .split(/\r?\n/)
      .filter(isWorkspaceManifestPath)
      .sort();
    assertManifestCount(manifestPaths);
    const files: WorkspaceManifestFile[] = [];
    for (const filePath of manifestPaths) {
      const content = await git(["show", `FETCH_HEAD:${filePath}`], WORKSPACE_MANIFEST_MAX_BYTES + 1024);
      assertManifestSize(filePath, content);
      files.push({ path: filePath, content });
    }
    return files;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}