import type { DiscoveredRepository, Integration } from "../interfaces.js";
import { getProviderDescriptor, getProviderDomainCapabilities } from "../plugins/registry.js";

interface CanonicalRepositoryUrl {
  host: string;
  port: string | null;
  path: string;
}

export interface RepositoryBindingCandidate {
  integrationId: string;
  integrationName: string;
  provider: Integration["provider"];
  repoKey: string;
  enabled: boolean;
}

export interface RepositoryBindingInput {
  cloneUrl: string;
  localPath?: string | undefined;
}

export type RepositoryBindingResolution =
  | (RepositoryBindingInput & {
      status: "matched";
      match: RepositoryBindingCandidate;
      candidates: [];
    })
  | (RepositoryBindingInput & {
      status: "ambiguous";
      match: null;
      candidates: RepositoryBindingCandidate[];
    })
  | (RepositoryBindingInput & {
      status: "unmatched";
      match: null;
      candidates: [];
    });

function normalizeRepositoryPath(path: string): string | null {
  const normalized = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  return normalized.length > 0 ? normalized : null;
}

/** Normalize HTTP(S), SSH, Git, and SCP-style clone URLs for identity matching. */
export function canonicalizeRepositoryUrl(cloneUrl: string): CanonicalRepositoryUrl | null {
  const value = cloneUrl.trim();
  if (value.length === 0) return null;

  if (!value.includes("://")) {
    const scpMatch = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(value);
    if (!scpMatch) return null;
    const host = scpMatch[1]?.toLowerCase();
    const path = normalizeRepositoryPath(scpMatch[2] ?? "");
    return host && path ? { host, port: null, path } : null;
  }

  try {
    const parsed = new URL(value);
    if (!new Set(["http:", "https:", "ssh:", "git:"]).has(parsed.protocol)) return null;
    const path = normalizeRepositoryPath(parsed.pathname);
    if (!parsed.hostname || !path) return null;
    return {
      host: parsed.hostname.toLowerCase(),
      port: parsed.port || null,
      path,
    };
  } catch {
    return null;
  }
}

function sameRepositoryUrl(left: CanonicalRepositoryUrl, right: CanonicalRepositoryUrl): boolean {
  if (left.host !== right.host || left.path !== right.path) return false;
  return left.port === right.port || left.port === null || right.port === null;
}

function parseDiscoveredRepositories(integration: Integration): DiscoveredRepository[] {
  if (!integration.discoveredResourcesJson) return [];
  try {
    const parsed: unknown = JSON.parse(integration.discoveredResourcesJson);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const repositories = (parsed as Record<string, unknown>)["repositories"];
    if (!Array.isArray(repositories)) return [];
    return repositories.flatMap((repository): DiscoveredRepository[] => {
      if (repository === null || typeof repository !== "object" || Array.isArray(repository)) return [];
      const value = repository as Record<string, unknown>;
      if (typeof value["key"] !== "string" || typeof value["name"] !== "string") return [];
      return [{
        key: value["key"],
        name: value["name"],
        ...(typeof value["cloneUrlSsh"] === "string" ? { cloneUrlSsh: value["cloneUrlSsh"] } : {}),
        ...(typeof value["cloneUrlHttp"] === "string" ? { cloneUrlHttp: value["cloneUrlHttp"] } : {}),
      }];
    });
  } catch {
    return [];
  }
}

function supportsSourceControl(integration: Integration): boolean {
  const descriptor = getProviderDescriptor(integration.provider);
  if (descriptor !== undefined) {
    return getProviderDomainCapabilities(descriptor).includes("source_control");
  }
  return integration.provider === "github" || integration.provider === "gitlab" || integration.provider === "gerrit";
}

function candidatesForRepository(
  inputUrl: CanonicalRepositoryUrl,
  integrations: Integration[]
): RepositoryBindingCandidate[] {
  const candidates = new Map<string, RepositoryBindingCandidate>();
  for (const integration of integrations) {
    if (!supportsSourceControl(integration)) continue;
    for (const repository of parseDiscoveredRepositories(integration)) {
      const urls = [repository.cloneUrlHttp, repository.cloneUrlSsh]
        .filter((url): url is string => typeof url === "string")
        .map(canonicalizeRepositoryUrl)
        .filter((url): url is CanonicalRepositoryUrl => url !== null);
      if (!urls.some((url) => sameRepositoryUrl(inputUrl, url))) continue;
      const candidate: RepositoryBindingCandidate = {
        integrationId: integration.id,
        integrationName: integration.name,
        provider: integration.provider,
        repoKey: repository.key,
        enabled: integration.enabled,
      };
      candidates.set(`${integration.id}\n${repository.key}`, candidate);
    }
  }
  return [...candidates.values()].sort((left, right) =>
    left.integrationId.localeCompare(right.integrationId) || left.repoKey.localeCompare(right.repoKey)
  );
}

/** Resolve repository URLs against resources discovered by existing integrations. */
export function resolveRepositoryBindings(
  repositories: RepositoryBindingInput[],
  integrations: Integration[]
): RepositoryBindingResolution[] {
  return repositories.map((repository) => {
    const input = {
      cloneUrl: repository.cloneUrl,
      ...(repository.localPath !== undefined ? { localPath: repository.localPath } : {}),
    };
    const canonicalUrl = canonicalizeRepositoryUrl(repository.cloneUrl);
    if (!canonicalUrl) return { ...input, status: "unmatched", match: null, candidates: [] };
    const candidates = candidatesForRepository(canonicalUrl, integrations);
    if (candidates.length === 1) {
      return { ...input, status: "matched", match: candidates[0]!, candidates: [] };
    }
    if (candidates.length > 1) {
      return { ...input, status: "ambiguous", match: null, candidates };
    }
    return { ...input, status: "unmatched", match: null, candidates: [] };
  });
}