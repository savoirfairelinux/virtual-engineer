import type Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type {
  AgentId,
  ProjectId,
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
  projectPushTargets,
  projectTicketSource,
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
    enabled?: boolean;
  }): Promise<ProjectRecord>;
  getProjectById(id: ProjectId): Promise<ProjectRecord | null>;
  listProjects(filter?: { type?: ProjectType; enabled?: boolean }): Promise<ProjectRecord[]>;
  updateProject(
    id: ProjectId,
    partial: Partial<Pick<ProjectRecord, "name" | "type" | "agentId" | "agentOverrideJson" | "postCloneScript" | "enabled">>
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
      enabled: row.enabled === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  function rowToProjectTicketSource(row: typeof projectTicketSource.$inferSelect): ProjectTicketSourceRecord {
    return {
      id: row.id,
      projectId: row.projectId as ProjectId,
      integrationId: row.integrationId,
      ticketProjectKey: row.ticketProjectKey,
      createdAt: row.createdAt,
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

  async function updateProject(
    id: ProjectId,
    partial: Partial<Pick<ProjectRecord, "name" | "type" | "agentId" | "agentOverrideJson" | "postCloneScript" | "enabled">>
  ): Promise<ProjectRecord> {
    const existing = await getProjectById(id);
    if (!existing) throw new Error(`Project not found: ${id}`);
    const now = new Date();
    const update: Record<string, unknown> = { updatedAt: now };
    if (partial.name !== undefined) update["name"] = partial.name;
    if (partial.type !== undefined) update["type"] = partial.type;
    if (partial.agentId !== undefined) {
      const agent = await db.query.agents.findFirst({
        where: eq(agents.id, partial.agentId),
      });
      if (!agent) throw new Error(`Cannot update project: agent not found: ${partial.agentId}`);
      update["agentId"] = partial.agentId;
    }
    if (partial.agentOverrideJson !== undefined) update["agentOverrideJson"] = partial.agentOverrideJson;
    if (partial.postCloneScript !== undefined) update["postCloneScript"] = partial.postCloneScript;
    if (partial.enabled !== undefined) update["enabled"] = partial.enabled ? 1 : 0;
    await db.update(projects).set(update).where(eq(projects.id, id));
    const updated = await getProjectById(id);
    if (!updated) throw new Error(`Project disappeared after update: ${id}`);
    return updated;
  }

  async function deleteProject(id: ProjectId): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const reason = `project ${id} deleted while tasks were still active`;
    const placeholders = [...TERMINAL_STATES].map(() => "?").join(", ");
    raw.transaction(() => {
      const ticketSource = raw
        .prepare(
          "SELECT integration_id, ticket_project_key FROM project_ticket_source WHERE project_id = ?"
        )
        .get(id) as { integration_id: string; ticket_project_key: string } | undefined;
      if (ticketSource) {
        raw
          .prepare(
            "UPDATE tasks SET ticket_source_integration_id = COALESCE(ticket_source_integration_id, ?), " +
            "ticket_source_project_key = COALESCE(ticket_source_project_key, ?), updated_at = ? " +
            "WHERE project_id = ?"
          )
          .run(ticketSource.integration_id, ticketSource.ticket_project_key, now, id);
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
      raw.prepare("DELETE FROM project_ticket_source WHERE project_id = ?").run(id);
      raw.prepare("DELETE FROM project_push_targets WHERE project_id = ?").run(id);
      raw.prepare("DELETE FROM project_review_repos WHERE project_id = ?").run(id);
      raw.prepare("DELETE FROM project_review_integration WHERE project_id = ?").run(id);
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
    return raw.transaction((): ProjectTicketSourceRecord => {
      const conflict = raw
        .prepare(
          "SELECT project_id FROM project_ticket_source WHERE integration_id = ? AND ticket_project_key = ? AND project_id != ?"
        )
        .get(input.integrationId, input.ticketProjectKey, projectId) as { project_id: string } | undefined;
      if (conflict) {
        throw new Error(
          `Ticket source (${input.integrationId}, ${input.ticketProjectKey}) is already claimed by project ${conflict.project_id}`
        );
      }
      raw.prepare("DELETE FROM project_ticket_source WHERE project_id = ?").run(projectId);
      raw
        .prepare(
          "INSERT INTO project_ticket_source (project_id, integration_id, ticket_project_key, created_at) VALUES (?, ?, ?, ?)"
        )
        .run(projectId, input.integrationId, input.ticketProjectKey, Math.floor(now.getTime() / 1000));
      adoptOrphanedTasksForProject(projectId, input.integrationId, input.ticketProjectKey);
      const row = raw
        .prepare("SELECT id, project_id, integration_id, ticket_project_key, created_at FROM project_ticket_source WHERE project_id = ?")
        .get(projectId) as { id: number; project_id: string; integration_id: string; ticket_project_key: string; created_at: number };
      return {
        id: row.id,
        projectId: row.project_id as ProjectId,
        integrationId: row.integration_id,
        ticketProjectKey: row.ticket_project_key,
        createdAt: new Date(row.created_at * 1000),
      };
    })();
  }

  async function getProjectTicketSource(projectId: ProjectId): Promise<ProjectTicketSourceRecord | null> {
    const row = await db.query.projectTicketSource.findFirst({
      where: eq(projectTicketSource.projectId, projectId),
    });
    return row ? rowToProjectTicketSource(row) : null;
  }

  async function findProjectByTicketSource(integrationId: string, ticketProjectKey: string): Promise<ProjectRecord | null> {
    const row = raw
      .prepare(
        "SELECT project_id FROM project_ticket_source WHERE integration_id = ? AND ticket_project_key = ? LIMIT 1"
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
    raw.transaction((): void => {
      raw
        .prepare(
          "INSERT INTO project_review_integration (project_id, integration_id) VALUES (?, ?) " +
          "ON CONFLICT(project_id) DO UPDATE SET integration_id = excluded.integration_id"
        )
        .run(projectId, integrationId);
      raw.prepare("DELETE FROM project_review_repos WHERE project_id = ?").run(projectId);
      const insertRepo = raw.prepare(
        "INSERT INTO project_review_repos (project_id, repo_key) VALUES (?, ?)"
      );
      for (const repoKey of repoKeys) {
        insertRepo.run(projectId, repoKey);
      }
    })();
  }

  async function getProjectReviewConfig(projectId: ProjectId): Promise<ProjectReviewConfig | null> {
    const integrationRow = raw
      .prepare("SELECT integration_id FROM project_review_integration WHERE project_id = ?")
      .get(projectId) as { integration_id: string } | undefined;
    if (!integrationRow) return null;
    const repoRows = raw
      .prepare("SELECT repo_key FROM project_review_repos WHERE project_id = ?")
      .all(projectId) as Array<{ repo_key: string }>;
    return {
      integrationId: integrationRow.integration_id,
      repos: repoRows.map((row) => row.repo_key),
    };
  }

  async function findProjectsByReviewTarget(integrationId: string, repoKey: string): Promise<ProjectRecord[]> {
    const rows = raw
      .prepare(
        `SELECT p.id FROM projects p
         JOIN project_review_integration pri ON pri.project_id = p.id
         JOIN project_review_repos prr ON prr.project_id = p.id
         WHERE prr.repo_key = ?
           AND pri.integration_id = ?
           AND p.enabled = 1`
      )
      .all(repoKey, integrationId) as Array<{ id: string }>;
    const results: ProjectRecord[] = [];
    for (const row of rows) {
      const project = await getProjectById(row.id as ProjectId);
      if (project) results.push(project);
    }
    return results;
  }

  return {
    createProject,
    getProjectById,
    listProjects,
    updateProject,
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
  };
}
