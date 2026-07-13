import { z } from "zod";
import { getLogger } from "../logger.js";
import { writeJson, readBody, zodErrorBody } from "./adminRouteUtils.js";
import { recordAudit, type AuditCapableStore } from "./adminAudit.js";
import {
  makeAgentId,
  makeProjectId,
  makeTaskId,
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
  type Task,
} from "../interfaces.js";
import type { Router } from "./router.js";
import { getEffectivePermissions } from "./authContext.js";
import { accessibleResourceIds, ALL_RESOURCES } from "./authorization/policyEngine.js";
import { getProviderDescriptor, getProviderDomainCapabilities } from "../plugins/registry.js";
import { listSkillSourceSkills } from "./skillSourceDiscovery.js";

const log = getLogger("admin-projects");

function isSkillSourceAuthError(message: string): boolean {
  return message.startsWith("SSH skill sources require")
    || message.startsWith("SSH private key path is not readable")
    || message.startsWith("SSH known_hosts path is not readable");
}

async function relaunchFailedTasksForProject(
  store: ProjectsRouteStore,
  projectId: ProjectId,
  taskControl: ProjectsRouteDeps["taskControl"]
): Promise<void> {
  let failedTasks: Task[];
  try {
    failedTasks = await store.getFailedTasksForProject(projectId);
  } catch (err: unknown) {
    log.warn({ err, projectId }, "failed to list failed tasks for automatic relaunch");
    return;
  }

  for (const task of failedTasks) {
    try {
      await store.retryTask(task.taskId);
      void taskControl?.retryTask(task.taskId).catch((err: unknown) => {
        log.warn({ err, projectId, taskId: task.taskId }, "relaunch retryTask failed");
      });
      log.info({ projectId, taskId: task.taskId }, "automatically relaunched failed task after reconfiguration");
    } catch (err: unknown) {
      log.warn({ err, projectId, taskId: task.taskId }, "failed to automatically relaunch task after reconfiguration");
    }
  }
}

export interface ProjectsRouteStore {
  createProject(input: {
    id?: string;
    name: string;
    type: ProjectType;
    agentId: AgentId;
    agentOverrideJson?: string | null;
    postCloneScript?: string;
    skillDiscoveryEnabled?: boolean;
    skillSourcesJson?: string;
    gerritTopicOverride?: string | null;
    useFullTicketUrlInCommits?: boolean;
    postReviewLinkToTicket?: boolean;
    reactToCiFailures?: boolean;
    enabled?: boolean;
  }): Promise<ProjectRecord>;
  getProjectById(id: ProjectId): Promise<ProjectRecord | null>;
  listProjects(filter?: { type?: ProjectType; enabled?: boolean }): Promise<ProjectRecord[]>;
  updateProject(
    id: ProjectId,
    partial: Partial<Pick<ProjectRecord, "name" | "type" | "agentId" | "agentOverrideJson" | "postCloneScript" | "skillDiscoveryEnabled" | "skillSourcesJson" | "gerritTopicOverride" | "useFullTicketUrlInCommits" | "postReviewLinkToTicket" | "reactToCiFailures" | "enabled">>
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
  getFailedTasksForProject(projectId: ProjectId): Promise<Task[]>;
  retryTask(taskId: ReturnType<typeof makeTaskId>): Promise<Task>;
}

export interface ProjectsRouteDeps {
  projectStore?: ProjectsRouteStore | undefined;
  integrationStore?: IntegrationStore | undefined;
  auditStore?: AuditCapableStore | undefined;
  onProjectChange?: (() => void) | undefined;
  taskControl?:
    | {
        retryTask(taskId: ReturnType<typeof makeTaskId>): Promise<void>;
      }
    | undefined;
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

const skillSourceSchema = z.object({
  source: z.string().trim().min(1, "Skill source is required"),
  skills: z.array(z.string().trim().min(1, "Skill name is required")).optional(),
  installAll: z.boolean().optional(),
  sshUser: z.string().trim().optional(),
  sshPort: z.number().int().positive().optional(),
  sshKeyPath: z.string().trim().optional(),
  sshKnownHostsPath: z.string().trim().optional(),
}).superRefine((source, ctx) => {
  if (source.installAll === true) return;
  if ((source.skills ?? []).length > 0) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: "Select at least one skill, or enable Install all",
    path: ["skills"],
  });
});

