import { z } from "zod";
import { getLogger } from "../logger.js";
import { writeJson, readBody, zodErrorBody } from "./adminRouteUtils.js";
import {
  makeAgentId,
  makeProjectId,
  type AgentId,
  type AgentRecord,
  type Integration,
  type IntegrationStore,
  type ProjectId,
  type ProjectPushTargetRecord,
  type ProjectRecord,
  type ProjectReviewConfig,
  type ProjectTicketSourceRecord,
  type ProjectType,
  type PushTargetRole,
} from "../interfaces.js";
import type { Router } from "./router.js";

const log = getLogger("admin-projects");

export interface ProjectsRouteStore {
  createProject(input: {
    id?: string;
    name: string;
    type: ProjectType;
    agentId: AgentId;
    agentOverrideJson?: string | null;
    postCloneScript?: string;
    enabled?: boolean;
  }): Promise<ProjectRecord>;
  getProjectById(id: ProjectId): Promise<ProjectRecord | null>;
  listProjects(filter?: { type?: ProjectType; enabled?: boolean }): Promise<ProjectRecord[]>;
  updateProject(
    id: ProjectId,
    partial: Partial<Pick<ProjectRecord, "name" | "type" | "agentId" | "agentOverrideJson" | "postCloneScript" | "enabled">>
  ): Promise<ProjectRecord>;
  deleteProject(id: ProjectId): Promise<void>;
  setProjectEnabled(id: ProjectId, enabled: boolean): Promise<void>;
  setProjectTicketSource(
    projectId: ProjectId,
    input: { integrationId: string; ticketProjectKey: string }
  ): Promise<ProjectTicketSourceRecord>;
  getProjectTicketSource(projectId: ProjectId): Promise<ProjectTicketSourceRecord | null>;
  replaceProjectPushTargets(
    projectId: ProjectId,
    inputs: Array<{
      integrationId: string;
      repoKey: string;
      cloneUrl: string;
      targetBranch: string;
      role: PushTargetRole;
      commitOrder: number;
      localPath: string;
      sshKeyPath?: string | null | undefined;
    }>
  ): Promise<ProjectPushTargetRecord[]>;
  listProjectPushTargets(projectId: ProjectId): Promise<ProjectPushTargetRecord[]>;
  setProjectReviewConfig(
    projectId: ProjectId,
    integrationId: string,
    repoKeys: string[]
  ): Promise<void>;
  getProjectReviewConfig(projectId: ProjectId): Promise<ProjectReviewConfig | null>;
  getAgentById(id: AgentId): Promise<AgentRecord | null>;
  findProjectByTicketSource(integrationId: string, ticketProjectKey: string): Promise<ProjectRecord | null>;
}

export interface ProjectsRouteDeps {
  projectStore?: ProjectsRouteStore | undefined;
  integrationStore?: IntegrationStore | undefined;
  onProjectChange?: (() => void) | undefined;
  onProjectDeleted?:
    | ((project: { id: ProjectId; homeCacheSeed: string }) => void | Promise<void>)
    | undefined;
  /** Reserve an exclusive block before destructive project ops; returns false when a cycle is active. */
  tryBlockProject?: ((id: ProjectId) => boolean) | undefined;
  unblockProject?: ((id: ProjectId) => void) | undefined;
}

const pushTargetSchema = z.object({
  integrationId: z.string().min(1, "VCS integration is required for each repository"),
  repoKey: z.string().min(1, "Repository must be selected"),
  cloneUrl: z.string().min(1, "Clone URL is required"),
  targetBranch: z.string().min(1, "Target branch is required"),
  role: z.enum(["primary", "submodule", "dependency", "related"]),
  commitOrder: z.number().int().min(1),
  localPath: z.string().min(1),
  sshKeyPath: z.string().optional(),
});

