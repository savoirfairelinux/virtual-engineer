import { getLogger } from "../logger.js";
import { ActiveProjectTasksConfirmationRequiredError } from "../domain/projectConfiguration.js";
import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { writeJson, readBody, zodErrorBody, requireStore } from "./adminRouteUtils.js";
import { makeAgentId, makeProjectId, type AgentRecord, type Permission, type ProjectRecord } from "../interfaces.js";
import type { Router } from "./router.js";
import { getAuthContext, getEffectivePermissions, requestCanAccessResource } from "./authContext.js";
import { canAccessResource } from "./authorization/policyEngine.js";
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
  validateProjectReviewConfig,
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
  type IntegrationLookup,
  type SkillSource,
} from "./adminProjectsShared.js";

const log = getLogger("admin-projects");

const PROJECT_ACCESS_PERMISSIONS = [
  "project.delete",
  "project.operate",
  "project.owner",
  "project.read",
  "project.write",
  "task.delete",
  "task.operate",
  "task.read",
] as const;

const projectAccessSchema = z.object({
  permissions: z.array(z.enum(PROJECT_ACCESS_PERMISSIONS)).min(1),
});

function projectAccessPolicyId(projectId: string, groupId: string): string {
  return `project-access:${projectId}:group:${groupId}`;
}

function projectAccessPolicyPrefix(projectId: string): string {
  return `project-access:${projectId}:group:`;
}

function overridePromptIds(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const record = parsed as Record<string, unknown>;
    return ["systemPromptId", "instructionsPromptId", "feedbackInstructionsPromptId"]
      .map((field) => record[field])
      .filter((value): value is string => typeof value === "string" && value.length > 0);
  } catch {
    return [];
  }
}

async function findUnreadableProjectReference(
  req: IncomingMessage,
  store: ProjectsRouteStore,
  integrationStore: NonNullable<ProjectsRouteDeps["integrationStore"]>,
  input: {
    agent: AgentRecord | null;
    integrationIds: readonly string[];
    agentOverrideJson?: string | null;
  }
): Promise<Permission | null> {
  if (input.agent && !requestCanAccessResource(req, "agent.read", {
    type: "agent",
    id: input.agent.id,
    ownerUserId: input.agent.ownerUserId ?? null,
  })) return "agent.read";

  const integrationIds = new Set(input.integrationIds);
  if (input.agent?.integrationId) integrationIds.add(input.agent.integrationId);
  for (const integrationId of integrationIds) {
    const integration = await integrationStore.getIntegration(integrationId);
    if (integration && !requestCanAccessResource(req, "integration.read", {
      type: "integration",
      id: integration.id,
      ownerUserId: integration.ownerUserId ?? null,
    })) return "integration.read";
  }

  for (const promptId of overridePromptIds(input.agentOverrideJson)) {
    const prompt = await store.getPrompt(promptId);
    if (prompt && !requestCanAccessResource(req, "prompt.read", {
      type: "prompt",
      id: prompt.id,
      ownerUserId: prompt.ownerUserId ?? null,
    })) return "prompt.read";
  }
  return null;
}

function projectIntegrationIds(data: {
  ticketSource?: { integrationId: string } | undefined;
  pushTargets?: Array<{ integrationId: string }> | undefined;
  reviewConfig?: { integrationId: string } | undefined;
}): string[] {
  return [
    ...(data.ticketSource ? [data.ticketSource.integrationId] : []),
    ...(data.pushTargets?.map((target) => target.integrationId) ?? []),
    ...(data.reviewConfig ? [data.reviewConfig.integrationId] : []),
  ];
}

export type { ProjectsRouteDeps, ProjectsRouteStore, SkillSource, ProjectSummary, ProjectDetail };