const skillSourcesSchema = z.array(skillSourceSchema).max(20, "At most 20 skill sources are supported");

const skillSourceDiscoverySchema = z.object({
  source: z.string().trim().min(1, "Skill source is required"),
  sshUser: z.string().trim().optional(),
  sshPort: z.number().int().positive().optional(),
  sshKeyPath: z.string().trim().optional(),
  sshKnownHostsPath: z.string().trim().optional(),
});

interface SkillSource {
  source: string;
  skills: string[];
  installAll?: boolean;
  sshUser?: string;
  sshPort?: number;
  sshKeyPath?: string;
  sshKnownHostsPath?: string;
}

function normalizeSkillSources(sources: z.infer<typeof skillSourcesSchema> | undefined): SkillSource[] {
  if (!sources) return [];
  return sources.map((source) => {
    const ssh = {
      ...(source.sshUser !== undefined && source.sshUser !== "" ? { sshUser: source.sshUser } : {}),
      ...(source.sshPort !== undefined ? { sshPort: source.sshPort } : {}),
      ...(source.sshKeyPath !== undefined && source.sshKeyPath !== "" ? { sshKeyPath: source.sshKeyPath } : {}),
      ...(source.sshKnownHostsPath !== undefined && source.sshKnownHostsPath !== "" ? { sshKnownHostsPath: source.sshKnownHostsPath } : {}),
    };
    if (source.installAll === true) {
      return { source: source.source, skills: [], installAll: true, ...ssh };
    }
    return { source: source.source, skills: Array.from(new Set(source.skills ?? [])), ...ssh };
  });
}

function parseStoredSkillSources(project: ProjectRecord): SkillSource[] {
  try {
    const parsed: unknown = JSON.parse(project.skillSourcesJson || "[]");
    const result = skillSourcesSchema.safeParse(parsed);
    return result.success ? normalizeSkillSources(result.data) : [];
  } catch {
    return [];
  }
}

const codingProjectCreateSchema = z.object({
  id: z.string().optional(),
  type: z.literal("coding"),
  name: z.string().min(1, "Project name is required"),
  agentId: z.string().min(1, "Agent is required — create and enable a coding agent first (Agents tab)"),
  agentOverrideJson: z.string().nullable().optional(),
  postCloneScript: z.string().optional(),
  skillDiscoveryEnabled: z.boolean().optional(),
  skillSources: skillSourcesSchema.optional(),
  gerritTopicOverride: z.string().nullable().optional(),
  useFullTicketUrlInCommits: z.boolean().optional(),
  postReviewLinkToTicket: z.boolean().optional(),
  reactToCiFailures: z.boolean().optional(),
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
  skillDiscoveryEnabled: z.boolean().optional(),
  skillSources: skillSourcesSchema.optional(),
  gerritTopicOverride: z.string().nullable().optional(),
  useFullTicketUrlInCommits: z.boolean().optional(),
  postReviewLinkToTicket: z.boolean().optional(),
  reactToCiFailures: z.boolean().optional(),
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
  skillDiscoveryEnabled: z.boolean().optional(),
  skillSources: skillSourcesSchema.optional(),
  gerritTopicOverride: z.string().nullable().optional(),
  useFullTicketUrlInCommits: z.boolean().optional(),
  postReviewLinkToTicket: z.boolean().optional(),
  reactToCiFailures: z.boolean().optional(),
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
const HTTPS_ONLY_VCS_TYPES = new Set(["github", "gitlab"]);

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
    if (integration && HTTPS_ONLY_VCS_TYPES.has(integration.provider)) {
      return `Push target "${target.repoKey}" uses an SSH clone URL (${target.cloneUrl}) which is not supported for ${integration.provider} integrations. Use an HTTPS URL instead (e.g. https://github.com/owner/repo.git).`;
    }
  }
  return null;
}

/** Return a minimal integration descriptor object for embedding in project API responses. */
function describeIntegration(
  integ: Integration | undefined,
): { id: string; name: string; provider: string; domainCapabilities: string[] } | null {
  if (!integ) return null;
  const descriptor = getProviderDescriptor(integ.provider);
  const domainCapabilities = descriptor ? getProviderDomainCapabilities(descriptor) : [];
  return { id: integ.id, name: integ.name, provider: integ.provider, domainCapabilities };
}

