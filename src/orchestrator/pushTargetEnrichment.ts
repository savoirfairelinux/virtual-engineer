import type {
  Integration,
  IntegrationBindingContext,
  ProjectPushTargetRecord,
} from "../interfaces.js";
import type { VcsConnector } from "../vcs/vcsConnector.js";

/** Integration types that clone via HTTPS and need a token injected into the clone URL. */
const HTTPS_VCS_TYPES = new Set(["github", "gitlab"]);

/**
 * Build an authenticated HTTPS clone URL for GitHub/GitLab push targets so the
 * agent container can run `git clone` without interactive credential prompts.
 * Returns undefined for non-HTTPS integrations (Gerrit) or on any error.
 */
export function buildAuthenticatedCloneUrlFromPlaintextToken(
  rawCloneUrl: string,
  integrationType: string,
  plaintextToken: unknown,
): string | undefined {
  if (!HTTPS_VCS_TYPES.has(integrationType)) return undefined;
  if (typeof plaintextToken !== "string" || !plaintextToken) return undefined;
  if (/^\*{4,}$/.test(plaintextToken)) return undefined;
  const usernamePrefix = integrationType === "github" ? "x-access-token" : "oauth2";
  try {
    const normalised = rawCloneUrl.startsWith("git@")
      ? rawCloneUrl.replace(/^git@([^:]+):(.+?)(?:\.git)?$/, "https://$1/$2.git")
      : rawCloneUrl;
    const parsed = new URL(normalised);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    parsed.username = usernamePrefix;
    parsed.password = plaintextToken;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

/**
 * Resolve the strict SSH known-hosts path for the clone step from the root
 * push target's VCS connector. Returns undefined (non-fatal — clone proceeds
 * without strict host key checking) if the connector can't be resolved.
 */
export async function resolveCloneKnownHostsPath(
  root: ProjectPushTargetRecord,
  resolveVcsConnectorForTarget: (integrationId: string, context?: IntegrationBindingContext) => Promise<VcsConnector>,
): Promise<string | undefined> {
  try {
    const connector = await resolveVcsConnectorForTarget(root.integrationId, {
      repoKey: root.repoKey,
      targetBranch: root.targetBranch,
    });
    return connector.sshKnownHostsPath ?? undefined;
  } catch {
    return undefined;
  }
}

/** Dependencies needed to enrich push targets with authenticated clone URLs and SSH key material. */
export interface PushTargetEnrichmentDeps {
  getIntegration: (integrationId: string) => Promise<Integration | null>;
  resolveIntegrationConfig: (integration: Integration) => Record<string, unknown>;
  resolveVcsConnectorForTarget: (integrationId: string, context?: IntegrationBindingContext) => Promise<VcsConnector>;
}

/**
 * Enrich each push target with an authenticated HTTPS clone URL for
 * GitHub/GitLab targets, and fall back to its linked VCS connector's SSH key
 * (or agent public-key path) plus strict known-hosts path when the target
 * itself has no configured SSH key. Both enrichment steps are non-fatal —
 * failures fall through to the target's existing configuration.
 */
export async function enrichPushTargets(
  pushTargets: ProjectPushTargetRecord[],
  deps: PushTargetEnrichmentDeps,
): Promise<ProjectPushTargetRecord[]> {
  return Promise.all(
    pushTargets.map(async (pt) => {
      let enrichedTarget = pt;
      try {
        // Inject authenticated HTTPS clone URL for GitHub/GitLab targets
        const integration = await deps.getIntegration(pt.integrationId);
        if (integration) {
          const cfg = deps.resolveIntegrationConfig(integration);
          const authUrl = buildAuthenticatedCloneUrlFromPlaintextToken(pt.cloneUrl, integration.provider, cfg["token"]);
          if (authUrl !== undefined) enrichedTarget = { ...enrichedTarget, cloneUrl: authUrl };
        }
      } catch {
        // Non-fatal — fall through to SSH key enrichment
      }
      try {
        const connector = await deps.resolveVcsConnectorForTarget(pt.integrationId, { repoKey: pt.repoKey, targetBranch: pt.targetBranch });
        const fallbackKey = connector.sshKeyPath ?? undefined;
        const fallbackAgentPub = (connector as { sshAgentPubKeyPath?: string | undefined }).sshAgentPubKeyPath ?? undefined;
        const knownHostsPath = connector.sshKnownHostsPath ?? undefined;
        if (pt.sshKeyPath === null && fallbackKey !== undefined) {
          enrichedTarget = { ...enrichedTarget, sshKeyPath: fallbackKey };
        } else if (pt.sshKeyPath === null && fallbackAgentPub !== undefined) {
          enrichedTarget = { ...enrichedTarget, sshKeyPath: null, sshAgentPubKeyPath: fallbackAgentPub };
        }
        return {
          ...enrichedTarget,
          ...(knownHostsPath !== undefined ? { sshKnownHostsPath: knownHostsPath } : {}),
        };
      } catch {
        return enrichedTarget;
      }
    })
  );
}