/** Validate push-target arrays: unique localPaths, at most one root ("."). */
const pushTargetsArraySchema = z.array(pushTargetSchema).min(1).superRefine((targets, ctx) => {
  const paths = targets.map((t) => t.localPath);
  const roots = paths.filter((p) => p === ".");
  if (roots.length > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Only one push target may have localPath \".\" (root)",
    });
  }
  const seen = new Set<string>();
  for (const p of paths) {
    if (seen.has(p)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate localPath "${p}" — each push target must have a unique workspace path`,
      });
      break;
    }
    seen.add(p);
  }
});

const ticketSourceSchema = z.object({
  integrationId: z.string().min(1, "Ticket source integration is required"),
  ticketProjectKey: z.string().min(1, "Ticket source project is required"),
});

const reviewConfigSchema = z.object({
  integrationId: z.string().min(1, "Review integration is required"),
  repoKeys: z.array(z.string()).min(1, "Select at least one repository to review"),
});

const codingProjectCreateSchema = z.object({
  id: z.string().optional(),
  type: z.literal("coding"),
  name: z.string().min(1, "Project name is required"),
  agentId: z.string().min(1, "Agent is required — create and enable a coding agent first (Agents tab)"),
  agentOverrideJson: z.string().nullable().optional(),
  postCloneScript: z.string().optional(),
  enabled: z.boolean().optional(),
  ticketSource: ticketSourceSchema,
  pushTargets: pushTargetsArraySchema,
});

const reviewProjectCreateSchema = z.object({
  id: z.string().optional(),
  type: z.literal("review"),
  name: z.string().min(1, "Project name is required"),
  agentId: z.string().min(1, "Agent is required — create and enable a review agent first (Agents tab)"),
  agentOverrideJson: z.string().nullable().optional(),
  postCloneScript: z.string().optional(),
  enabled: z.boolean().optional(),
  reviewConfig: reviewConfigSchema,
});

const projectCreateSchema = z.discriminatedUnion("type", [
  codingProjectCreateSchema,
  reviewProjectCreateSchema,
]);

const projectUpdateSchema = z.object({
  name: z.string().min(1, "Project name is required").optional(),
  agentId: z.string().min(1, "Agent is required").optional(),
  agentOverrideJson: z.string().nullable().optional(),
  postCloneScript: z.string().optional(),
  enabled: z.boolean().optional(),
  ticketSource: ticketSourceSchema.optional(),
  pushTargets: pushTargetsArraySchema.optional(),
  reviewConfig: reviewConfigSchema.optional(),
});



interface IntegrationLookup {
  byId: Map<string, Integration>;
}

/** Load all integrations from the store and index them by id. */
async function loadIntegrationsLookup(store: IntegrationStore | undefined): Promise<IntegrationLookup> {
  const byId = new Map<string, Integration>();
  if (store) {
    const all = await store.getIntegrations();
    for (const i of all) byId.set(i.id, i);
  }
  return { byId };
}

/** Integration types that use HTTPS for cloning — SSH URLs are invalid for these. */
const HTTPS_ONLY_VCS_TYPES = new Set(["github-pull-request", "gitlab-merge-request"]);

/**
 * Validate that push targets for HTTPS-based integrations (GitHub, GitLab) do
 * not use SSH clone URLs (`git@...`). Returns an error message or null.
 */
async function validatePushTargetCloneUrls(
  targets: Array<{ integrationId: string; cloneUrl: string; repoKey: string }>,
  integrationStore: IntegrationStore | undefined
): Promise<string | null> {
  if (!integrationStore) return null;
  for (const target of targets) {
    if (!target.cloneUrl.startsWith("git@")) continue;
    const integration = await integrationStore.getIntegration(target.integrationId).catch(() => null);
    if (integration && HTTPS_ONLY_VCS_TYPES.has(integration.type)) {
      return `Push target "${target.repoKey}" uses an SSH clone URL (${target.cloneUrl}) which is not supported for ${integration.type} integrations. Use an HTTPS URL instead (e.g. https://github.com/owner/repo.git).`;
    }
  }
  return null;
}

/** Return a minimal integration descriptor object for embedding in project API responses. */
function describeIntegration(integ: Integration | undefined): { id: string; name: string; type: string } | null {
  if (!integ) return null;
  return { id: integ.id, name: integ.name, type: integ.type };
}

interface ProjectSummary {
  id: string;
  name: string;
  type: ProjectRecord["type"];
  agentId: string;
  agentName: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  ticketSource: { integration: { id: string; name: string; type: string } | null; ticketProjectKey: string } | null;
  reviewConfig: { integration: { id: string; name: string; type: string } | null; repos: string[] } | null;
  pushTargetCount: number;
}