interface ProjectSummary {
  id: string;
  name: string;
  type: ProjectRecord["type"];
  agentId: string;
  agentName: string | null;
  enabled: boolean;
  skillDiscoveryEnabled: boolean;
  skillSources: SkillSource[];
  createdAt: string;
  updatedAt: string;
  ticketSource: { integration: { id: string; name: string; provider: string; domainCapabilities: string[] } | null; ticketProjectKey: string } | null;
  reviewConfig: { integration: { id: string; name: string; provider: string; domainCapabilities: string[] } | null; repos: string[] } | null;
  pushTargetCount: number;
}

interface ProjectDetail extends ProjectSummary {
  agentOverrideJson: string | null;
  postCloneScript: string;
  gerritTopicOverride: string | null;
  useFullTicketUrlInCommits: boolean;
  postReviewLinkToTicket: boolean;
  reactToCiFailures: boolean;
  pushTargets: Array<{
    id: number;
    integration: { id: string; name: string; provider: string; domainCapabilities: string[] } | null;
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
    skillDiscoveryEnabled: project.skillDiscoveryEnabled,
    skillSources: parseStoredSkillSources(project),
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
    skillDiscoveryEnabled: project.skillDiscoveryEnabled,
    skillSources: parseStoredSkillSources(project),
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    agentOverrideJson: project.agentOverrideJson,
    postCloneScript: project.postCloneScript,
    gerritTopicOverride: project.gerritTopicOverride,
    useFullTicketUrlInCommits: project.useFullTicketUrlInCommits,
    postReviewLinkToTicket: project.postReviewLinkToTicket,
    reactToCiFailures: project.reactToCiFailures,
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

  router.add("GET", "/api/admin/projects", async (req, res, _params) => {
    if (!deps.projectStore) { writeJson(res, 501, { error: "Project store not available" }); return; }
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
        ...(data.skillDiscoveryEnabled !== undefined ? { skillDiscoveryEnabled: data.skillDiscoveryEnabled } : {}),
        skillSourcesJson: JSON.stringify(normalizeSkillSources(data.skillSources)),
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
    writeJson(res, 201, { project: detail });
    deps.onProjectChange?.();
    if (project.enabled) {
      await relaunchFailedTasksForProject(store, project.id, deps.taskControl);
    }
  }, { permission: "project.write" });

  // Enable or disable a project by id.
  router.add("PATCH", "/api/admin/projects/:id/enable", async (req, res, params) => {
    if (!deps.projectStore) { writeJson(res, 501, { error: "Project store not available" }); return; }
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
    if (!deps.projectStore) { writeJson(res, 501, { error: "Project store not available" }); return; }
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
    if (!deps.projectStore) { writeJson(res, 501, { error: "Project store not available" }); return; }
    const store = deps.projectStore;
    const id = makeProjectId(params["id"] ?? "");
    const existing = await store.getProjectById(id);
    if (!existing) { writeJson(res, 404, { error: "Project not found" }); return; }
    const integrations = await loadIntegrationsLookup(deps.integrationStore);
    const detail = await buildProjectDetail(existing, store, integrations);
    writeJson(res, 200, { project: detail });
  }, { permission: "project.read", resourceParam: "id" });

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
    if (data.skillDiscoveryEnabled !== undefined) updates.skillDiscoveryEnabled = data.skillDiscoveryEnabled;
    if (data.skillSources !== undefined) updates.skillSourcesJson = JSON.stringify(normalizeSkillSources(data.skillSources));
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
      updates.skillDiscoveryEnabled !== undefined ||
      updates.skillSourcesJson !== undefined ||
      (updates.enabled === true && existing.enabled !== true);
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
    if (!deps.projectStore) { writeJson(res, 501, { error: "Project store not available" }); return; }
    const store = deps.projectStore;
    const id = makeProjectId(params["id"] ?? "");
    const existing = await store.getProjectById(id);
    if (!existing) { writeJson(res, 404, { error: "Project not found" }); return; }
    try {
      await store.deleteProject(id);
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

// Re-export types for tests
export type { ProjectSummary, ProjectDetail };
