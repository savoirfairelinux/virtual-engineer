import path from "node:path";
import type { Integration, VendorComponentOrigin } from "../interfaces.js";
import type { PluginManager } from "../plugins/pluginManager.js";
import { getProviderDescriptor } from "../plugins/registry.js";
import { resolveRepositoryBindings, type RepositoryBindingResolution } from "./integrationBindingResolver.js";
import {
  scanWorkspaceManifests,
  type WorkspaceManifestDiagnostic,
  type WorkspaceManifestRepository,
} from "./workspaceManifestScanner.js";

export interface IntegrationWorkspaceScanResult {
  manifestFiles: string[];
  repositories: WorkspaceManifestRepository[];
  diagnostics: WorkspaceManifestDiagnostic[];
}

export interface ProjectWorkspaceScanRepository extends WorkspaceManifestRepository {
  resolution: RepositoryBindingResolution | null;
  origin: VendorComponentOrigin;
}

/** Whether VE can push to a scanned repository, or whether it must be patched instead. */
export function classifyRepositoryOrigin(
  cloneUrl: string | null,
  resolution: RepositoryBindingResolution | null,
): VendorComponentOrigin {
  if (cloneUrl === null) return "internal";
  if (resolution?.status === "matched" && resolution.match.enabled) return "fork_pushable";
  if (resolution?.status === "ambiguous") return "ambiguous";
  return "patch_required";
}

export interface ProjectWorkspaceScanResult {
  manifestFiles: string[];
  repositories: ProjectWorkspaceScanRepository[];
  diagnostics: WorkspaceManifestDiagnostic[];
}

const MAX_RECURSIVE_SCAN_DEPTH = 3;
const MAX_SCANNED_REPOSITORIES = 20;

export class WorkspaceScanError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 500 | 502,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceScanError";
  }
}

export async function scanIntegrationWorkspace(input: {
  integration: Integration;
  pluginManager?: PluginManager | undefined;
  adminAuthSecret?: string | undefined;
  repoKey: string;
  cloneUrl: string;
  revision?: string | undefined;
}): Promise<IntegrationWorkspaceScanResult> {
  const descriptor = getProviderDescriptor(input.integration.provider);
  if (!descriptor?.readWorkspaceManifestFiles) {
    throw new WorkspaceScanError(
      `Provider '${input.integration.provider}' does not support workspace scanning`,
      400,
    );
  }

  let parsedConfig: unknown;
  try {
    parsedConfig = input.pluginManager
      ? input.pluginManager.decryptIntegrationConfig(input.integration)
      : JSON.parse(input.integration.configJson);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WorkspaceScanError(`Unable to read stored integration config: ${message}`, 500, { cause: error });
  }
  if (parsedConfig === null || typeof parsedConfig !== "object" || Array.isArray(parsedConfig)) {
    throw new WorkspaceScanError("Stored integration config must be a JSON object", 500);
  }
  const config = { ...parsedConfig as Record<string, unknown> };
  try {
    if (descriptor.preprocessConfig) {
      Object.assign(config, descriptor.preprocessConfig(config, input.adminAuthSecret, input.integration.id));
    }
    const files = await descriptor.readWorkspaceManifestFiles(config, input.repoKey, input.revision);
    const result = scanWorkspaceManifests({ rootCloneUrl: input.cloneUrl, files });
    return {
      manifestFiles: files.map((file) => file.path),
      repositories: result.repositories,
      diagnostics: result.diagnostics,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WorkspaceScanError(`Workspace scan failed: ${message}`, 502, { cause: error });
  }
}

/** Scan a root repository and follow only uniquely matched, enabled Git submodules. */
export async function scanProjectWorkspace(input: {
  rootIntegration: Integration;
  integrations: Integration[];
  pluginManager?: PluginManager | undefined;
  adminAuthSecret?: string | undefined;
  repoKey: string;
  cloneUrl: string;
  revision?: string | undefined;
}): Promise<ProjectWorkspaceScanResult> {
  interface ScanQueueItem {
    integration: Integration;
    repoKey: string;
    cloneUrl: string;
    revision?: string | undefined;
    localPathPrefix: string;
    depth: number;
  }

  const queue: ScanQueueItem[] = [{
    integration: input.rootIntegration,
    repoKey: input.repoKey,
    cloneUrl: input.cloneUrl,
    ...(input.revision !== undefined ? { revision: input.revision } : {}),
    localPathPrefix: "",
    depth: 0,
  }];
  const seen = new Set<string>();
  const manifestFiles = new Set<string>();
  const repositories: ProjectWorkspaceScanRepository[] = [];
  const diagnostics: WorkspaceManifestDiagnostic[] = [];

  while (queue.length > 0 && seen.size < MAX_SCANNED_REPOSITORIES) {
    const current = queue.shift()!;
    const identity = `${current.integration.id}\n${current.repoKey}\n${current.revision?.trim() || "HEAD"}`;
    if (seen.has(identity)) continue;
    seen.add(identity);

    let scan: IntegrationWorkspaceScanResult;
    try {
      scan = await scanIntegrationWorkspace({
        integration: current.integration,
        pluginManager: input.pluginManager,
        adminAuthSecret: input.adminAuthSecret,
        repoKey: current.repoKey,
        cloneUrl: current.cloneUrl,
        ...(current.revision !== undefined ? { revision: current.revision } : {}),
      });
    } catch (error) {
      if (current.depth === 0) throw error;
      diagnostics.push({
        sourcePath: current.localPathPrefix,
        severity: "warning",
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const prefixPath = (value: string): string => current.localPathPrefix
      ? path.posix.join(current.localPathPrefix, value)
      : value;
    for (const filePath of scan.manifestFiles) manifestFiles.add(prefixPath(filePath));
    diagnostics.push(...scan.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      sourcePath: prefixPath(diagnostic.sourcePath),
    })));

    const adjusted = scan.repositories.map((repository) => ({
      ...repository,
      localPath: prefixPath(repository.localPath),
      sourcePath: prefixPath(repository.sourcePath),
    }));
    const resolvable = adjusted.filter((repository) => repository.cloneUrl !== null);
    const resolutions = resolveRepositoryBindings(
      resolvable.map((repository) => ({ cloneUrl: repository.cloneUrl!, localPath: repository.localPath })),
      input.integrations,
    );
    let resolutionIndex = 0;
    for (const repository of adjusted) {
      const resolution = repository.cloneUrl === null ? null : resolutions[resolutionIndex++] ?? null;
      repositories.push({
        ...repository,
        resolution,
        origin: classifyRepositoryOrigin(repository.cloneUrl, resolution),
      });
      if (
        repository.relation !== "gitlink"
        || current.depth >= MAX_RECURSIVE_SCAN_DEPTH
        || resolution?.status !== "matched"
        || !resolution.match.enabled
        || repository.cloneUrl === null
      ) continue;
      const integration = input.integrations.find((candidate) => candidate.id === resolution.match.integrationId);
      if (!integration) continue;
      queue.push({
        integration,
        repoKey: resolution.match.repoKey,
        cloneUrl: repository.cloneUrl,
        ...(repository.revision !== null ? { revision: repository.revision } : {}),
        localPathPrefix: repository.localPath,
        depth: current.depth + 1,
      });
    }
  }

  if (queue.length > 0) {
    diagnostics.push({
      sourcePath: "workspace",
      severity: "warning",
      message: `Recursive scan stopped after ${MAX_SCANNED_REPOSITORIES} repositories.`,
    });
  }
  return { manifestFiles: [...manifestFiles], repositories, diagnostics };
}