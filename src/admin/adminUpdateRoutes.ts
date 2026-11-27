import type { IncomingMessage } from "node:http";
import { getLogger } from "../logger.js";
import type { ReleaseChecker, ReleaseInfo } from "../runtime/releaseCheck.js";
import {
  compareReleaseVersions,
  isReleaseVersion,
  isUpdateInProgress,
  type UpdateHandshakeStore,
  type UpdateRequest,
  type UpdateStatus,
} from "../runtime/updateHandshake.js";
import type { BuildInfo } from "../version.js";
import { recordAudit, type AuditCapableStore } from "./adminAudit.js";
import { getAuthContext } from "./authContext.js";
import { readBody, writeJson } from "./adminRouteUtils.js";
import type { Router } from "./router.js";

const log = getLogger("admin-updates");

export interface UpdateOverview {
  current: BuildInfo;
  latest: ReleaseInfo | null;
  latestError: string | null;
  checkedAt: number;
  updateAvailable: boolean;
  updaterInstalled: boolean;
  request: UpdateRequest | null;
  status: UpdateStatus | null;
  inProgress: boolean;
}

export interface UpdateRouteDeps {
  updates?: { handshake: UpdateHandshakeStore; releases: ReleaseChecker } | undefined;
  buildInfo: () => BuildInfo;
  auditStore?: AuditCapableStore | undefined;
  now?: () => number;
}

/**
 * Release updates from System settings. The orchestrator cannot replace its
 * own container, so starting an update only records a request that the host
 * updater service (`scripts/update.sh --install-service`) carries out.
 */
export function registerUpdateRoutes(router: Router, deps: UpdateRouteDeps): void {
  const now = deps.now ?? Date.now;

  async function overview(
    updates: NonNullable<UpdateRouteDeps["updates"]>,
    refresh: boolean,
  ): Promise<UpdateOverview> {
    const current = deps.buildInfo();
    const [latest, request, status, updaterInstalled] = await Promise.all([
      updates.releases.latest({ refresh }),
      updates.handshake.readRequest(),
      updates.handshake.readStatus(),
      updates.handshake.isUpdaterInstalled(),
    ]);
    const currentIsRelease = isReleaseVersion(current.version);
    return {
      current,
      latest: latest.release,
      latestError: latest.error,
      checkedAt: latest.checkedAt,
      updateAvailable: latest.release !== null
        && (!currentIsRelease || compareReleaseVersions(latest.release.version, current.version) > 0),
      updaterInstalled,
      request: request ?? null,
      status: status ?? null,
      inProgress: isUpdateInProgress(request, status, Math.floor(now() / 1000)),
    };
  }

  router.add("GET", "/api/admin/system/update", async (req: IncomingMessage, res, _params) => {
    if (!deps.updates) {
      writeJson(res, 404, { error: "Updates are managed outside this deployment" });
      return;
    }
    const refresh = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("refresh") === "1";
    writeJson(res, 200, await overview(deps.updates, refresh));
  }, { permission: "system.read" });

  router.add("POST", "/api/admin/system/update", async (req: IncomingMessage, res, _params) => {
    const updates = deps.updates;
    if (!updates) {
      writeJson(res, 404, { error: "Updates are managed outside this deployment" });
      return;
    }
    const body = await readBody(req);
    const version = body?.["version"];
    if (!isReleaseVersion(version)) {
      writeJson(res, 400, { error: "version must be a release version such as 1.2.3" });
      return;
    }
    const state = await overview(updates, false);
    if (!state.updaterInstalled) {
      writeJson(res, 409, { error: "The host updater service is not installed. Run ./scripts/update.sh --install-service on the host." });
      return;
    }
    if (state.inProgress) {
      writeJson(res, 409, { error: "An update is already in progress." });
      return;
    }
    if (state.latest?.version !== version || !state.updateAvailable) {
      writeJson(res, 409, { error: `Only the latest release newer than the running version can be installed; v${version} is not.` });
      return;
    }

    const requestedBy = getAuthContext(req)?.username ?? "unknown";
    const request = await updates.handshake.writeRequest({ version, requestedBy, nowSeconds: now() / 1000 });
    log.info({ version, requestedBy: request.requestedBy }, "release update requested");
    recordAudit(deps.auditStore, req, {
      action: "system.update_requested",
      targetType: "system",
      targetId: version,
      details: { from: deps.buildInfo().version, to: version },
    });
    writeJson(res, 202, await overview(updates, false));
  }, { permission: "system.write" });
}
