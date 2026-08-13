import { z } from "zod";
import { isAbsolute, normalize, sep } from "node:path";
import { getLogger } from "../logger.js";
import { recordAudit, type AuditCapableStore } from "./adminAudit.js";
import {
  makeAgentId,
  makeTaskId,
  type AgentId,
  type AgentRecord,
  type Integration,
  type IntegrationStore,
  type Prompt,
  type ProjectId,
  type ProjectPushTargetRecord,
  type ProjectRecord,
  type ProjectReviewConfig,
  type ProjectTicketSourceRecord,
  type ProjectVendorComponentInput,
  type ProjectVendorComponentRecord,
  type ProjectType,
  type PushTargetRole,
  type Task,
} from "../interfaces.js";
import { isConfiguredSshFilePathAllowed } from "../utils/sshFilePath.js";
import { getProviderDescriptor, getProviderDomainCapabilities } from "../plugins/registry.js";
import { ReviewStrategyConfigError, resolveReviewStrategy } from "../agents/reviewStrategy.js";

const log = getLogger("admin-projects");
export const MAX_TCP_PORT = 65_535;

export function isSkillSourceAuthError(message: string): boolean {
  return message.startsWith("SSH skill sources require")
    || message.startsWith("SSH private key path is not readable")
    || message.startsWith("SSH known_hosts path is not readable")
    || message.startsWith("Invalid SSH skill source URL")
    || message.startsWith("Conflicting SSH ports")
    || message.startsWith("SSH connection check failed")
    || message.startsWith("Skill source #")
    || message.startsWith("Failed to validate skill sources before saving");
}

export async function relaunchFailedTasksForProject(
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
    partial: Partial<Pick<ProjectRecord, "name" | "type" | "agentId" | "agentOverrideJson" | "postCloneScript" | "skillSourcesJson" | "gerritTopicOverride" | "useFullTicketUrlInCommits" | "postReviewLinkToTicket" | "reactToCiFailures" | "enabled">>
  ): Promise<ProjectRecord>;
  updateProjectConfiguration(
    id: ProjectId,
    input: {
      project: Partial<Pick<ProjectRecord, "name" | "type" | "agentId" | "agentOverrideJson" | "postCloneScript" | "skillSourcesJson" | "gerritTopicOverride" | "useFullTicketUrlInCommits" | "postReviewLinkToTicket" | "reactToCiFailures" | "enabled">>;
      ticketSource?: { integrationId: string; ticketProjectKey: string } | undefined;
      pushTargets?: Array<{
        integrationId: string;
        repoKey: string;
        cloneUrl: string;
        targetBranch: string;
        role: PushTargetRole;
        commitOrder: number;
        localPath: string;
        sshKeyPath?: string | null | undefined;
        reviewerEmails?: string[] | undefined;
      }> | undefined;
      reviewConfig?: { integrationId: string; repoKeys: string[] } | undefined;
    }
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
      reviewerEmails?: string[] | undefined;
    }>
  ): Promise<ProjectPushTargetRecord[]>;
  listProjectPushTargets(projectId: ProjectId): Promise<ProjectPushTargetRecord[]>;
  listProjectVendorComponents(projectId: ProjectId): Promise<ProjectVendorComponentRecord[]>;
  replaceProjectVendorComponents(
    projectId: ProjectId,
    inputs: ProjectVendorComponentInput[]
  ): Promise<ProjectVendorComponentRecord[]>;
  setProjectReviewConfig(
    projectId: ProjectId,
    integrationId: string,
    repoKeys: string[]
  ): Promise<void>;
  getProjectReviewConfig(projectId: ProjectId): Promise<ProjectReviewConfig | null>;
  getAgentById(id: AgentId): Promise<AgentRecord | null>;
  getPrompt(id: string): Promise<Prompt | null>;
  findProjectByTicketSource(integrationId: string, ticketProjectKey: string): Promise<ProjectRecord | null>;
  getFailedTasksForProject(projectId: ProjectId): Promise<Task[]>;
  retryTask(taskId: ReturnType<typeof makeTaskId>): Promise<Task>;
}

