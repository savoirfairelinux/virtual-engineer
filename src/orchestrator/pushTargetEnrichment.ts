import type {
  Integration,
  IntegrationBindingContext,
  ProjectPushTargetRecord,
} from "../interfaces.js";
import { checkPushTargetCloneOrigin } from "../utils/pushTargetCloneOrigin.js";
import type { VcsConnector } from "../vcs/vcsConnector.js";

export interface PushTargetEnrichmentDeps {
  getIntegration: (integrationId: string) => Promise<Integration | null>;
  resolveIntegrationConfig: (integration: Integration) => Record<string, unknown>;
  resolveVcsConnectorForTarget: (integrationId: string, context?: IntegrationBindingContext) => Promise<VcsConnector>;
}

type PushTargetEnrichment =
  | { ok: true; targets: ProjectPushTargetRecord[] }
  | { ok: false; reason: string };

/** Preflight every target before resolving any clone credentials or SSH connector. */
export async function enrichPushTargets(
  pushTargets: readonly ProjectPushTargetRecord[],
  deps: PushTargetEnrichmentDeps,
): Promise<PushTargetEnrichment> {
  const checkedTargets = await Promise.all(pushTargets.map(async (target) => {
    const integration = await deps.getIntegration(target.integrationId).catch(() => null);
    return { target, integration, check: checkPushTargetCloneOrigin(target, integration) };
  }));
  for (const { check } of checkedTargets) {
    if (check.kind === "refused") return { ok: false, reason: check.reason };
  }

  const targets = await Promise.all(checkedTargets.map(async ({ target, integration, check }) => {
    if (check.kind === "trusted" && integration) {
      const token = deps.resolveIntegrationConfig(integration)["token"];
      if (typeof token === "string" && token && !/^\*{4,}$/.test(token)) {
        check.url.username = check.username;
        check.url.password = token;
      }
      return { ...target, cloneUrl: check.url.toString() };
    }

    // SSH enrichment for other providers remains best-effort.
    try {
      const connector = await deps.resolveVcsConnectorForTarget(target.integrationId, {
        repoKey: target.repoKey, targetBranch: target.targetBranch,
      });
      const fallbackKey = connector.sshKeyPath ?? undefined;
      const fallbackAgentPub = "sshAgentPubKeyPath" in connector && typeof connector.sshAgentPubKeyPath === "string"
        ? connector.sshAgentPubKeyPath : undefined;
      const knownHostsPath = connector.sshKnownHostsPath ?? undefined;
      return {
        ...target,
        ...(target.sshKeyPath === null && fallbackKey !== undefined ? { sshKeyPath: fallbackKey } : {}),
        ...(target.sshKeyPath === null && fallbackKey === undefined && fallbackAgentPub !== undefined
          ? { sshAgentPubKeyPath: fallbackAgentPub } : {}),
        ...(knownHostsPath !== undefined ? { sshKnownHostsPath: knownHostsPath } : {}),
      };
    } catch {
      return target;
    }
  }));
  return { ok: true, targets };
}
