import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getLogger } from "../logger.js";
import { writeJson, readBody } from "./adminRouteUtils.js";
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

const log = getLogger("admin-projects");

export interface ProjectsRouteStore {
  createProject(input: {
    id?: string;
    name: string;
    type: ProjectType;
    agentId: AgentId;
    agentOverrideJson?: string | null;
    postCloneScript?: string;
    maxConcurrent?: number;
    enabled?: boolean;
  }): Promise<ProjectRecord>;
  getProjectById(id: ProjectId): Promise<ProjectRecord | null>;
  listProjects(filter?: { type?: ProjectType; enabled?: boolean }): Promise<ProjectRecord[]>;
  updateProject(
    id: ProjectId,
    partial: Partial<Pick<ProjectRecord, "name" | "type" | "agentId" | "agentOverrideJson" | "postCloneScript" | "maxConcurrent" | "enabled">>
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
}

const pushTargetSchema = z.object({
  integrationId: z.string().min(1),
  repoKey: z.string().min(1),
  cloneUrl: z.string().min(1),
  targetBranch: z.string().min(1),
  role: z.enum(["primary", "submodule", "dependency", "related"]),
  commitOrder: z.number().int().min(1),
  localPath: z.string().min(1),
  sshKeyPath: z.string().optional(),
});

const ticketSourceSchema = z.object({
  integrationId: z.string().min(1),
  ticketProjectKey: z.string().min(1),
});

const reviewConfigSchema = z.object({
  integrationId: z.string().min(1),
  repoKeys: z.array(z.string()).min(1),
});

const codingProjectCreateSchema = z.object({
  id: z.string().optional(),
  type: z.literal("coding"),
  name: z.string().min(1),
  agentId: z.string().min(1),
  agentOverrideJson: z.string().nullable().optional(),
  postCloneScript: z.string().optional(),
  maxConcurrent: z.number().int().min(1).optional(),
  enabled: z.boolean().optional(),
  ticketSource: ticketSourceSchema,
  pushTargets: z.array(pushTargetSchema).min(1),
});

const reviewProjectCreateSchema = z.object({
  id: z.string().optional(),
  type: z.literal("review"),
  name: z.string().min(1),
  agentId: z.string().min(1),
  agentOverrideJson: z.string().nullable().optional(),
  postCloneScript: z.string().optional(),
  maxConcurrent: z.number().int().min(1).optional(),
  enabled: z.boolean().optional(),
  reviewConfig: reviewConfigSchema,
});

const projectCreateSchema = z.discriminatedUnion("type", [
  codingProjectCreateSchema,
  reviewProjectCreateSchema,
]);

const projectUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  agentOverrideJson: z.string().nullable().optional(),
  postCloneScript: z.string().optional(),
  maxConcurrent: z.number().int().min(1).optional(),
  enabled: z.boolean().optional(),
  ticketSource: ticketSourceSchema.optional(),
  pushTargets: z.array(pushTargetSchema).optional(),
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
  maxConcurrent: number;
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
    maxConcurrent: project.maxConcurrent,
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
    maxConcurrent: project.maxConcurrent,
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

/**
 * Try to handle a projects-route request. Returns true if the request was
 * handled (response sent), false otherwise.
 */
export async function handleProjectsRoute(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  method: string,
  deps: ProjectsRouteDeps
): Promise<boolean> {
  if (!path.startsWith("/api/admin/projects")) return false;

  if (!deps.projectStore) {
    writeJson(response, 501, { error: "Project store not available" });
    return true;
  }
  const store = deps.projectStore;

  if (path === "/api/admin/projects" && method === "GET") {
    const projects = await store.listProjects();
    const integrations = await loadIntegrationsLookup(deps.integrationStore);
    const agentsById = new Map<string, AgentRecord>();
    const summaries: ProjectSummary[] = [];
    for (const p of projects) {
      summaries.push(await buildProjectSummary(p, store, integrations, agentsById));
    }
    writeJson(response, 200, { projects: summaries });
    return true;
  }

  if (path === "/api/admin/projects" && method === "POST") {
    const body = await readBody(request);
    if (!body) {
      writeJson(response, 400, { error: "Request body required" });
      return true;
    }
    const parsed = projectCreateSchema.safeParse(body);
    if (!parsed.success) {
      writeJson(response, 400, { error: "Invalid project payload", details: parsed.error.flatten() });
      return true;
    }
    const data = parsed.data;
    const agent = await store.getAgentById(makeAgentId(data.agentId));
    if (!agent) {
      writeJson(response, 400, { error: `Agent not found: ${data.agentId}` });
      return true;
    }
    if (agent.type !== data.type) {
      writeJson(response, 400, {
        error: `Agent type mismatch: agent is '${agent.type}', project is '${data.type}'`,
      });
      return true;
    }

    // Pre-flight conflict check (coding projects only)
    if (data.type === "coding") {
      const conflict = await store.findProjectByTicketSource(
        data.ticketSource.integrationId,
        data.ticketSource.ticketProjectKey
      );
      if (conflict) {
        writeJson(response, 409, {
          error: "Conflict",
          message: `Ticket source (${data.ticketSource.integrationId}, ${data.ticketSource.ticketProjectKey}) is already claimed by project '${conflict.name}' (${conflict.id})`,
          conflictingProjectId: conflict.id,
          conflictingProjectName: conflict.name,
        });
        return true;
      }
    }

    let project: ProjectRecord;
    try {
      project = await store.createProject({
        ...(data.id !== undefined ? { id: data.id } : {}),
        name: data.name,
        type: data.type,
        agentId: makeAgentId(data.agentId),
        ...(data.agentOverrideJson !== undefined ? { agentOverrideJson: data.agentOverrideJson } : {}),
        ...(data.postCloneScript !== undefined ? { postCloneScript: data.postCloneScript } : {}),
        ...(data.maxConcurrent !== undefined ? { maxConcurrent: data.maxConcurrent } : {}),
        ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err }, "create project failed");
      writeJson(response, 500, { error: msg });
      return true;
    }

    try {
      if (data.type === "coding") {
        await store.setProjectTicketSource(project.id, data.ticketSource);
        await store.replaceProjectPushTargets(project.id, data.pushTargets);
      } else {
        await store.setProjectReviewConfig(project.id, data.reviewConfig.integrationId, data.reviewConfig.repoKeys);
      }
    } catch (err: unknown) {
      // Best-effort rollback
      try { await store.deleteProject(project.id); } catch { /* ignore */ }
      const msg = err instanceof Error ? err.message : String(err);
      const status = isUniqueConflict(err) ? 409 : 500;
      log.warn({ err, projectId: project.id }, "attach project children failed");
      writeJson(response, status, { error: status === 409 ? "Conflict" : "Failed to create project", message: msg });
      return true;
    }

    const integrations = await loadIntegrationsLookup(deps.integrationStore);
    const detail = await buildProjectDetail(project, store, integrations);
    writeJson(response, 201, { project: detail });
    deps.onProjectChange?.();
    return true;
  }

  const idMatch = /^\/api\/admin\/projects\/([^/]+)$/.exec(path);
  if (idMatch) {
    const id = makeProjectId(decodeURIComponent(idMatch[1] ?? ""));
    const existing = await store.getProjectById(id);

    if (method === "GET") {
      if (!existing) {
        writeJson(response, 404, { error: "Project not found" });
        return true;
      }
      const integrations = await loadIntegrationsLookup(deps.integrationStore);
      const detail = await buildProjectDetail(existing, store, integrations);
      writeJson(response, 200, { project: detail });
      return true;
    }

    if (method === "PUT") {
      if (!existing) {
        writeJson(response, 404, { error: "Project not found" });
        return true;
      }
      const body = await readBody(request);
      if (!body) {
        writeJson(response, 400, { error: "Request body required" });
        return true;
      }
      const parsed = projectUpdateSchema.safeParse(body);
      if (!parsed.success) {
        writeJson(response, 400, { error: "Invalid project payload", details: parsed.error.flatten() });
        return true;
      }
      const data = parsed.data;

      // Validate agent type match if agentId changes
      if (data.agentId !== undefined) {
        const agent = await store.getAgentById(makeAgentId(data.agentId));
        if (!agent) {
          writeJson(response, 400, { error: `Agent not found: ${data.agentId}` });
          return true;
        }
        if (agent.type !== existing.type) {
          writeJson(response, 400, {
            error: `Agent type mismatch: agent is '${agent.type}', project is '${existing.type}'`,
          });
          return true;
        }
      }

      const updates: Parameters<ProjectsRouteStore["updateProject"]>[1] = {};
      if (data.name !== undefined) updates.name = data.name;
      if (data.agentId !== undefined) updates.agentId = makeAgentId(data.agentId);
      if (data.agentOverrideJson !== undefined) updates.agentOverrideJson = data.agentOverrideJson;
      if (data.postCloneScript !== undefined) updates.postCloneScript = data.postCloneScript;
      if (data.maxConcurrent !== undefined) updates.maxConcurrent = data.maxConcurrent;
      if (data.enabled !== undefined) updates.enabled = data.enabled;

      try {
        if (Object.keys(updates).length > 0) {
          await store.updateProject(id, updates);
        }
        if (data.ticketSource !== undefined) {
          if (existing.type !== "coding") {
            writeJson(response, 400, { error: "ticketSource only valid for coding projects" });
            return true;
          }
          await store.setProjectTicketSource(id, data.ticketSource);
        }
        if (data.pushTargets !== undefined) {
          if (existing.type !== "coding") {
            writeJson(response, 400, { error: "pushTargets only valid for coding projects" });
            return true;
          }
          await store.replaceProjectPushTargets(id, data.pushTargets);
        }
        if (data.reviewConfig !== undefined) {
          if (existing.type !== "review") {
            writeJson(response, 400, { error: "reviewConfig only valid for review projects" });
            return true;
          }
          await store.setProjectReviewConfig(id, data.reviewConfig.integrationId, data.reviewConfig.repoKeys);
        }
      } catch (err: unknown) {
        const status = isUniqueConflict(err) ? 409 : 500;
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ err, id }, "update project children failed");
        writeJson(response, status, { error: status === 409 ? "Conflict" : "Update failed", message: msg });
        return true;
      }

      const refreshed = await store.getProjectById(id);
      if (!refreshed) {
        writeJson(response, 500, { error: "Project disappeared after update" });
        return true;
      }
      const integrations = await loadIntegrationsLookup(deps.integrationStore);
      const detail = await buildProjectDetail(refreshed, store, integrations);
      writeJson(response, 200, { project: detail });
      deps.onProjectChange?.();
      return true;
    }