export interface ProjectsRouteDeps {
  projectStore?: ProjectsRouteStore | undefined;
  integrationStore?: IntegrationStore | undefined;
  pluginManager?: import("../plugins/pluginManager.js").PluginManager | undefined;
  adminAuthSecret?: string | undefined;
  auditStore?: AuditCapableStore | undefined;
  onProjectChange?: (() => void) | undefined;
  taskControl?:
    | {
        retryTask(taskId: ReturnType<typeof makeTaskId>): Promise<void>;
        deleteProject?(projectId: ProjectId): Promise<void>;
      }
    | undefined;
  validateSkillSourcesConnection?: ((sources: SkillSource[]) => Promise<void>) | undefined;
}

export function optionalSshFilePath(label: string): z.ZodOptional<z.ZodEffects<z.ZodString, string, string>> {
  return z.string()
    .trim()
    .min(1, `${label} must not be empty`)
    .refine(isConfiguredSshFilePathAllowed, `${label} must be inside an approved secrets directory`)
    .optional();
}

export const pushTargetSchema = z.object({
  integrationId: z.string().min(1, "VCS integration is required for each repository"),
  repoKey: z.string().min(1, "Repository must be selected"),
  cloneUrl: z.string().min(1, "Clone URL is required"),
  targetBranch: z.string().min(1, "Target branch is required"),
  role: z.enum(["primary", "submodule", "dependency", "related"]),
  commitOrder: z.number().int().min(1),
  localPath: z.string().min(1).refine(
    (value) => {
      if (isAbsolute(value)) return false;
      const normalized = normalize(value);
      return normalized !== ".." && !normalized.startsWith(`..${sep}`);
    },
    "localPath must stay within the project workspace",
  ).transform((value) => normalize(value)),
  sshKeyPath: optionalSshFilePath("SSH key path"),
  reviewerEmails: z.array(z.string().trim().email())
    .max(20, "At most 20 reviewer emails may be configured per repository")
    .transform((emails) => [...new Set(emails.map((email) => email.toLowerCase()))])
    .optional(),
});

/** Validate push-target arrays: unique localPaths, at most one root ("."). */
export const pushTargetsArraySchema = z.array(pushTargetSchema).min(1).superRefine((targets, ctx) => {
  const paths = targets.map((t) => normalize(t.localPath));
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

export const ticketSourceSchema = z.object({
  integrationId: z.string().min(1, "Ticket source integration is required"),
  ticketProjectKey: z.string().min(1, "Ticket source project is required"),
});

export const reviewConfigSchema = z.object({
  integrationId: z.string().min(1, "Review integration is required"),
  repoKeys: z.array(z.string()).min(1, "Select at least one repository to review"),
});

export function optionalNonEmptyString(message: string): z.ZodOptional<z.ZodString> {
  return z.string().trim().min(1, message).optional();
}

export const skillSourceSchema = z.object({
  source: z.string().trim().min(1, "Skill source is required"),
  skills: z.array(z.string().trim().min(1, "Skill name is required")).optional(),
  installAll: z.boolean().optional(),
  sshUser: optionalNonEmptyString("SSH user must not be empty"),
  sshPort: z.number().int().positive().max(MAX_TCP_PORT, "SSH port must be between 1 and 65535").optional(),
  sshKeyPath: optionalSshFilePath("SSH key path"),
  sshKnownHostsPath: optionalSshFilePath("SSH known_hosts path"),
}).superRefine((source, ctx) => {
  if (source.installAll === true) return;
  if ((source.skills ?? []).length > 0) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: "Select at least one skill, or enable Install all",
    path: ["skills"],
  });
});

export const skillSourcesSchema = z.array(skillSourceSchema).max(20, "At most 20 skill sources are supported");

export const skillSourceDiscoverySchema = z.object({
  source: z.string().trim().min(1, "Skill source is required"),
  sshUser: optionalNonEmptyString("SSH user must not be empty"),
  sshPort: z.number().int().positive().max(MAX_TCP_PORT, "SSH port must be between 1 and 65535").optional(),
  sshKeyPath: optionalSshFilePath("SSH key path"),
  sshKnownHostsPath: optionalSshFilePath("SSH known_hosts path"),
});

export const repositoryBindingResolutionSchema = z.object({
  repositories: z.array(z.object({
    cloneUrl: z.string().trim().min(1, "Clone URL is required"),
    localPath: z.string().trim().min(1, "Local path must not be empty").optional(),
  })).min(1, "At least one repository is required").max(100, "At most 100 repositories may be resolved at once"),
});

export const pushTargetScanSchema = z.object({
  integrationId: z.string().trim().min(1).max(512),
  repoKey: z.string().trim().min(1).max(512),
  cloneUrl: z.string().trim().min(1).max(2048),
  revision: z.string().trim().min(1).max(512).optional(),
});

