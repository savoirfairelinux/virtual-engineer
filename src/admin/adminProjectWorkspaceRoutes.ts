import { getLogger } from "../logger.js";
import { writeJson, readBody, zodErrorBody } from "./adminRouteUtils.js";
import type { Router } from "./router.js";
import { listSkillSourceSkills } from "./skillSourceDiscovery.js";
import { resolveRepositoryBindings } from "../workspace/integrationBindingResolver.js";
import { scanProjectWorkspace, WorkspaceScanError } from "../workspace/workspaceScanService.js";
import {
  isSkillSourceAuthError,
  recordAudit,
  repositoryBindingResolutionSchema,
  pushTargetScanSchema,
  skillSourceDiscoverySchema,
  type ProjectsRouteDeps,
} from "./adminProjectsShared.js";

const log = getLogger("admin-projects");

/**
 * Register project "workspace" discovery routes: skill-source listing,
 * repository-binding resolution, and push-target workspace scanning.
 * These support the project create/edit form but do not touch project
 * records themselves.
 */
export function registerProjectWorkspaceRoutes(router: Router, deps: ProjectsRouteDeps): void {
  const handleSkillSourceList: Parameters<Router["add"]>[2] = async (req, res, _params) => {
    const body = await readBody(req);
    if (!body) { writeJson(res, 400, { error: "Request body required" }); return; }
    const parsed = skillSourceDiscoverySchema.safeParse(body);
    if (!parsed.success) { writeJson(res, 400, zodErrorBody(parsed.error, "Invalid skill source payload")); return; }
    try {
      const source = {
        source: parsed.data.source,
        ...(parsed.data.sshUser !== undefined ? { sshUser: parsed.data.sshUser } : {}),
        ...(parsed.data.sshPort !== undefined ? { sshPort: parsed.data.sshPort } : {}),
        ...(parsed.data.sshKeyPath !== undefined ? { sshKeyPath: parsed.data.sshKeyPath } : {}),
        ...(parsed.data.sshKnownHostsPath !== undefined ? { sshKnownHostsPath: parsed.data.sshKnownHostsPath } : {}),
      };
      const result = await listSkillSourceSkills(source);
      writeJson(res, 200, result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      writeJson(res, isSkillSourceAuthError(message) ? 400 : 502, { error: `Failed to list skills: ${message}` });
    }
  };

  router.add("POST", "/api/admin/projects/:id/skill-sources/list", handleSkillSourceList, { permission: "project.write", resourceParam: "id" });
  router.add("POST", "/api/admin/projects/skill-sources/list", handleSkillSourceList, { permission: "project.write" });

  router.add("POST", "/api/admin/projects/resolve-repositories", async (req, res, _params) => {
    if (!deps.integrationStore) { writeJson(res, 501, { error: "Integration store not available" }); return; }
    const body = await readBody(req);
    if (!body) { writeJson(res, 400, { error: "Request body required" }); return; }
    const parsed = repositoryBindingResolutionSchema.safeParse(body);
    if (!parsed.success) {
      writeJson(res, 400, zodErrorBody(parsed.error, "Invalid repository resolution payload"));
      return;
    }
    const integrations = await deps.integrationStore.getIntegrations();
    writeJson(res, 200, {
      repositories: resolveRepositoryBindings(parsed.data.repositories, integrations),
    });
  }, { permission: "integration.read" });

  router.add("POST", "/api/admin/projects/scan-push-targets", async (req, res, _params) => {
    if (!deps.integrationStore) { writeJson(res, 501, { error: "Integration store not available" }); return; }
    const body = await readBody(req);
    if (!body) { writeJson(res, 400, { error: "Request body required" }); return; }
    const parsed = pushTargetScanSchema.safeParse(body);
    if (!parsed.success) {
      writeJson(res, 400, zodErrorBody(parsed.error, "Invalid workspace scan payload"));
      return;
    }
    const integration = await deps.integrationStore.getIntegration(parsed.data.integrationId);
    if (!integration) { writeJson(res, 404, { error: "Integration not found" }); return; }
    try {
      const integrations = await deps.integrationStore.getIntegrations();
      const scan = await scanProjectWorkspace({
        rootIntegration: integration,
        integrations,
        pluginManager: deps.pluginManager,
        adminAuthSecret: deps.adminAuthSecret,
        repoKey: parsed.data.repoKey,
        cloneUrl: parsed.data.cloneUrl,
        revision: parsed.data.revision,
      });
      recordAudit(deps.auditStore, req, {
        action: "project.push_targets_scan",
        targetType: "integration",
        targetId: integration.id,
        details: {
          repoKey: parsed.data.repoKey,
          manifestCount: scan.manifestFiles.length,
          repositoryCount: scan.repositories.length,
          matchedCount: scan.repositories.filter((repository) => repository.resolution?.status === "matched" && repository.resolution.match.enabled).length,
        },
      });
      writeJson(res, 200, {
        manifestFiles: scan.manifestFiles,
        repositories: scan.repositories,
        diagnostics: scan.diagnostics,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.warn({ integrationId: parsed.data.integrationId, repoKey: parsed.data.repoKey, errorMessage }, "push-target workspace scan failed");
      writeJson(res, error instanceof WorkspaceScanError ? error.statusCode : 502, { error: errorMessage });
    }
  }, { permission: "integration.read" });
}
