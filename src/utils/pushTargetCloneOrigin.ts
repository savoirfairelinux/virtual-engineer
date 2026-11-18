import type { Integration, ProjectPushTargetRecord } from "../interfaces.js";
import { GITLAB_COM_BASE_URL } from "../plugins/descriptors/gitlabOAuth.js";
import { resolveGitHubUrls } from "./githubAuth.js";
import { getGitLabBaseUrl } from "./gitlabAuth.js";

type CloneOriginCheck =
  | { kind: "other-provider" }
  | { kind: "trusted"; url: URL; username: "x-access-token" | "oauth2" }
  | { kind: "refused"; reason: string };

function configuredCloneBase(provider: "github" | "gitlab", config: Record<string, unknown>): string | undefined {
  const base = config["baseUrl"];
  if (provider === "gitlab") {
    if (base !== undefined) return getGitLabBaseUrl(config);
    return config["gitlabMode"] === "self-hosted" ? undefined : GITLAB_COM_BASE_URL;
  }
  const mode = config["mode"];
  if (mode === "github-enterprise") {
    return resolveGitHubUrls(mode, typeof base === "string" ? base : undefined).webBaseUrl;
  }
  if (mode === undefined || mode === "github.com") return resolveGitHubUrls("github.com").webBaseUrl;
  return undefined;
}

/** Check the stored configuration without resolving or inspecting its credentials. */
export function checkPushTargetCloneOrigin(
  target: Pick<ProjectPushTargetRecord, "repoKey" | "cloneUrl">,
  integration: Pick<Integration, "provider" | "configJson"> | null,
): CloneOriginCheck {
  if (!integration) {
    return { kind: "refused", reason: `Cannot verify the clone origin for push target "${target.repoKey}": integration unavailable` };
  }
  const { provider } = integration;
  if (provider !== "github" && provider !== "gitlab") return { kind: "other-provider" };

  try {
    const stored: unknown = JSON.parse(integration.configJson);
    if (stored && typeof stored === "object" && !Array.isArray(stored)) {
      const baseUrl = configuredCloneBase(provider, stored as Record<string, unknown>);
      const url = new URL(target.cloneUrl);
      if (baseUrl !== undefined && url.protocol === "https:" &&
          url.origin === new URL(baseUrl).origin && !url.username && !url.password) {
        return { kind: "trusted", url, username: provider === "github" ? "x-access-token" : "oauth2" };
      }
    }
  } catch {
    // Invalid metadata or URL: refuse without exposing its contents.
  }
  return {
    kind: "refused",
    reason: `Push target "${target.repoKey}" must use a clone URL without embedded credentials on the linked ${provider} integration's trusted HTTPS origin (scheme, host, and port)`,
  };
}