    if (method === "DELETE") {
      if (!existing) {
        writeJson(response, 404, { error: "Project not found" });
        return true;
      }
      try {
        await store.deleteProject(id);
        response.statusCode = 204;
        response.end();
        deps.onProjectChange?.();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ err, id }, "delete project failed");
        writeJson(response, 500, { error: msg });
      }
      return true;
    }

    writeJson(response, 405, { error: "Method not allowed" });
    return true;
  }

  const enableMatch = /^\/api\/admin\/projects\/([^/]+)\/enable$/.exec(path);
  if (enableMatch && method === "PATCH") {
    const id = makeProjectId(decodeURIComponent(enableMatch[1] ?? ""));
    const existing = await store.getProjectById(id);
    if (!existing) {
      writeJson(response, 404, { error: "Project not found" });
      return true;
    }
    await store.setProjectEnabled(id, true);
    response.statusCode = 204;
    response.end();
    deps.onProjectChange?.();
    return true;
  }

  const disableMatch = /^\/api\/admin\/projects\/([^/]+)\/disable$/.exec(path);
  if (disableMatch && method === "PATCH") {
    const id = makeProjectId(decodeURIComponent(disableMatch[1] ?? ""));
    const existing = await store.getProjectById(id);
    if (!existing) {
      writeJson(response, 404, { error: "Project not found" });
      return true;
    }
    await store.setProjectEnabled(id, false);
    response.statusCode = 204;
    response.end();
    deps.onProjectChange?.();
    return true;
  }

  return false;
}

// Re-export types for tests
export type { ProjectSummary, ProjectDetail };
