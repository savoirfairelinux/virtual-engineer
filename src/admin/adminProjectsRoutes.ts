import { getLogger } from "../logger.js";
import { writeJson, readBody, zodErrorBody, requireStore } from "./adminRouteUtils.js";
import { makeAgentId, makeProjectId, type AgentRecord, type ProjectRecord } from "../interfaces.js";
import type { Router } from "./router.js";
import { getEffectivePermissions } from "./authContext.js";
import { accessibleResourceIds, ALL_RESOURCES } from "./authorization/policyEngine.js";
import { validateSkillSourcesConnection } from "./skillSourceDiscovery.js";
import { registerProjectWorkspaceRoutes } from "./adminProjectWorkspaceRoutes.js";
import { registerProjectVendorComponentsRoutes } from "./adminProjectVendorComponentsRoutes.js";
import {
  recordAudit,
  relaunchFailedTasksForProject,
  loadIntegrationsLookup,
  buildProjectSummary,
  buildProjectDetail,
  validateAgentOverrideJson,
  validatePushTargetCloneUrls,
  validatePushTargetReviewerEmails,
  validateSkillSourcesForSave,
  validateProjectAgent,
  skillSourcesForCreate,
  normalizeSkillSources,
  toVendorComponentInputs,
  isUniqueConflict,
  projectCreateSchema,
  projectUpdateSchema,
  type ProjectsRouteDeps,
  type ProjectsRouteStore,
  type ProjectSummary,
  type ProjectDetail,
  type SkillSource,
} from "./adminProjectsShared.js";

const log = getLogger("admin-projects");

export type { ProjectsRouteDeps, ProjectsRouteStore, SkillSource, ProjectSummary, ProjectDetail };