interface ProjectDetail extends ProjectSummary {
  agentOverrideJson: string | null;
  postCloneScript: string;
  pushTargets: Array<{
    id: number;
    integration: { id: string; name: string; type: string } | null;
    integrationId: string;
    repoKey: string;
    cloneUrl: string;
    targetBranch: string;
    role: ProjectPushTargetRecord["role"];
    commitOrder: number;
    localPath: string;
    sshKeyPath: string | null;
  }>
}

/** Build the summary API shape for a project including ticket source and review config metadata. */
async function buildProjectSummary(
  project: ProjectRecord,
  store: ProjectsRouteStore,
  integrations: IntegrationLookup,
  agentsById: Map<string, AgentRecord>
): Promise<ProjectSummary> {
  const agent = agentsById.get(project.agentId) ?? (await store.getAgentById(makeAgentId(project.agentId)));
  if (agent) agentsById.set(agent.id, agent);
  let ticketSource: ProjectSummary["ticketSource"] = null;
  let reviewConfig: ProjectSummary["reviewConfig"] = null;
  let pushTargetCount = 0;
  if (project.type === "coding") {
    const ts = await store.getProjectTicketSource(project.id);
    if (ts) {
      ticketSource = {
        integration: describeIntegration(integrations.byId.get(ts.integrationId)),
        ticketProjectKey: ts.ticketProjectKey,
      };
    }
    pushTargetCount = (await store.listProjectPushTargets(project.id)).length;
  } else {
    const rc = await store.getProjectReviewConfig(project.id);
    if (rc) {
      reviewConfig = {
        integration: describeIntegration(integrations.byId.get(rc.integrationId)),
        repos: rc.repos,
      };
    }
  }
  return {
    id: project.id,
    name: project.name,
    type: project.type,
    agentId: project.agentId,
    agentName: agent ? agent.name : null,
    enabled: project.enabled,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    ticketSource,
    reviewConfig,
    pushTargetCount,
  };
}

/** Build the full detail API shape for a project including push targets and all child records. */
async function buildProjectDetail(
  project: ProjectRecord,
  store: ProjectsRouteStore,
  integrations: IntegrationLookup
): Promise<ProjectDetail> {
  const agent = await store.getAgentById(makeAgentId(project.agentId));
  let ticketSource: ProjectSummary["ticketSource"] = null;
  let reviewConfig: ProjectSummary["reviewConfig"] = null;
  let pushTargets: ProjectDetail["pushTargets"] = [];
  let pushTargetCount = 0;
  if (project.type === "coding") {
    const ts = await store.getProjectTicketSource(project.id);
    if (ts) {
      ticketSource = {
        integration: describeIntegration(integrations.byId.get(ts.integrationId)),
        ticketProjectKey: ts.ticketProjectKey,
      };
    }
    const pts = await store.listProjectPushTargets(project.id);
    pushTargetCount = pts.length;
    pushTargets = pts.map((p) => ({
      id: p.id,
      integration: describeIntegration(integrations.byId.get(p.integrationId)),
      integrationId: p.integrationId,
      repoKey: p.repoKey,
      cloneUrl: p.cloneUrl,
      targetBranch: p.targetBranch,
      role: p.role,
      commitOrder: p.commitOrder,
      localPath: p.localPath,
      sshKeyPath: p.sshKeyPath,
    }));
  } else {
    const rc = await store.getProjectReviewConfig(project.id);
    if (rc) {
      reviewConfig = {
        integration: describeIntegration(integrations.byId.get(rc.integrationId)),
        repos: rc.repos,
      };
    }
  }
  return {
    id: project.id,
    name: project.name,
    type: project.type,
    agentId: project.agentId,
    agentName: agent ? agent.name : null,
    enabled: project.enabled,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    agentOverrideJson: project.agentOverrideJson,
    postCloneScript: project.postCloneScript,
    ticketSource,
    reviewConfig,
    pushTargetCount,
    pushTargets,
  };
}

/** Returns true if the error represents a unique-constraint or ticket-source conflict. */
function isUniqueConflict(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message;
  return m.includes("already claimed by project") || /UNIQUE constraint/i.test(m);
}