export const vendorComponentArraySchema = z.array(z.object({
  sourcePath: z.string().trim().min(1, "Source path is required").max(1024),
  localPath: z.string().trim().max(1024).nullish(),
  cloneUrl: z.string().trim().max(2048).nullish(),
  revision: z.string().trim().max(512).nullish(),
  origin: z.enum(["internal", "fork_pushable", "patch_required", "ambiguous"]),
})).max(500, "At most 500 vendor components may be stored per project")
  .refine(
    (components) => new Set(components.map((component) => `${component.sourcePath}\u0000${component.localPath ?? ""}`)).size === components.length,
    { message: "Vendor components must be unique per source path and local path" },
  );

export const vendorComponentsSchema = z.object({
  components: vendorComponentArraySchema,
});

export function toVendorComponentInputs(
  components: z.infer<typeof vendorComponentArraySchema>
): ProjectVendorComponentInput[] {
  const optional = (value: string | null | undefined): string | null => (value?.trim() ? value.trim() : null);
  return components.map((component) => ({
    sourcePath: component.sourcePath,
    localPath: optional(component.localPath),
    cloneUrl: optional(component.cloneUrl),
    revision: optional(component.revision),
    origin: component.origin,
  }));
}

export interface SkillSource {
  source: string;
  skills: string[];
  installAll?: boolean;
  sshUser?: string;
  sshPort?: number;
  sshKeyPath?: string;
  sshKnownHostsPath?: string;
}

