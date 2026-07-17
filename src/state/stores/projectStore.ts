import type Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type {
  AgentId,
  DomainCapability,
  ProjectId,
  ProjectIntegrationBindingRecord,
  ProjectPushTargetRecord,
  ProjectRecord,
  ProjectReviewConfig,
  ProjectTicketSourceRecord,
  ProjectType,
  PushTargetRole,
} from "../../interfaces.js";
import { TERMINAL_STATES } from "../../interfaces.js";
import {
  agents,
  projectIntegrationBindings,
  projectPushTargets,
  projects,
} from "../schema.js";
import * as schema from "../schema.js";

export interface ProjectStoreApi {
  createProject(input: {
    id?: string;
    name: string;
    type: ProjectType;
    agentId: AgentId;
    agentOverrideJson?: string | null;
    postCloneScript?: string;
    skillDiscoveryEnabled?: boolean;
    enabled?: boolean;
  }): Promise<ProjectRecord>;
  getProjectById(id: ProjectId): Promise<ProjectRecord | null>;
  listProjects(filter?: { type?: ProjectType; enabled?: boolean }): Promise<ProjectRecord[]>;
  updateProject(
    id: ProjectId,
    partial: Partial<Pick<ProjectRecord, "name" | "type" | "agentId" | "agentOverrideJson" | "postCloneScript" | "skillDiscoveryEnabled" | "enabled">>
  ): Promise<ProjectRecord>;
  updateProjectConfiguration(
    id: ProjectId,
    input: {
      project: Partial<Pick<ProjectRecord, "name" | "type" | "agentId" | "agentOverrideJson" | "postCloneScript" | "skillDiscoveryEnabled" | "enabled">>;
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
      }> | undefined;
      reviewConfig?: { integrationId: string; repoKeys: string[] } | undefined;
    }
  ): Promise<ProjectRecord>;
  deleteProject(id: ProjectId): Promise<void>;
  adoptOrphanedTasksForProject(projectId: ProjectId, integrationId: string, ticketProjectKey: string): number;
  setProjectEnabled(id: ProjectId, enabled: boolean): Promise<void>;
  setProjectTicketSource(
    projectId: ProjectId,
    input: { integrationId: string; ticketProjectKey: string }
  ): Promise<ProjectTicketSourceRecord>;
  getProjectTicketSource(projectId: ProjectId): Promise<ProjectTicketSourceRecord | null>;
  findProjectByTicketSource(integrationId: string, ticketProjectKey: string): Promise<ProjectRecord | null>;
  addProjectPushTarget(
    projectId: ProjectId,
    input: {
      integrationId: string;
      repoKey: string;
      cloneUrl: string;
      targetBranch: string;
      role: PushTargetRole;
      commitOrder: number;
      localPath: string;
      sshKeyPath?: string | null;
    }
  ): Promise<ProjectPushTargetRecord>;
  listProjectPushTargets(projectId: ProjectId): Promise<ProjectPushTargetRecord[]>;
  removeProjectPushTarget(id: number): Promise<void>;
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
      sshKeyPath?: string | null;
    }>
  ): Promise<ProjectPushTargetRecord[]>;
  setProjectReviewConfig(projectId: ProjectId, integrationId: string, repoKeys: string[]): Promise<void>;
  getProjectReviewConfig(projectId: ProjectId): Promise<ProjectReviewConfig | null>;
  findProjectsByReviewTarget(integrationId: string, repoKey: string): Promise<ProjectRecord[]>;
  getProjectBinding(projectId: ProjectId, capability: DomainCapability): Promise<ProjectIntegrationBindingRecord | null>;
  listProjectBindings(projectId: ProjectId): Promise<ProjectIntegrationBindingRecord[]>;
  deleteProjectBinding(projectId: ProjectId, capability: DomainCapability): Promise<void>;
}

interface ProjectStoreContext {
  db: BetterSQLite3Database<typeof schema>;
  raw: Database.Database;
}