/** Register project routes on the given router. */
export function registerProjectRoutes(router: Router, deps: ProjectsRouteDeps): void {
  const skillSourceConnectionValidator = deps.validateSkillSourcesConnection ?? validateSkillSourcesConnection;

  registerProjectWorkspaceRoutes(router, deps);
  registerProjectVendorComponentsRoutes(router, deps);

  router.add("GET", "/api/admin/projects", async (req, res, _params) => {
    if (!requireStore(deps.projectStore, res, "Project store not available")) return;
    const store = deps.projectStore;
    const projects = await store.listProjects();
    const integrations = await loadIntegrationsLookup(deps.integrationStore);
    const agentsById = new Map<string, AgentRecord>();
    const summaries: ProjectSummary[] = [];
    for (const p of projects) {
      summaries.push(await buildProjectSummary(p, store, integrations, agentsById));
    }
    // Scope-filter: a non-superuser sees only projects they may read.
    const perms = getEffectivePermissions(req);
    let visible = summaries;
    if (perms) {
      const scope = accessibleResourceIds(perms, "project.read");
      if (scope === null) visible = [];
      else if (scope !== ALL_RESOURCES) visible = summaries.filter((s) => scope.has(s.id));
    }
    writeJson(res, 200, { projects: visible });
  }, { permission: "project.read", collection: true });

  router.add("POST", "/api/admin/projects", async (req, res, _params) => {
    if (!requireStore(deps.projectStore, res, "Project store not available")) return;
    const store = deps.projectStore;
    const body = await readBody(req);
    if (!body) { writeJson(res, 400, { error: "Request body required" }); return; }
    const parsed = projectCreateSchema.safeParse(body);
    if (!parsed.success) { writeJson(res, 400, zodErrorBody(parsed.error, "Invalid project payload")); return; }
    const data = parsed.data;
    const agent = await store.getAgentById(makeAgentId(data.agentId));
    const agentError = await validateProjectAgent(agent, data.type, deps.integrationStore, data.agentId);
    if (agentError) { writeJson(res, 400, { error: agentError }); return; }
    if (!agent) { writeJson(res, 400, { error: `Agent not found: ${data.agentId}` }); return; }
    if (data.agentOverrideJson !== undefined) {
      const overrideError = await validateAgentOverrideJson(store, data.agentOverrideJson, agent);
      if (overrideError) { writeJson(res, 400, { error: overrideError }); return; }
    }
    if (data.type === "coding") {
      const conflict = await store.findProjectByTicketSource(data.ticketSource.integrationId, data.ticketSource.ticketProjectKey);
      if (conflict) {
        writeJson(res, 409, {
          error: "Conflict",
          message: `Ticket source (${data.ticketSource.integrationId}, ${data.ticketSource.ticketProjectKey}) is already claimed by project '${conflict.name}' (${conflict.id})`,
          conflictingProjectId: conflict.id, conflictingProjectName: conflict.name,
        }); return;
      }
    }
    let project: ProjectRecord;
    const skillSources = skillSourcesForCreate(data.skillSources);
    try {
      await validateSkillSourcesForSave(skillSources, skillSourceConnectionValidator);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      writeJson(res, 400, { error: msg }); return;
    }
    try {
      project = await store.createProject({
        ...(data.id !== undefined ? { id: data.id } : {}),
        name: data.name, type: data.type,
        agentId: makeAgentId(data.agentId),
        ...(data.agentOverrideJson !== undefined ? { agentOverrideJson: data.agentOverrideJson } : {}),
        ...(data.postCloneScript !== undefined ? { postCloneScript: data.postCloneScript } : {}),
        skillSourcesJson: JSON.stringify(skillSources),
        ...(data.gerritTopicOverride !== undefined ? { gerritTopicOverride: data.gerritTopicOverride } : {}),
        ...(data.useFullTicketUrlInCommits !== undefined ? { useFullTicketUrlInCommits: data.useFullTicketUrlInCommits } : {}),
        ...(data.postReviewLinkToTicket !== undefined ? { postReviewLinkToTicket: data.postReviewLinkToTicket } : {}),
        ...(data.reactToCiFailures !== undefined ? { reactToCiFailures: data.reactToCiFailures } : {}),
        ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err }, "create project failed");
      writeJson(res, 500, { error: msg }); return;
    }
    try {
      if (data.type === "coding") {
        const cloneUrlError = await validatePushTargetCloneUrls(data.pushTargets, deps.integrationStore);
        if (cloneUrlError) {
          try { await store.deleteProject(project.id); } catch { /* ignore */ }
          writeJson(res, 400, { error: cloneUrlError });
          return;
        }
        const reviewerEmailError = await validatePushTargetReviewerEmails(data.pushTargets, deps.integrationStore);
        if (reviewerEmailError) {
          try { await store.deleteProject(project.id); } catch { /* ignore */ }
          writeJson(res, 400, { error: reviewerEmailError });
          return;
        }
        await store.setProjectTicketSource(project.id, data.ticketSource);
        await store.replaceProjectPushTargets(project.id, data.pushTargets);
        if (data.vendorComponents !== undefined) {
          await store.replaceProjectVendorComponents(project.id, toVendorComponentInputs(data.vendorComponents));
        }
      } else {
        await store.setProjectReviewConfig(project.id, data.reviewConfig.integrationId, data.reviewConfig.repoKeys);
      }
    } catch (err: unknown) {
      try { await store.deleteProject(project.id); } catch { /* ignore */ }
      const msg = err instanceof Error ? err.message : String(err);
      const status = isUniqueConflict(err) ? 409 : 500;
      log.warn({ err, projectId: project.id }, "attach project children failed");
      writeJson(res, status, { error: status === 409 ? "Conflict" : "Failed to create project", message: msg }); return;
    }
    const integrations = await loadIntegrationsLookup(deps.integrationStore);
    const detail = await buildProjectDetail(project, store, integrations);
    recordAudit(deps.auditStore, req, {
      action: "project.create",
      targetType: "project",
      targetId: project.id,
      details: {
        name: project.name,
        type: project.type,
        agentId: project.agentId,
        ...(data.type === "coding"
          ? { ticketProjectKey: data.ticketSource.ticketProjectKey, repoKeys: data.pushTargets.map((t) => t.repoKey) }
          : { repoKeys: data.reviewConfig.repoKeys }),
      },
    });
    log.info(
      {
        projectId: project.id,
        name: project.name,
        type: project.type,
        agentId: project.agentId,
      },
      "project created"
    );
    writeJson(res, 201, { project: detail });
    deps.onProjectChange?.();
    if (project.enabled) {
      await relaunchFailedTasksForProject(store, project.id, deps.taskControl);
    }
  }, { permission: "project.write" });

  // Enable or disable a project by id.
  router.add("PATCH", "/api/admin/projects/:id/enable", async (req, res, params) => {
    if (!requireStore(deps.projectStore, res, "Project store not available")) return;
    const store = deps.projectStore;
    const id = makeProjectId(params["id"] ?? "");
    const existing = await store.getProjectById(id);
    if (!existing) { writeJson(res, 404, { error: "Project not found" }); return; }
    await store.setProjectEnabled(id, true);
    recordAudit(deps.auditStore, req, { action: "project.enable", targetType: "project", targetId: id, details: { name: existing.name } });
    res.statusCode = 204; res.end();
    deps.onProjectChange?.();
    if (existing.enabled === false) {
      await relaunchFailedTasksForProject(store, id, deps.taskControl);
    }
  }, { permission: "project.operate", resourceParam: "id" });

  router.add("PATCH", "/api/admin/projects/:id/disable", async (req, res, params) => {
    if (!requireStore(deps.projectStore, res, "Project store not available")) return;
    const store = deps.projectStore;
    const id = makeProjectId(params["id"] ?? "");
    const existing = await store.getProjectById(id);
    if (!existing) { writeJson(res, 404, { error: "Project not found" }); return; }
    await store.setProjectEnabled(id, false);
    recordAudit(deps.auditStore, req, { action: "project.disable", targetType: "project", targetId: id, details: { name: existing.name } });
    res.statusCode = 204; res.end();
    deps.onProjectChange?.();
  }, { permission: "project.operate", resourceParam: "id" });

  router.add("GET", "/api/admin/projects/:id", async (_req, res, params) => {
    if (!requireStore(deps.projectStore, res, "Project store not available")) return;
    const store = deps.projectStore;
    const id = makeProjectId(params["id"] ?? "");
    const existing = await store.getProjectById(id);
    if (!existing) { writeJson(res, 404, { error: "Project not found" }); return; }
    const integrations = await loadIntegrationsLookup(deps.integrationStore);
    const detail = await buildProjectDetail(existing, store, integrations);
    writeJson(res, 200, { project: detail });
  }, { permission: "project.read", resourceParam: "id" });

  router.add("PUT", "/api/admin/projects/:id", async (req, res, params) => {
    if (!requireStore(deps.projectStore, res, "Project store not available")) return;
    const store = deps.projectStore;
    const id = makeProjectId(params["id"] ?? "");
    const existing = await store.getProjectById(id);
    if (!existing) { writeJson(res, 404, { error: "Project not found" }); return; }
    const body = await readBody(req);
    if (!body) { writeJson(res, 400, { error: "Request body required" }); return; }
    const parsed = projectUpdateSchema.safeParse(body);
    if (!parsed.success) { writeJson(res, 400, zodErrorBody(parsed.error, "Invalid project payload")); return; }
    const data = parsed.data;
    let prospectiveAgent: AgentRecord | null = null;
    if (data.agentId !== undefined) {
      const agent = await store.getAgentById(makeAgentId(data.agentId));
      const agentError = await validateProjectAgent(agent, existing.type, deps.integrationStore, data.agentId);
      if (agentError) { writeJson(res, 400, { error: agentError }); return; }
      prospectiveAgent = agent;
    }
    if (data.agentOverrideJson !== undefined) {
      prospectiveAgent ??= await store.getAgentById(existing.agentId);
      if (!prospectiveAgent) { writeJson(res, 400, { error: `Agent not found: ${existing.agentId}` }); return; }
      const overrideError = await validateAgentOverrideJson(store, data.agentOverrideJson, prospectiveAgent);
      if (overrideError) { writeJson(res, 400, { error: overrideError }); return; }
    }
    if (data.ticketSource !== undefined && existing.type !== "coding") {
      writeJson(res, 400, { error: "ticketSource only valid for coding projects" }); return;
    }
    if (data.pushTargets !== undefined) {
      if (existing.type !== "coding") { writeJson(res, 400, { error: "pushTargets only valid for coding projects" }); return; }
      const cloneUrlError = await validatePushTargetCloneUrls(data.pushTargets, deps.integrationStore);
      if (cloneUrlError) { writeJson(res, 400, { error: cloneUrlError }); return; }
      const reviewerEmailError = await validatePushTargetReviewerEmails(data.pushTargets, deps.integrationStore);
      if (reviewerEmailError) { writeJson(res, 400, { error: reviewerEmailError }); return; }
    }
    if (data.reviewConfig !== undefined && existing.type !== "review") {
      writeJson(res, 400, { error: "reviewConfig only valid for review projects" }); return;
    }
    const updates: Parameters<ProjectsRouteStore["updateProject"]>[1] = {};
    if (data.name !== undefined) updates.name = data.name;
    if (data.agentId !== undefined) updates.agentId = makeAgentId(data.agentId);
    if (data.agentOverrideJson !== undefined) updates.agentOverrideJson = data.agentOverrideJson;
    if (data.postCloneScript !== undefined) updates.postCloneScript = data.postCloneScript;
    if (data.skillSources !== undefined) {
      const skillSources = normalizeSkillSources(data.skillSources);
      try {
        await validateSkillSourcesForSave(skillSources, skillSourceConnectionValidator);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        writeJson(res, 400, { error: msg }); return;
      }
      updates.skillSourcesJson = JSON.stringify(skillSources);
    }
    if (data.gerritTopicOverride !== undefined) updates.gerritTopicOverride = data.gerritTopicOverride;
    if (data.useFullTicketUrlInCommits !== undefined) updates.useFullTicketUrlInCommits = data.useFullTicketUrlInCommits;
    if (data.postReviewLinkToTicket !== undefined) updates.postReviewLinkToTicket = data.postReviewLinkToTicket;
    if (data.reactToCiFailures !== undefined) updates.reactToCiFailures = data.reactToCiFailures;
    if (data.enabled !== undefined) updates.enabled = data.enabled;
    const reconfigured =
      data.ticketSource !== undefined ||
      data.pushTargets !== undefined ||
      data.reviewConfig !== undefined ||
      updates.agentId !== undefined ||
      updates.agentOverrideJson !== undefined ||
      updates.postCloneScript !== undefined ||
      updates.skillSourcesJson !== undefined ||
      (updates.enabled === true && existing.enabled !== true);
    try {
      await store.updateProjectConfiguration(id, {
        project: updates,
        ...(data.ticketSource !== undefined ? { ticketSource: data.ticketSource } : {}),
        ...(data.pushTargets !== undefined ? { pushTargets: data.pushTargets } : {}),
        ...(data.reviewConfig !== undefined ? { reviewConfig: data.reviewConfig } : {}),
      });
    } catch (err: unknown) {
      const status = isUniqueConflict(err) || (err as { code?: unknown }).code === "ACTIVE_TASKS" ? 409 : 500;
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err, id }, "update project children failed");
      writeJson(res, status, { error: status === 409 ? "Conflict" : "Update failed", message: msg }); return;
    }
    const refreshed = await store.getProjectById(id);
    if (!refreshed) { writeJson(res, 500, { error: "Project disappeared after update" }); return; }
    const integrations = await loadIntegrationsLookup(deps.integrationStore);
    const detail = await buildProjectDetail(refreshed, store, integrations);
    recordAudit(deps.auditStore, req, { action: "project.update", targetType: "project", targetId: id, details: { name: refreshed.name } });
    if (data.ticketSource !== undefined) {
      recordAudit(deps.auditStore, req, { action: "project.ticket_source_set", targetType: "project", targetId: id, details: { integrationId: data.ticketSource.integrationId, ticketProjectKey: data.ticketSource.ticketProjectKey } });
    }
    if (data.pushTargets !== undefined) {
      recordAudit(deps.auditStore, req, { action: "project.push_targets_set", targetType: "project", targetId: id, details: { repoKeys: data.pushTargets.map((t) => t.repoKey) } });
    }
    if (data.agentId !== undefined) {
      recordAudit(deps.auditStore, req, { action: "project.agent_assign", targetType: "project", targetId: id, details: { agentId: data.agentId } });
    }
    writeJson(res, 200, { project: detail });
    deps.onProjectChange?.();
    if (reconfigured) {
      await relaunchFailedTasksForProject(store, id, deps.taskControl);
    }
  }, { permission: "project.write", resourceParam: "id" });

  router.add("DELETE", "/api/admin/projects/:id", async (req, res, params) => {
    if (!requireStore(deps.projectStore, res, "Project store not available")) return;
    const store = deps.projectStore;
    const id = makeProjectId(params["id"] ?? "");
    const existing = await store.getProjectById(id);
    if (!existing) { writeJson(res, 404, { error: "Project not found" }); return; }
    try {
      if (deps.taskControl?.deleteProject !== undefined) {
        await deps.taskControl.deleteProject(id);
      } else {
        await store.deleteProject(id);
      }
      recordAudit(deps.auditStore, req, { action: "project.delete", targetType: "project", targetId: id, details: { name: existing.name, type: existing.type } });
      res.statusCode = 204; res.end();
      deps.onProjectChange?.();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err, id }, "delete project failed");
      writeJson(res, 500, { error: msg });
    }
  }, { permission: "project.delete", resourceParam: "id" });
}