export function normalizeSkillSources(sources: z.infer<typeof skillSourcesSchema> | undefined): SkillSource[] {
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

export function skillSourcesForCreate(sources: z.infer<typeof skillSourcesSchema> | undefined): SkillSource[] {
  return normalizeSkillSources(sources);
}

export async function validateSkillSourcesForSave(
  sources: SkillSource[],
  validator: (sources: SkillSource[]) => Promise<void>
): Promise<void> {
  try {
    await validator(sources);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to validate skill sources before saving: ${message}`);
  }
}

/** Validate the agent execution dependency required by every project. */
export async function validateProjectAgent(
  agent: AgentRecord | null,
  projectType: ProjectType,
  integrationStore: IntegrationStore | undefined,
  requestedAgentId: string,
): Promise<string | null> {
  if (!agent) return `Agent not found: ${requestedAgentId}`;
  if (agent.type !== projectType) {
    return `Agent type mismatch: agent is '${agent.type}', project is '${projectType}'`;
  }
  if (!agent.enabled) return `Agent '${requestedAgentId}' is disabled`;

  const integrationId = agent.integrationId?.trim();
  if (!integrationId) return `Agent '${requestedAgentId}' has no linked integration`;
  if (!integrationStore) return "Agent integration store is not available";

  const integration = await integrationStore.getIntegration(integrationId);
  if (!integration) return `Agent integration '${integrationId}' not found`;
  if (!integration.enabled) return `Agent integration '${integrationId}' is disabled`;
  if (!getProviderDescriptor(integration.provider)?.capabilities.agent_execution) {
    return `Agent integration '${integrationId}' provider '${integration.provider}' does not support agent execution`;
  }
  return null;
}

export function parseStoredSkillSources(project: ProjectRecord): SkillSource[] {
  try {
    const parsed: unknown = JSON.parse(project.skillSourcesJson || "[]");
    const result = skillSourcesSchema.safeParse(parsed);
    return result.success ? normalizeSkillSources(result.data) : [];
  } catch {
    return [];
  }
}

function removedProjectField(fieldName: string): z.ZodOptional<z.ZodNever> {
  return z.never({
    errorMap: () => ({
      message: `${fieldName} has been removed; omit it from project payloads`,
    }),
  }).optional();
}

const removedLocalSkillsPathSchema = removedProjectField("localSkillsPath");
const removedSkillDiscoveryEnabledSchema = removedProjectField("skillDiscoveryEnabled");

export const codingProjectCreateSchema = z.object({
  id: z.string().optional(),
  type: z.literal("coding"),
  name: z.string().min(1, "Project name is required"),
  agentId: z.string().min(1, "Agent is required — create and enable a coding agent first (Agents tab)"),
  agentOverrideJson: z.string().nullable().optional(),
  postCloneScript: z.string().optional(),
  localSkillsPath: removedLocalSkillsPathSchema,
  skillSources: skillSourcesSchema.optional(),
  skillDiscoveryEnabled: removedSkillDiscoveryEnabledSchema,
  gerritTopicOverride: z.string().nullable().optional(),
  useFullTicketUrlInCommits: z.boolean().optional(),
  postReviewLinkToTicket: z.boolean().optional(),
  reactToCiFailures: z.boolean().optional(),
  enabled: z.boolean().optional(),
  ticketSource: ticketSourceSchema,
  pushTargets: pushTargetsArraySchema,
  vendorComponents: vendorComponentArraySchema.optional(),
});

export const reviewProjectCreateSchema = z.object({
  id: z.string().optional(),
  type: z.literal("review"),
  name: z.string().min(1, "Project name is required"),
  agentId: z.string().min(1, "Agent is required — create and enable a review agent first (Agents tab)"),
  agentOverrideJson: z.string().nullable().optional(),
  postCloneScript: z.string().optional(),
  localSkillsPath: removedLocalSkillsPathSchema,
  skillSources: skillSourcesSchema.optional(),
  skillDiscoveryEnabled: removedSkillDiscoveryEnabledSchema,
  gerritTopicOverride: z.string().nullable().optional(),
  useFullTicketUrlInCommits: z.boolean().optional(),
  postReviewLinkToTicket: z.boolean().optional(),
  reactToCiFailures: z.boolean().optional(),
  enabled: z.boolean().optional(),
  reviewConfig: reviewConfigSchema,
});

export const projectCreateSchema = z.discriminatedUnion("type", [
  codingProjectCreateSchema,
  reviewProjectCreateSchema,
]);

export const projectUpdateSchema = z.object({
  name: z.string().min(1, "Project name is required").optional(),
  agentId: z.string().min(1, "Agent is required").optional(),
  agentOverrideJson: z.string().nullable().optional(),
  postCloneScript: z.string().optional(),
  localSkillsPath: removedLocalSkillsPathSchema,
  skillSources: skillSourcesSchema.optional(),
  skillDiscoveryEnabled: removedSkillDiscoveryEnabledSchema,
  gerritTopicOverride: z.string().nullable().optional(),
  useFullTicketUrlInCommits: z.boolean().optional(),
  postReviewLinkToTicket: z.boolean().optional(),
  reactToCiFailures: z.boolean().optional(),
  enabled: z.boolean().optional(),
  ticketSource: ticketSourceSchema.optional(),
  pushTargets: pushTargetsArraySchema.optional(),
  reviewConfig: reviewConfigSchema.optional(),
});

export interface IntegrationLookup {
  byId: Map<string, Integration>;
}

/** Load all integrations from the store and index them by id. */
export async function loadIntegrationsLookup(store: IntegrationStore | undefined): Promise<IntegrationLookup> {
  const byId = new Map<string, Integration>();
  if (store) {
    const all = await store.getIntegrations();
    for (const i of all) byId.set(i.id, i);
  }
  return { byId };
}

/** Integration types that use HTTPS for cloning — SSH URLs are invalid for these. */
const HTTPS_ONLY_VCS_TYPES = new Set(["github", "gitlab"]);
const REVIEWER_EMAIL_VCS_TYPES = new Set(["gerrit", "gitlab"]);

/**
 * Validate that push targets for HTTPS-based integrations (GitHub, GitLab) do
 * not use SSH clone URLs (`git@...`). Returns an error message or null.
 */
export async function validatePushTargetCloneUrls(
  targets: Array<{ integrationId: string; cloneUrl: string; repoKey: string }>,
  integrationStore: IntegrationStore | undefined
): Promise<string | null> {
  if (!integrationStore) return null;
  for (const target of targets) {
    let usesSsh = target.cloneUrl.startsWith("git@");
    try {
      usesSsh ||= new URL(target.cloneUrl).protocol === "ssh:";
    } catch {
      // Non-URL clone forms are handled by the explicit scp-style check.
    }
    if (!usesSsh) continue;
    const integration = await integrationStore.getIntegration(target.integrationId).catch(() => null);
    if (integration && HTTPS_ONLY_VCS_TYPES.has(integration.provider)) {
      return `Push target "${target.repoKey}" uses an SSH clone URL (${target.cloneUrl}) which is not supported for ${integration.provider} integrations. Use an HTTPS URL instead (e.g. https://github.com/owner/repo.git).`;
    }
  }
  return null;
}

export async function validatePushTargetReviewerEmails(
  targets: Array<{ integrationId: string; repoKey: string; reviewerEmails?: string[] | undefined }>,
  integrationStore: IntegrationStore | undefined
): Promise<string | null> {
  if (!integrationStore) return null;
  for (const target of targets) {
    if (!target.reviewerEmails || target.reviewerEmails.length === 0) continue;
    const integration = await integrationStore.getIntegration(target.integrationId).catch(() => null);
    if (integration && !REVIEWER_EMAIL_VCS_TYPES.has(integration.provider)) {
      return `Reviewer emails are not supported for ${integration.provider} push target "${target.repoKey}"`;
    }
  }
  return null;
}

/** Return a minimal integration descriptor object for embedding in project API responses. */
export function describeIntegration(
  integ: Integration | undefined,
): { id: string; name: string; provider: string; domainCapabilities: string[] } | null {
  if (!integ) return null;
  const descriptor = getProviderDescriptor(integ.provider);
  const domainCapabilities = descriptor ? getProviderDomainCapabilities(descriptor) : [];
  return { id: integ.id, name: integ.name, provider: integ.provider, domainCapabilities };
}

export interface ProjectSummary {
  id: string;
  name: string;
  type: ProjectRecord["type"];
  agentId: string;
  agentName: string | null;
  enabled: boolean;
  skillSources: SkillSource[];
  createdAt: string;
  updatedAt: string;
  ticketSource: { integration: { id: string; name: string; provider: string; domainCapabilities: string[] } | null; ticketProjectKey: string } | null;
  reviewConfig: { integration: { id: string; name: string; provider: string; domainCapabilities: string[] } | null; repos: string[] } | null;
  pushTargetCount: number;
}

export interface ProjectDetail extends ProjectSummary {
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
    reviewerEmails: string[];
  }>
}