export function createProjectStore(context: ProjectStoreContext): ProjectStoreApi {
  const { db, raw } = context;

  function rowToProject(row: typeof projects.$inferSelect): ProjectRecord {
    return {
      id: row.id as ProjectId,
      name: row.name,
      type: row.type,
      agentId: row.agentId as AgentId,
      agentOverrideJson: row.agentOverrideJson ?? null,
      postCloneScript: row.postCloneScript,
      skillDiscoveryEnabled: row.skillDiscoveryEnabled === 1,
      enabled: row.enabled === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  function rowToBinding(row: typeof projectIntegrationBindings.$inferSelect): ProjectIntegrationBindingRecord {
    let config: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.configJson) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      config = {};
    }
    return {
      id: row.id,
      projectId: row.projectId as ProjectId,
      integrationId: row.integrationId,
      capability: row.capability,
      config,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  function rowToProjectPushTarget(row: typeof projectPushTargets.$inferSelect): ProjectPushTargetRecord {
    return {
      id: row.id,
      projectId: row.projectId as ProjectId,
      integrationId: row.integrationId,
      repoKey: row.repoKey,
      cloneUrl: row.cloneUrl,
      targetBranch: row.targetBranch,
      role: row.role,
      commitOrder: row.commitOrder,
      localPath: row.localPath,
      sshKeyPath: row.sshKeyPath ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async function getProjectById(id: ProjectId): Promise<ProjectRecord | null> {
    const row = await db.query.projects.findFirst({ where: eq(projects.id, id) });
    return row ? rowToProject(row) : null;
  }

  async function createProject(input: {
    id?: string;
    name: string;
    type: ProjectType;
    agentId: AgentId;
    agentOverrideJson?: string | null;
    postCloneScript?: string;
    skillDiscoveryEnabled?: boolean;
    enabled?: boolean;
  }): Promise<ProjectRecord> {
    const now = new Date();
    const id = input.id ?? randomUUID();
    const agent = await db.query.agents.findFirst({
      where: eq(agents.id, input.agentId),
    });
    if (!agent) throw new Error(`Cannot create project: agent not found: ${input.agentId}`);
    await db.insert(projects).values({
      id,
      name: input.name,
      type: input.type,
      agentId: input.agentId,
      agentOverrideJson: input.agentOverrideJson ?? null,
      postCloneScript: input.postCloneScript ?? "",
      skillDiscoveryEnabled: input.skillDiscoveryEnabled === true ? 1 : 0,
      enabled: input.enabled === false ? 0 : 1,
      createdAt: now,
      updatedAt: now,
    });
    const created = await getProjectById(id as ProjectId);
    if (!created) throw new Error(`Failed to create project ${id}`);
    return created;
  }

  async function listProjects(filter?: { type?: ProjectType; enabled?: boolean }): Promise<ProjectRecord[]> {
    const rows = await db.query.projects.findMany({
      orderBy: (table, { asc }) => [asc(table.name)],
    });
    let result = rows.map((row) => rowToProject(row));
    if (filter?.type !== undefined) result = result.filter((project) => project.type === filter.type);
    if (filter?.enabled !== undefined) result = result.filter((project) => project.enabled === filter.enabled);
    return result;
  }

  function updateProjectRow(
    id: ProjectId,
    partial: Partial<Pick<ProjectRecord, "name" | "type" | "agentId" | "agentOverrideJson" | "postCloneScript" | "skillDiscoveryEnabled" | "enabled">>
  ): void {
    const existing = raw.prepare("SELECT agent_id FROM projects WHERE id = ?").get(id) as
      | { agent_id: string }
      | undefined;
    if (!existing) throw new Error(`Project not found: ${id}`);

    if (partial.agentId !== undefined) {
      const agent = raw.prepare("SELECT 1 FROM agents WHERE id = ?").get(partial.agentId);
      if (!agent) throw new Error(`Cannot update project: agent not found: ${partial.agentId}`);
      if (partial.agentId !== existing.agent_id) {
        const terminalPlaceholders = [...TERMINAL_STATES].map(() => "?").join(", ");
        const activeTask = raw.prepare(
          `SELECT 1 FROM tasks WHERE project_id = ? AND state NOT IN (${terminalPlaceholders}) LIMIT 1`
        ).get(id, ...TERMINAL_STATES);
        if (activeTask) {
          const error = new Error("Cannot change the project agent while tasks are active") as Error & { code: string };
          error.code = "ACTIVE_TASKS";
          throw error;
        }
      }
    }

    const assignments = ["updated_at = ?"];
    const values: unknown[] = [Math.floor(Date.now() / 1000)];
    const add = (column: string, value: unknown): void => {
      assignments.push(`${column} = ?`);
      values.push(value);
    };
    if (partial.name !== undefined) add("name", partial.name);
    if (partial.type !== undefined) add("type", partial.type);
    if (partial.agentId !== undefined) add("agent_id", partial.agentId);
    if (partial.agentOverrideJson !== undefined) add("agent_override_json", partial.agentOverrideJson);
    if (partial.postCloneScript !== undefined) add("post_clone_script", partial.postCloneScript);
    if (partial.skillDiscoveryEnabled !== undefined) add("skill_discovery_enabled", partial.skillDiscoveryEnabled ? 1 : 0);
    if (partial.enabled !== undefined) add("enabled", partial.enabled ? 1 : 0);
    raw.prepare(`UPDATE projects SET ${assignments.join(", ")} WHERE id = ?`).run(...values, id);
  }

  async function updateProject(
    id: ProjectId,
    partial: Partial<Pick<ProjectRecord, "name" | "type" | "agentId" | "agentOverrideJson" | "postCloneScript" | "skillDiscoveryEnabled" | "enabled">>
  ): Promise<ProjectRecord> {
    raw.transaction(() => updateProjectRow(id, partial))();
    const updated = await getProjectById(id);
    if (!updated) throw new Error(`Project disappeared after update: ${id}`);
    return updated;
  }

  async function updateProjectConfiguration(
    id: ProjectId,
    input: Parameters<ProjectStoreApi["updateProjectConfiguration"]>[1]
  ): Promise<ProjectRecord> {
    raw.transaction(() => {
      const currentProject = raw.prepare(
        "SELECT agent_id, agent_override_json, post_clone_script, skill_discovery_enabled FROM projects WHERE id = ?"
      ).get(id) as {
        agent_id: string;
        agent_override_json: string | null;
        post_clone_script: string;
        skill_discovery_enabled: number;
      } | undefined;
      if (!currentProject) throw new Error(`Project not found: ${id}`);

      const currentTicketSource = raw.prepare(
        "SELECT integration_id, config_json FROM project_integration_bindings " +
        "WHERE project_id = ? AND capability = 'issue_tracking'"
      ).get(id) as { integration_id: string; config_json: string } | undefined;
      const currentReviewConfig = raw.prepare(
        "SELECT integration_id, config_json FROM project_integration_bindings " +
        "WHERE project_id = ? AND capability = 'code_review'"
      ).get(id) as { integration_id: string; config_json: string } | undefined;
      const currentPushTargets = raw.prepare(
        "SELECT integration_id, repo_key, clone_url, target_branch, role, commit_order, local_path, ssh_key_path " +
        "FROM project_push_targets WHERE project_id = ? ORDER BY commit_order, local_path"
      ).all(id) as Array<{
        integration_id: string;
        repo_key: string;
        clone_url: string;
        target_branch: string;
        role: string;
        commit_order: number;
        local_path: string;
        ssh_key_path: string | null;
      }>;
      const parseConfig = (value: string | undefined): Record<string, unknown> => {
        if (value === undefined) return {};
        try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; }
      };
      const ticketConfig = parseConfig(currentTicketSource?.config_json);
      const reviewConfig = parseConfig(currentReviewConfig?.config_json);
      const normalizePushTargets = (targets: typeof input.pushTargets): string => JSON.stringify(
        (targets ?? []).map((target) => ({
          integrationId: target.integrationId,
          repoKey: target.repoKey,
          cloneUrl: target.cloneUrl,
          targetBranch: target.targetBranch,
          role: target.role,
          commitOrder: target.commitOrder,
          localPath: target.localPath,
          sshKeyPath: target.sshKeyPath ?? null,
        })).sort((left, right) => left.commitOrder - right.commitOrder || left.localPath.localeCompare(right.localPath))
      );
      const persistedPushTargets = JSON.stringify(currentPushTargets.map((target) => ({
        integrationId: target.integration_id,
        repoKey: target.repo_key,
        cloneUrl: target.clone_url,
        targetBranch: target.target_branch,
        role: target.role,
        commitOrder: target.commit_order,
        localPath: target.local_path,
        sshKeyPath: target.ssh_key_path,
      })));
      const changesExecutionIdentity =
        (input.project.agentId !== undefined && input.project.agentId !== currentProject.agent_id) ||
        (input.project.agentOverrideJson !== undefined && input.project.agentOverrideJson !== currentProject.agent_override_json) ||
        (input.project.postCloneScript !== undefined && input.project.postCloneScript !== currentProject.post_clone_script) ||
        (input.project.skillDiscoveryEnabled !== undefined && input.project.skillDiscoveryEnabled !== (currentProject.skill_discovery_enabled === 1)) ||
        (input.ticketSource !== undefined && (
          input.ticketSource.integrationId !== currentTicketSource?.integration_id ||
          input.ticketSource.ticketProjectKey !== ticketConfig["ticketProjectKey"]
        )) ||
        (input.pushTargets !== undefined && normalizePushTargets(input.pushTargets) !== persistedPushTargets) ||
        (input.reviewConfig !== undefined && (
          input.reviewConfig.integrationId !== currentReviewConfig?.integration_id ||
          JSON.stringify([...input.reviewConfig.repoKeys].sort()) !==
            JSON.stringify(Array.isArray(reviewConfig["repos"]) ? [...reviewConfig["repos"]].sort() : [])
        ));
      if (changesExecutionIdentity) {
        const terminalPlaceholders = [...TERMINAL_STATES].map(() => "?").join(", ");
        const activeTask = raw.prepare(
          `SELECT 1 FROM tasks WHERE project_id = ? AND state NOT IN (${terminalPlaceholders}) LIMIT 1`
        ).get(id, ...TERMINAL_STATES);
        if (activeTask) {
          const error = new Error("Cannot reconfigure a project while tasks are active") as Error & { code: string };
          error.code = "ACTIVE_TASKS";
          throw error;
        }
      }
      updateProjectRow(id, input.project);
      const nowSeconds = Math.floor(Date.now() / 1000);

      if (input.ticketSource !== undefined) {
        const conflict = raw
          .prepare(
            "SELECT project_id FROM project_integration_bindings " +
            "WHERE capability = 'issue_tracking' AND integration_id = ? " +
            "AND json_extract(config_json, '$.ticketProjectKey') = ? AND project_id != ?"
          )
          .get(input.ticketSource.integrationId, input.ticketSource.ticketProjectKey, id) as
            | { project_id: string }
            | undefined;
        if (conflict) {
          throw new Error(
            `Ticket source (${input.ticketSource.integrationId}, ${input.ticketSource.ticketProjectKey}) ` +
            `is already claimed by project ${conflict.project_id}`
          );
        }
        raw
          .prepare("DELETE FROM project_integration_bindings WHERE project_id = ? AND capability = 'issue_tracking'")
          .run(id);
        raw
          .prepare(
            "INSERT INTO project_integration_bindings (id, project_id, integration_id, capability, config_json, created_at, updated_at) " +
            "VALUES (?, ?, ?, 'issue_tracking', ?, ?, ?)"
          )
          .run(
            randomUUID(),
            id,
            input.ticketSource.integrationId,
            JSON.stringify({ ticketProjectKey: input.ticketSource.ticketProjectKey }),
            nowSeconds,
            nowSeconds,
          );
        adoptOrphanedTasksForProject(id, input.ticketSource.integrationId, input.ticketSource.ticketProjectKey);
      }

      if (input.pushTargets !== undefined) {
        raw.prepare("DELETE FROM project_push_targets WHERE project_id = ?").run(id);
        const statement = raw.prepare(
          `INSERT INTO project_push_targets
           (project_id, integration_id, repo_key, clone_url, target_branch, role, commit_order, local_path, ssh_key_path, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const target of input.pushTargets) {
          statement.run(
            id,
            target.integrationId,
            target.repoKey,
            target.cloneUrl,
            target.targetBranch,
            target.role,
            target.commitOrder,
            target.localPath,
            target.sshKeyPath ?? null,
            nowSeconds,
            nowSeconds,
          );
        }
      }

      if (input.reviewConfig !== undefined) {
        raw
          .prepare("DELETE FROM project_integration_bindings WHERE project_id = ? AND capability = 'code_review'")
          .run(id);
        raw
          .prepare(
            "INSERT INTO project_integration_bindings (id, project_id, integration_id, capability, config_json, created_at, updated_at) " +
            "VALUES (?, ?, ?, 'code_review', ?, ?, ?)"
          )
          .run(
            randomUUID(),
            id,
            input.reviewConfig.integrationId,
            JSON.stringify({ repos: input.reviewConfig.repoKeys }),
            nowSeconds,
            nowSeconds,
          );
      }
    })();

    const updated = await getProjectById(id);
    if (!updated) throw new Error(`Project disappeared after update: ${id}`);
    return updated;
  }

  async function deleteProject(id: ProjectId): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const reason = `project ${id} deleted while tasks were still active`;
    const placeholders = [...TERMINAL_STATES].map(() => "?").join(", ");
    raw.transaction(() => {
      const ticketBinding = raw
        .prepare(
          "SELECT integration_id, config_json FROM project_integration_bindings WHERE project_id = ? AND capability = 'issue_tracking'"
        )
        .get(id) as { integration_id: string; config_json: string } | undefined;
      if (ticketBinding) {
        let ticketProjectKey = "";
        try {
          const cfg = JSON.parse(ticketBinding.config_json) as { ticketProjectKey?: unknown };
          if (typeof cfg.ticketProjectKey === "string") ticketProjectKey = cfg.ticketProjectKey;
        } catch {
          ticketProjectKey = "";
        }
        raw
          .prepare(
            "UPDATE tasks SET ticket_source_integration_id = COALESCE(ticket_source_integration_id, ?), " +
            "ticket_source_project_key = COALESCE(ticket_source_project_key, ?), updated_at = ? " +
            "WHERE project_id = ?"
          )
          .run(ticketBinding.integration_id, ticketProjectKey, now, id);
      }
      raw
        .prepare(
          `UPDATE tasks SET state = 'ABANDONED', failure_reason = ?, updated_at = ? ` +
          `WHERE project_id = ? AND state NOT IN (${placeholders})`
        )
        .run(reason, now, id, ...TERMINAL_STATES);
      raw
        .prepare("UPDATE tasks SET project_id = NULL, updated_at = ? WHERE project_id = ?")
        .run(now, id);
      raw.prepare("DELETE FROM project_integration_bindings WHERE project_id = ?").run(id);
      raw.prepare("DELETE FROM project_push_targets WHERE project_id = ?").run(id);
      raw.prepare("DELETE FROM projects WHERE id = ?").run(id);
    })();
  }

  function adoptOrphanedTasksForProject(
    projectId: ProjectId,
    integrationId: string,
    ticketProjectKey: string
  ): number {
    const now = Math.floor(Date.now() / 1000);
    const result = raw
      .prepare(
        "UPDATE tasks SET project_id = ?, updated_at = ? " +
        "WHERE project_id IS NULL " +
        "AND ticket_source_integration_id = ? " +
        "AND ticket_source_project_key = ?"
      )
      .run(projectId as string, now, integrationId, ticketProjectKey);
    return Number(result.changes ?? 0);
  }

  async function setProjectEnabled(id: ProjectId, enabled: boolean): Promise<void> {
    const existing = await getProjectById(id);
    if (!existing) throw new Error(`Project not found: ${id}`);
    await db
      .update(projects)
      .set({ enabled: enabled ? 1 : 0, updatedAt: new Date() })
      .where(eq(projects.id, id));
  }

  async function setProjectTicketSource(
    projectId: ProjectId,
    input: { integrationId: string; ticketProjectKey: string }
  ): Promise<ProjectTicketSourceRecord> {
    const now = new Date();
    const nowSeconds = Math.floor(now.getTime() / 1000);
    return raw.transaction((): ProjectTicketSourceRecord => {
      const conflict = raw
        .prepare(
          "SELECT project_id FROM project_integration_bindings " +
          "WHERE capability = 'issue_tracking' AND integration_id = ? " +
          "AND json_extract(config_json, '$.ticketProjectKey') = ? AND project_id != ?"
        )
        .get(input.integrationId, input.ticketProjectKey, projectId) as { project_id: string } | undefined;
      if (conflict) {
        throw new Error(
          `Ticket source (${input.integrationId}, ${input.ticketProjectKey}) is already claimed by project ${conflict.project_id}`
        );
      }
      raw
        .prepare("DELETE FROM project_integration_bindings WHERE project_id = ? AND capability = 'issue_tracking'")
        .run(projectId);
      const configJson = JSON.stringify({ ticketProjectKey: input.ticketProjectKey });
      raw
        .prepare(
          "INSERT INTO project_integration_bindings (id, project_id, integration_id, capability, config_json, created_at, updated_at) " +
          "VALUES (?, ?, ?, 'issue_tracking', ?, ?, ?)"
        )
        .run(randomUUID(), projectId, input.integrationId, configJson, nowSeconds, nowSeconds);
      adoptOrphanedTasksForProject(projectId, input.integrationId, input.ticketProjectKey);
      return {
        id: 0,
        projectId,
        integrationId: input.integrationId,
        ticketProjectKey: input.ticketProjectKey,
        createdAt: now,
      };
    })();
  }

  async function getProjectTicketSource(projectId: ProjectId): Promise<ProjectTicketSourceRecord | null> {
    const binding = await getProjectBinding(projectId, "issue_tracking");
    if (!binding) return null;
    const ticketProjectKey = typeof binding.config["ticketProjectKey"] === "string"
      ? (binding.config["ticketProjectKey"] as string)
      : "";
    return {
      id: 0,
      projectId,
      integrationId: binding.integrationId,
      ticketProjectKey,
      createdAt: binding.createdAt,
    };
  }

  async function findProjectByTicketSource(integrationId: string, ticketProjectKey: string): Promise<ProjectRecord | null> {
    const row = raw
      .prepare(
        "SELECT project_id FROM project_integration_bindings " +
        "WHERE capability = 'issue_tracking' AND integration_id = ? " +
        "AND json_extract(config_json, '$.ticketProjectKey') = ? LIMIT 1"
      )
      .get(integrationId, ticketProjectKey) as { project_id: string } | undefined;
    if (!row) return null;
    return getProjectById(row.project_id as ProjectId);
  }

  async function addProjectPushTarget(
    projectId: ProjectId,
    input: {
      integrationId: string;
      repoKey: string;
      cloneUrl: string;
      targetBranch: string;
      role: PushTargetRole;
      commitOrder: number;
      localPath: string;
      sshKeyPath?: string | null;
    }
  ): Promise<ProjectPushTargetRecord> {
    const now = new Date();
    const result = raw
      .prepare(
        `INSERT INTO project_push_targets
         (project_id, integration_id, repo_key, clone_url, target_branch, role, commit_order, local_path, ssh_key_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        projectId,
        input.integrationId,
        input.repoKey,
        input.cloneUrl,
        input.targetBranch,
        input.role,
        input.commitOrder,
        input.localPath,
        input.sshKeyPath ?? null,
        Math.floor(now.getTime() / 1000),
        Math.floor(now.getTime() / 1000)
      );
    const id = Number(result.lastInsertRowid);
    const row = await db.query.projectPushTargets.findFirst({
      where: eq(projectPushTargets.id, id),
    });
    if (!row) throw new Error(`Failed to create push target on project ${projectId}`);
    return rowToProjectPushTarget(row);
  }

  async function listProjectPushTargets(projectId: ProjectId): Promise<ProjectPushTargetRecord[]> {
    const rows = await db.query.projectPushTargets.findMany({
      where: eq(projectPushTargets.projectId, projectId),
      orderBy: (table, { asc }) => [asc(table.commitOrder)],
    });
    return rows.map((row) => rowToProjectPushTarget(row));
  }

  async function removeProjectPushTarget(id: number): Promise<void> {
    await db.delete(projectPushTargets).where(eq(projectPushTargets.id, id));
  }

  async function replaceProjectPushTargets(
    projectId: ProjectId,
    inputs: Array<{
      integrationId: string;
      repoKey: string;
      cloneUrl: string;
      targetBranch: string;
      role: PushTargetRole;
      commitOrder: number;
      localPath: string;
      sshKeyPath?: string | null;
    }>
  ): Promise<ProjectPushTargetRecord[]> {
    const now = new Date();
    raw.transaction(() => {
      raw.prepare("DELETE FROM project_push_targets WHERE project_id = ?").run(projectId);
      const statement = raw.prepare(
        `INSERT INTO project_push_targets
         (project_id, integration_id, repo_key, clone_url, target_branch, role, commit_order, local_path, ssh_key_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const input of inputs) {
        statement.run(
          projectId,
          input.integrationId,
          input.repoKey,
          input.cloneUrl,
          input.targetBranch,
          input.role,
          input.commitOrder,
          input.localPath,
          input.sshKeyPath ?? null,
          Math.floor(now.getTime() / 1000),
          Math.floor(now.getTime() / 1000)
        );
      }
    })();
    return listProjectPushTargets(projectId);
  }

  async function setProjectReviewConfig(
    projectId: ProjectId,
    integrationId: string,
    repoKeys: string[]
  ): Promise<void> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    raw.transaction((): void => {
      raw
        .prepare("DELETE FROM project_integration_bindings WHERE project_id = ? AND capability = 'code_review'")
        .run(projectId);
      const configJson = JSON.stringify({ repos: repoKeys });
      raw
        .prepare(
          "INSERT INTO project_integration_bindings (id, project_id, integration_id, capability, config_json, created_at, updated_at) " +
          "VALUES (?, ?, ?, 'code_review', ?, ?, ?)"
        )
        .run(randomUUID(), projectId, integrationId, configJson, nowSeconds, nowSeconds);
    })();
  }

  async function getProjectReviewConfig(projectId: ProjectId): Promise<ProjectReviewConfig | null> {
    const binding = await getProjectBinding(projectId, "code_review");
    if (!binding) return null;
    const repos = Array.isArray(binding.config["repos"])
      ? (binding.config["repos"] as unknown[]).filter((r): r is string => typeof r === "string")
      : [];
    return {
      integrationId: binding.integrationId,
      repos,
    };
  }

  async function findProjectsByReviewTarget(integrationId: string, repoKey: string): Promise<ProjectRecord[]> {
    const rows = raw
      .prepare(
        `SELECT p.id FROM projects p
         JOIN project_integration_bindings pib ON pib.project_id = p.id
         WHERE pib.capability = 'code_review'
           AND pib.integration_id = ?
           AND EXISTS (
             SELECT 1 FROM json_each(json_extract(pib.config_json, '$.repos'))
             WHERE json_each.value = ?
           )
           AND p.enabled = 1`
      )
      .all(integrationId, repoKey) as Array<{ id: string }>;
    const results: ProjectRecord[] = [];
    for (const row of rows) {
      const project = await getProjectById(row.id as ProjectId);
      if (project) results.push(project);
    }
    return results;
  }

  async function getProjectBinding(
    projectId: ProjectId,
    capability: DomainCapability
  ): Promise<ProjectIntegrationBindingRecord | null> {
    const row = await db.query.projectIntegrationBindings.findFirst({
      where: (table, { and, eq: eqOp }) => and(eqOp(table.projectId, projectId), eqOp(table.capability, capability)),
    });
    return row ? rowToBinding(row) : null;
  }

  async function listProjectBindings(projectId: ProjectId): Promise<ProjectIntegrationBindingRecord[]> {
    const rows = await db.query.projectIntegrationBindings.findMany({
      where: eq(projectIntegrationBindings.projectId, projectId),
    });
    return rows.map((row) => rowToBinding(row));
  }

  async function deleteProjectBinding(projectId: ProjectId, capability: DomainCapability): Promise<void> {
    raw
      .prepare("DELETE FROM project_integration_bindings WHERE project_id = ? AND capability = ?")
      .run(projectId, capability);
  }

  return {
    createProject,
    getProjectById,
    listProjects,
    updateProject,
    updateProjectConfiguration,
    deleteProject,
    adoptOrphanedTasksForProject,
    setProjectEnabled,
    setProjectTicketSource,
    getProjectTicketSource,
    findProjectByTicketSource,
    addProjectPushTarget,
    listProjectPushTargets,
    removeProjectPushTarget,
    replaceProjectPushTargets,
    setProjectReviewConfig,
    getProjectReviewConfig,
    findProjectsByReviewTarget,
    getProjectBinding,
    listProjectBindings,
    deleteProjectBinding,
  };
}