/** Register project routes on the given router. */
export function registerProjectRoutes(router: Router, deps: ProjectsRouteDeps): void {
  router.add("GET", "/api/admin/projects", async (_req, res, _params) => {
    if (!deps.projectStore) { writeJson(res, 501, { error: "Project store not available" }); return; }
    const store = deps.projectStore;
    const projects = await store.listProjects();
    const integrations = await loadIntegrationsLookup(deps.integrationStore);
    const agentsById = new Map<string, AgentRecord>();
    const summaries: ProjectSummary[] = [];
    for (const p of projects) {
      summaries.push(await buildProjectSummary(p, store, integrations, agentsById));
    }
    writeJson(res, 200, { projects: summaries });
  });

  router.add("POST", "/api/admin/projects", async (req, res, _params) => {
    if (!deps.projectStore) { writeJson(res, 501, { error: "Project store not available" }); return; }
    const store = deps.projectStore;
    const body = await readBody(req);
    if (!body) { writeJson(res, 400, { error: "Request body required" }); return; }
    const parsed = projectCreateSchema.safeParse(body);
    if (!parsed.success) { writeJson(res, 400, zodErrorBody(parsed.error, "Invalid project payload")); return; }
    const data = parsed.data;
    const agent = await store.getAgentById(makeAgentId(data.agentId));
    if (!agent) { writeJson(res, 400, { error: `Agent not found: ${data.agentId}` }); return; }
    if (agent.type !== data.type) {
      writeJson(res, 400, { error: `Agent type mismatch: agent is '${agent.type}', project is '${data.type}'` }); return;
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
    try {
      project = await store.createProject({
        ...(data.id !== undefined ? { id: data.id } : {}),
        name: data.name, type: data.type,
        agentId: makeAgentId(data.agentId),
        ...(data.agentOverrideJson !== undefined ? { agentOverrideJson: data.agentOverrideJson } : {}),
        ...(data.postCloneScript !== undefined ? { postCloneScript: data.postCloneScript } : {}),
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
        await store.setProjectTicketSource(project.id, data.ticketSource);
        await store.replaceProjectPushTargets(project.id, data.pushTargets);
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
    writeJson(res, 201, { project: detail });
    deps.onProjectChange?.();
  });

  // Enable or disable a project by id.
  router.add("PATCH", "/api/admin/projects/:id/enable", async (_req, res, params) => {
    if (!deps.projectStore) { writeJson(res, 501, { error: "Project store not available" }); return; }
    const store = deps.projectStore;
    const id = makeProjectId(params["id"] ?? "");
    const existing = await store.getProjectById(id);
    if (!existing) { writeJson(res, 404, { error: "Project not found" }); return; }
    await store.setProjectEnabled(id, true);
    res.statusCode = 204; res.end();
    deps.onProjectChange?.();
  });

  router.add("PATCH", "/api/admin/projects/:id/disable", async (_req, res, params) => {
    if (!deps.projectStore) { writeJson(res, 501, { error: "Project store not available" }); return; }
    const store = deps.projectStore;
    const id = makeProjectId(params["id"] ?? "");
    const existing = await store.getProjectById(id);
    if (!existing) { writeJson(res, 404, { error: "Project not found" }); return; }
    await store.setProjectEnabled(id, false);
    res.statusCode = 204; res.end();
    deps.onProjectChange?.();
  });

  router.add("GET", "/api/admin/projects/:id", async (_req, res, params) => {
    if (!deps.projectStore) { writeJson(res, 501, { error: "Project store not available" }); return; }
    const store = deps.projectStore;
    const id = makeProjectId(params["id"] ?? "");
    const existing = await store.getProjectById(id);
    if (!existing) { writeJson(res, 404, { error: "Project not found" }); return; }
    const integrations = await loadIntegrationsLookup(deps.integrationStore);
    const detail = await buildProjectDetail(existing, store, integrations);
    writeJson(res, 200, { project: detail });
  });

  router.add("PUT", "/api/admin/projects/:id", async (req, res, params) => {
    if (!deps.projectStore) { writeJson(res, 501, { error: "Project store not available" }); return; }
    const store = deps.projectStore;
    const id = makeProjectId(params["id"] ?? "");
    const existing = await store.getProjectById(id);
    if (!existing) { writeJson(res, 404, { error: "Project not found" }); return; }
    const body = await readBody(req);
    if (!body) { writeJson(res, 400, { error: "Request body required" }); return; }
    const parsed = projectUpdateSchema.safeParse(body);
    if (!parsed.success) { writeJson(res, 400, zodErrorBody(parsed.error, "Invalid project payload")); return; }
    const data = parsed.data;
    if (data.agentId !== undefined) {
      const agent = await store.getAgentById(makeAgentId(data.agentId));
      if (!agent) { writeJson(res, 400, { error: `Agent not found: ${data.agentId}` }); return; }
      if (agent.type !== existing.type) {
        writeJson(res, 400, { error: `Agent type mismatch: agent is '${agent.type}', project is '${existing.type}'` }); return;
      }
    }
    const updates: Parameters<ProjectsRouteStore["updateProject"]>[1] = {};
    if (data.name !== undefined) updates.name = data.name;
    if (data.agentId !== undefined) updates.agentId = makeAgentId(data.agentId);
    if (data.agentOverrideJson !== undefined) updates.agentOverrideJson = data.agentOverrideJson;
    if (data.postCloneScript !== undefined) updates.postCloneScript = data.postCloneScript;
    if (data.enabled !== undefined) updates.enabled = data.enabled;
    try {
      if (Object.keys(updates).length > 0) await store.updateProject(id, updates);
      if (data.ticketSource !== undefined) {
        if (existing.type !== "coding") { writeJson(res, 400, { error: "ticketSource only valid for coding projects" }); return; }
        await store.setProjectTicketSource(id, data.ticketSource);
      }
      if (data.pushTargets !== undefined) {
        if (existing.type !== "coding") { writeJson(res, 400, { error: "pushTargets only valid for coding projects" }); return; }
        const cloneUrlError = await validatePushTargetCloneUrls(data.pushTargets, deps.integrationStore);
        if (cloneUrlError) { writeJson(res, 400, { error: cloneUrlError }); return; }
        await store.replaceProjectPushTargets(id, data.pushTargets);
      }
      if (data.reviewConfig !== undefined) {
        if (existing.type !== "review") { writeJson(res, 400, { error: "reviewConfig only valid for review projects" }); return; }
        await store.setProjectReviewConfig(id, data.reviewConfig.integrationId, data.reviewConfig.repoKeys);
      }
    } catch (err: unknown) {
      const status = isUniqueConflict(err) ? 409 : 500;
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err, id }, "update project children failed");
      writeJson(res, status, { error: status === 409 ? "Conflict" : "Update failed", message: msg }); return;
    }
    const refreshed = await store.getProjectById(id);
    if (!refreshed) { writeJson(res, 500, { error: "Project disappeared after update" }); return; }
    const integrations = await loadIntegrationsLookup(deps.integrationStore);
    const detail = await buildProjectDetail(refreshed, store, integrations);
    writeJson(res, 200, { project: detail });
    deps.onProjectChange?.();
  });

  router.add("DELETE", "/api/admin/projects/:id", async (_req, res, params) => {
    if (!deps.projectStore) { writeJson(res, 501, { error: "Project store not available" }); return; }
    const store = deps.projectStore;
    const id = makeProjectId(params["id"] ?? "");
    const existing = await store.getProjectById(id);
    if (!existing) { writeJson(res, 404, { error: "Project not found" }); return; }
    if (deps.tryBlockProject && !deps.tryBlockProject(id)) {
      writeJson(res, 409, { error: "Project busy", message: "A cycle is running for this project" });
      return;
    }
    try {
      await store.deleteProject(id);
      res.statusCode = 204; res.end();
      const deletedSeed = existing.homeCacheSeed;
      if (deps.onProjectDeleted) {
        void Promise.resolve(deps.onProjectDeleted({ id, homeCacheSeed: deletedSeed })).catch(
          (cleanupErr: unknown) => {
            log.warn({ err: cleanupErr, id }, "post-delete cleanup hook failed (non-fatal)");
          }
        );
      }
      deps.onProjectChange?.();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err, id }, "delete project failed");
      writeJson(res, 500, { error: msg });
    } finally {
      deps.unblockProject?.(id);
    }
  });
}

// Re-export types for tests
export type { ProjectSummary, ProjectDetail };