/** Build the summary API shape for a project including ticket source and review config metadata. */
export async function buildProjectSummary(
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
    skillSources: parseStoredSkillSources(project),
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    ticketSource,
    reviewConfig,
    pushTargetCount,
  };
}

/** Build the full detail API shape for a project including push targets and all child records. */
export async function buildProjectDetail(
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
      reviewerEmails: p.reviewerEmails,
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
export function isUniqueConflict(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message;
  return m.includes("already claimed by project") || /UNIQUE constraint/i.test(m);
}

export async function validateAgentOverrideJson(
  store: Pick<ProjectsRouteStore, "getPrompt">,
  json: string | null,
  agent: AgentRecord,
): Promise<string | null> {
  if (json === null) return null;

  let override: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "Agent override must be a JSON object";
    }
    override = parsed as Record<string, unknown>;
  } catch {
    return "Agent override must be valid JSON";
  }

  let agentConfig: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(agent.modelConfigJson);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      agentConfig = parsed as Record<string, unknown>;
    }
  } catch {
    // Existing malformed agent config remains a runtime validation concern.
  }
  let reviewStrategy;
  try {
    reviewStrategy = resolveReviewStrategy(agentConfig);
  } catch (err: unknown) {
    if (err instanceof ReviewStrategyConfigError) return err.message;
    throw err;
  }
  if (reviewStrategy === "copilot_native") {
    const rawProviderOptions = override["providerOptions"];
    const providerOptions = rawProviderOptions !== null
      && typeof rawProviderOptions === "object"
      && !Array.isArray(rawProviderOptions)
      ? rawProviderOptions as Record<string, unknown>
      : {};
    const conflict = ["model", "systemPromptId", "reviewStrategy", "reasoningEffort"].find((field) =>
      override[field] !== undefined || providerOptions[field] !== undefined
    );
    if (conflict !== undefined) {
      return `Copilot native review does not allow project override '${conflict}'`;
    }
  }

  const promptFields = [
    ["systemPromptId", "system", "a System Prompt"],
    ["instructionsPromptId", "instructions", "an Instructions Prompt"],
    ["feedbackInstructionsPromptId", "instructions", "an Instructions Prompt"],
  ] as const;

  for (const [field, role, label] of promptFields) {
    const value = override[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || value.trim().length === 0) {
      return `Agent override '${field}' must be a non-empty prompt ID`;
    }
    const prompt = await store.getPrompt(value);
    if (!prompt) return `Prompt '${value}' not found`;
    if (prompt.promptType !== role) return `Prompt '${value}' is not ${label}`;
  }

  return null;
}

// recordAudit re-exported for convenience of route modules that only import from this shared file.
export { recordAudit };