/** Register project routes on the given router. */
export function registerProjectRoutes(router: Router, deps: ProjectsRouteDeps): void {
  const skillSourceConnectionValidator = deps.validateSkillSourcesConnection ?? validateSkillSourcesConnection;

  const readableIntegrationLookup = async (req: IncomingMessage): Promise<IntegrationLookup> => {
    const integrations = await loadIntegrationsLookup(deps.integrationStore);
    for (const [id, integration] of integrations.byId) {
      if (!requestCanAccessResource(req, "integration.read", {
        type: "integration",
        id,
        ownerUserId: integration.ownerUserId ?? null,
      })) integrations.byId.delete(id);
    }
    return integrations;
  };

  const canReadAgent = (req: IncomingMessage) => (agent: AgentRecord): boolean =>
    requestCanAccessResource(req, "agent.read", {
      type: "agent",
      id: agent.id,
      ownerUserId: agent.ownerUserId ?? null,
    });

  registerProjectWorkspaceRoutes(router, deps);
  registerProjectVendorComponentsRoutes(router, deps);

  router.add("GET", "/api/admin/projects", async (req, res, _params) => {
    if (!requireStore(deps.projectStore, res, "Project store not available")) return;
    const store = deps.projectStore;
    const projects = await store.listProjects();
    const integrations = await readableIntegrationLookup(req);
    const agentsById = new Map<string, AgentRecord>();
    const summaries: ProjectSummary[] = [];
    for (const p of projects) {
      summaries.push(await buildProjectSummary(p, store, integrations, agentsById, canReadAgent(req)));
    }
    const perms = getEffectivePermissions(req);
    const actorUserId = getAuthContext(req)?.userId ?? null;
    const visible = perms
      ? summaries.filter((project) => canAccessResource(
          perms,
          "project.read",
          { type: "project", id: project.id, ownerUserId: project.ownerUserId ?? null },
          actorUserId
        ))
      : summaries;
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
    if (!requireStore(deps.integrationStore, res, "Integration store not available")) return;
    const integrationStore = deps.integrationStore;
    const agent = await store.getAgentById(makeAgentId(data.agentId));
    if (getEffectivePermissions(req)) {
      const unreadableReference = await findUnreadableProjectReference(req, store, integrationStore, {
        agent,
        integrationIds: projectIntegrationIds(data),
        ...(data.agentOverrideJson !== undefined ? { agentOverrideJson: data.agentOverrideJson } : {}),
      });
      if (unreadableReference) {
        writeJson(res, 403, { error: "forbidden", permission: unreadableReference });
        return;
      }
    }
    const agentError = await validateProjectAgent(agent, data.type, integrationStore, data.agentId);
    if (agentError) { writeJson(res, 400, { error: agentError }); return; }
    if (!agent) { writeJson(res, 400, { error: `Agent not found: ${data.agentId}` }); return; }
    if (data.type === "review") {
      const reviewConfigError = await validateProjectReviewConfig(data.reviewConfig, integrationStore);
      if (reviewConfigError) { writeJson(res, 400, { error: reviewConfigError }); return; }
    }
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
        ownerUserId: getAuthContext(req)?.userId ?? null,
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
        await store.setProjectReviewConfig(
          project.id,
          data.reviewConfig.integrationId,
          data.reviewConfig.repoKeys,
          data.reviewConfig.assignmentMode,
        );
      }
    } catch (err: unknown) {
      try { await store.deleteProject(project.id); } catch { /* ignore */ }
      const msg = err instanceof Error ? err.message : String(err);
      const status = isUniqueConflict(err) ? 409 : 500;
      log.warn({ err, projectId: project.id }, "attach project children failed");
      writeJson(res, status, { error: status === 409 ? "Conflict" : "Failed to create project", message: msg }); return;
    }
    const integrations = await readableIntegrationLookup(req);
    const detail = await buildProjectDetail(project, store, integrations, canReadAgent(req));
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
          : {
              repoKeys: data.reviewConfig.repoKeys,
              assignmentMode: data.reviewConfig.assignmentMode,
            }),
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
  }, { permission: "project.create" });

  router.add("GET", "/api/admin/projects/:id/access", async (_req, res, params) => {
    if (!requireStore(deps.projectAccessStore, res, "Project access store not available")) return;
    const projectId = params["id"] ?? "";
    const prefix = projectAccessPolicyPrefix(projectId);
    const policies = (await deps.projectAccessStore.listPolicies())
      .filter((policy) => policy.id.startsWith(prefix));
    const grants = await Promise.all(policies.map(async (policy) => {
      const groupId = policy.id.slice(prefix.length);
      const [group, rules] = await Promise.all([
        deps.projectAccessStore?.getGroupById(groupId),
        deps.projectAccessStore?.listPolicyRules(policy.id),
      ]);
      return {
        groupId,
        groupName: group?.name ?? groupId,
        permissions: (rules ?? []).map((rule) => rule.permission).sort(),
      };
    }));
    const availableGroups = (await deps.projectAccessStore.listGroups()).map((group) => ({
      id: group.id,
      name: group.name,
    }));
    writeJson(res, 200, { grants, availableGroups });
  }, { permission: "project.owner", resourceParam: "id" });

  router.add("PUT", "/api/admin/projects/:id/access/groups/:groupId", async (req, res, params) => {
    if (!requireStore(deps.projectAccessStore, res, "Project access store not available")) return;
    const projectId = params["id"] ?? "";
    const groupId = params["groupId"] ?? "";
    const group = await deps.projectAccessStore.getGroupById(groupId);
    if (!group) { writeJson(res, 404, { error: "Group not found" }); return; }
    const parsed = projectAccessSchema.safeParse(await readBody(req));
    if (!parsed.success) {
      writeJson(res, 400, zodErrorBody(parsed.error, "Invalid project access payload"));
      return;
    }
    const policyId = projectAccessPolicyId(projectId, groupId);
    let policy = await deps.projectAccessStore.getPolicyById(policyId);
    if (!policy) {
      policy = await deps.projectAccessStore.createPolicy({
        id: policyId,
        name: `Project access ${projectId} ${groupId}`,
        description: `Group access delegated for project ${projectId}`,
      });
    }
    try {
      await deps.projectAccessStore.createBinding({
        policyId: policy.id,
        principalType: "group",
        principalId: groupId,
      });
    } catch (err) {
      if (!(err instanceof Error && "code" in err && (err as { code?: unknown }).code === "DUPLICATE")) {
        throw err;
      }
    }
    const permissions = [...new Set(parsed.data.permissions)].sort();
    await deps.projectAccessStore.setPolicyRules(
      policy.id,
      permissions.map((permission) => ({ permission, resourceId: projectId }))
    );
    recordAudit(deps.auditStore, req, {
      action: "project.access_set",
      targetType: "project",
      targetId: projectId,
      details: { groupId, permissions },
    });
    writeJson(res, 200, { groupId, groupName: group.name, permissions });
  }, { permission: "project.owner", resourceParam: "id" });

  router.add("DELETE", "/api/admin/projects/:id/access/groups/:groupId", async (req, res, params) => {
    if (!requireStore(deps.projectAccessStore, res, "Project access store not available")) return;
    const projectId = params["id"] ?? "";
    const groupId = params["groupId"] ?? "";
    const removed = await deps.projectAccessStore.deletePolicy(projectAccessPolicyId(projectId, groupId));
    if (!removed) { writeJson(res, 404, { error: "Project access grant not found" }); return; }
    recordAudit(deps.auditStore, req, {
      action: "project.access_remove",
      targetType: "project",
      targetId: projectId,
      details: { groupId },
    });
    res.statusCode = 204;
    res.end();
  }, { permission: "project.owner", resourceParam: "id" });

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

  router.add("GET", "/api/admin/projects/:id", async (req, res, params) => {
    if (!requireStore(deps.projectStore, res, "Project store not available")) return;
    const store = deps.projectStore;
    const id = makeProjectId(params["id"] ?? "");
    const existing = await store.getProjectById(id);
    if (!existing) { writeJson(res, 404, { error: "Project not found" }); return; }
    const integrations = await readableIntegrationLookup(req);
    const detail = await buildProjectDetail(existing, store, integrations, canReadAgent(req));
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
      prospectiveAgent = await store.getAgentById(makeAgentId(data.agentId));
    }
    if (data.agentOverrideJson !== undefined) {
      prospectiveAgent ??= await store.getAgentById(existing.agentId);
    }
    if (deps.integrationStore) {
      const unreadableReference = await findUnreadableProjectReference(req, store, deps.integrationStore, {
        agent: data.agentId !== undefined ? prospectiveAgent : null,
        integrationIds: projectIntegrationIds(data),
        ...(data.agentOverrideJson !== undefined ? { agentOverrideJson: data.agentOverrideJson } : {}),
      });
      if (unreadableReference) {
        writeJson(res, 403, { error: "forbidden", permission: unreadableReference });
        return;
      }
    } else if (getEffectivePermissions(req)) {
      writeJson(res, 501, { error: "Integration store not available" });
      return;
    }
    if (data.agentId !== undefined) {
      if (!requireStore(deps.integrationStore, res, "Integration store not available")) return;
      const agentError = await validateProjectAgent(
        prospectiveAgent,
        existing.type,
        deps.integrationStore,
        data.agentId
      );
      if (agentError) { writeJson(res, 400, { error: agentError }); return; }
    }
    if (data.agentOverrideJson !== undefined) {
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
    if (data.reviewConfig !== undefined) {
      if (!requireStore(deps.integrationStore, res, "Integration store not available")) return;
      const reviewConfigError = await validateProjectReviewConfig(data.reviewConfig, deps.integrationStore);
      if (reviewConfigError) { writeJson(res, 400, { error: reviewConfigError }); return; }
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
    let executionChanged = false;
    try {
      const updateResult = await store.updateProjectConfiguration(id, {
        project: updates,
        ...(data.ticketSource !== undefined ? { ticketSource: data.ticketSource } : {}),
        ...(data.pushTargets !== undefined ? { pushTargets: data.pushTargets } : {}),
        ...(data.reviewConfig !== undefined ? { reviewConfig: data.reviewConfig } : {}),
        ...(data.confirmedActiveTaskIds !== undefined ? { confirmedActiveTaskIds: data.confirmedActiveTaskIds } : {}),
      });
      executionChanged = updateResult.executionChanged;
    } catch (err: unknown) {
      if (err instanceof ActiveProjectTasksConfirmationRequiredError) {
        writeJson(res, 409, {
          error: "Conflict",
          message: err.message,
          code: err.code,
          activeTasks: err.activeTasks,
        });
        return;
      }
      const status = isUniqueConflict(err) ? 409 : 500;
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err, id }, "update project children failed");
      writeJson(res, status, { error: status === 409 ? "Conflict" : "Update failed", message: msg }); return;
    }
    const refreshed = await store.getProjectById(id);
    if (!refreshed) { writeJson(res, 500, { error: "Project disappeared after update" }); return; }
    const integrations = await readableIntegrationLookup(req);
    const detail = await buildProjectDetail(refreshed, store, integrations, canReadAgent(req));
    recordAudit(deps.auditStore, req, {
      action: "project.update",
      targetType: "project",
      targetId: id,
      details: {
        name: refreshed.name,
        ...(data.reviewConfig !== undefined
          ? { reviewAssignmentMode: data.reviewConfig.assignmentMode }
          : {}),
      },
    });
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
    if (executionChanged || (updates.enabled === true && existing.enabled !== true)) {
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

