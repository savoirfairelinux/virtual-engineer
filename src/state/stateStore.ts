/** SQLite-backed state store using better-sqlite3 and Drizzle ORM. WAL mode and foreign keys enabled at startup. */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdir } from "fs/promises";
import { dirname } from "path";
import { getLogger } from "../logger.js";
import { seedBuiltInPolicies } from "../admin/authorization/seedPolicies.js";
import type {
  AgentRecord,
  ProjectRecord,
  ResolvedAgentConfig,
  StateStore,
} from "../interfaces.js";
import type { Task } from "../domain/tasks.js";

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { AgentStoreApi } from "./stores/agentStore.js";
import { createAgentStore } from "./stores/agentStore.js";
import type { AuditStoreApi } from "./stores/auditStore.js";
import { createAuditStore } from "./stores/auditStore.js";
import type { CostStoreApi } from "./stores/costStore.js";
import { createCostStore } from "./stores/costStore.js";
import type { GroupStoreApi } from "./stores/groupStore.js";
import { createGroupStore } from "./stores/groupStore.js";
import type { IntegrationStoreApi } from "./stores/integrationStore.js";
import { createIntegrationStore } from "./stores/integrationStore.js";
import type { PolicyStoreApi } from "./stores/policyStore.js";
import { createPolicyStore } from "./stores/policyStore.js";
import type { RuntimePolicyStoreApi } from "./stores/runtimePolicyStore.js";
import { createRuntimePolicyStore } from "./stores/runtimePolicyStore.js";
import type { DenialStoreApi } from "./stores/denialStore.js";
import { createDenialStore } from "./stores/denialStore.js";
import type { OpenShellProviderStoreApi } from "./stores/openShellProviderStore.js";
import { createOpenShellProviderStore } from "./stores/openShellProviderStore.js";
import type { ProjectStoreApi } from "./stores/projectStore.js";
import { createProjectStore } from "./stores/projectStore.js";
import type { PromptStoreApi } from "./stores/promptStore.js";
import { createPromptStore } from "./stores/promptStore.js";
import type { ReviewDedupStoreApi } from "./stores/reviewDedupStore.js";
import { createReviewDedupStore } from "./stores/reviewDedupStore.js";
import type { SettingsStoreApi } from "./stores/settingsStore.js";
import { createSettingsStore } from "./stores/settingsStore.js";
import type { TaskStoreApi } from "./stores/taskStore.js";
import { createTaskStore } from "./stores/taskStore.js";
import type { UserStoreApi } from "./stores/userStore.js";
import { createUserStore } from "./stores/userStore.js";
import { runDatabaseMigrations } from "./databaseMigrations.js";
import * as schema from "./schema.js";

type ComposedStoreApi =
  & TaskStoreApi
  & ReviewDedupStoreApi
  & CostStoreApi
  & IntegrationStoreApi
  & ProjectStoreApi
  & PromptStoreApi
  & AgentStoreApi
  & SettingsStoreApi
  & UserStoreApi
  & AuditStoreApi
  & GroupStoreApi
  & PolicyStoreApi
  & RuntimePolicyStoreApi
  & DenialStoreApi
  & OpenShellProviderStoreApi;

/** Facade class that composes domain-scoped store modules over one shared SQLite connection. */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class SqliteStateStore {
  private readonly db: BetterSQLite3Database<typeof schema>;
  private readonly dbDir: string;
  private readonly taskStore: TaskStoreApi;
  private readonly reviewDedupStore: ReviewDedupStoreApi;
  private readonly costStore: CostStoreApi;
  private readonly integrationStore: IntegrationStoreApi;
  private readonly projectStore: ProjectStoreApi;
  private readonly promptStore: PromptStoreApi;
  private readonly agentStore: AgentStoreApi;
  private readonly settingsStore: SettingsStoreApi;
  private readonly userStore: UserStoreApi;
  private readonly auditStore: AuditStoreApi;
  private readonly groupStore: GroupStoreApi;
  private readonly policyStore: PolicyStoreApi;
  private readonly runtimePolicyStore: RuntimePolicyStoreApi;
  private readonly denialStore: DenialStoreApi;
  private readonly openShellProviderStore: OpenShellProviderStoreApi;
  private readonly taskTransitionListeners: Array<(task: Task) => void> = [];

  constructor(private readonly raw: Database.Database) {
    this.dbDir = dirname(this.raw.name);
    this.db = drizzle(this.raw, { schema });

    // Pass a state-change dispatcher into the task store so every method that
    // mutates a task's state (transition, retry, abandon, and a delete that
    // abandons a non-terminal task) notifies registered listeners uniformly —
    // no call site needs to know about polling-loop lifecycle. The closure
    // reads the (already-initialised) listener array so listeners can be added
    // later.
    this.taskStore = createTaskStore({
      db: this.db,
      raw: this.raw,
      onTaskStateChange: (task) => this.notifyTaskTransition(task),
    });
    this.reviewDedupStore = createReviewDedupStore({ db: this.db, raw: this.raw });
    this.costStore = createCostStore({ raw: this.raw });
    this.integrationStore = createIntegrationStore({ db: this.db });
    this.projectStore = createProjectStore({ db: this.db, raw: this.raw });
    this.promptStore = createPromptStore({ db: this.db, dbDir: this.dbDir });
    this.agentStore = createAgentStore({ db: this.db });
    this.settingsStore = createSettingsStore({ db: this.db });
    this.userStore = createUserStore({ db: this.db });
    this.auditStore = createAuditStore({ db: this.db });
    this.groupStore = createGroupStore({ db: this.db });
    this.policyStore = createPolicyStore({ db: this.db });
    this.runtimePolicyStore = createRuntimePolicyStore({ db: this.db });
    this.denialStore = createDenialStore({ db: this.db });
    this.openShellProviderStore = createOpenShellProviderStore({ db: this.db });

    Object.assign(
      this,
      this.taskStore,
      this.reviewDedupStore,
      this.costStore,
      this.integrationStore,
      this.projectStore,
      this.promptStore,
      this.agentStore,
      this.settingsStore,
      this.userStore,
      this.auditStore,
      this.groupStore,
      this.policyStore,
      this.runtimePolicyStore,
      this.denialStore,
      this.openShellProviderStore
    );
  }

  /** Invoke all registered task-transition listeners, swallowing their errors (sync or async). */
  private notifyTaskTransition(task: Task): void {
    // Snapshot the list so listeners added or removed during iteration don't
    // affect the current notification pass.
    for (const listener of [...this.taskTransitionListeners]) {
      try {
        const result = listener(task) as unknown;
        if (result instanceof Promise) {
          result.catch((err: unknown) => {
            getLogger("state-store").warn({ err, taskId: task.taskId }, "task transition listener failed");
          });
        }
      } catch (err) {
        getLogger("state-store").warn({ err, taskId: task.taskId }, "task transition listener failed");
      }
    }
  }

  /**
   * Register a listener invoked after any task state change — via
   * `transition()` or the dedicated mutators (`retryTask`, `abandonTask`, and
   * `deleteTask` when it abandons a non-terminal task). Not fired for
   * pause/resume, which only append same-state metadata rows. Listeners never
   * affect the mutating call: their errors are caught and logged. Used to let
   * the runtime bootstrap react to state changes (e.g. reconcile the polling
   * loop) without every call site needing polling-loop plumbing.
   *
   * @returns An unsubscribe function that removes the listener when called.
   */
  onTaskTransition(listener: (task: Task) => void): () => void {
    this.taskTransitionListeners.push(listener);
    return () => {
      const idx = this.taskTransitionListeners.indexOf(listener);
      if (idx !== -1) this.taskTransitionListeners.splice(idx, 1);
    };
  }

  /** Create and initialise a store at `dbPath`. Creates the parent directory, runs migrations, and seeds built-in prompts. */
  static async create(dbPath: string): Promise<SqliteStateStore> {
    const dir = dirname(dbPath);
    await mkdir(dir, { recursive: true });
    const raw = new Database(dbPath);
    try {
      raw.pragma("journal_mode = WAL");
      raw.pragma("foreign_keys = ON");
      runDatabaseMigrations(raw);
      const store = new SqliteStateStore(raw);
      await store.seedBuiltInPrompts();
      await seedBuiltInPolicies(store);
      return store;
    } catch (error) {
      raw.close();
      throw error;
    }
  }

  /** Close the underlying SQLite database connection. */
  close(): void {
    this.raw.close();
  }

  /** Convenience helper: fetch the ProjectRecord bound to a task via its projectId. */
  async getProjectForTask(task: Task): Promise<ProjectRecord | null> {
    if (!task.projectId) return null;
    return this.projectStore.getProjectById(task.projectId);
  }
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface SqliteStateStore extends StateStore, ComposedStoreApi {}

/**
 * Partial-merge of a project's `agentOverrideJson` over an agent's
 * `modelConfigJson`. Override semantics:
 * - keys *present* in the override (and not `null`) replace the agent value;
 * - absent keys or `null` values fall back to the agent.
 *
 * Prompts: project override `systemPromptId` / `instructionsPromptId` win when
 * non-null; otherwise the agent's prompt is used.
 *
 * You cannot use the override to clear a field that the agent has set.
 */
export function resolveAgentConfig(agent: AgentRecord, project: ProjectRecord): ResolvedAgentConfig {
  const agentCfg = parseConfigJson(agent.modelConfigJson);
  const overrideCfg = project.agentOverrideJson ? parseConfigJson(project.agentOverrideJson) : {};

  const merged: Record<string, unknown> = { ...agentCfg };
  for (const [key, value] of Object.entries(overrideCfg)) {
    if (value === null || value === undefined) continue;
    merged[key] = value;
  }

  const overridePrompts = overrideCfg as { systemPromptId?: unknown; instructionsPromptId?: unknown; feedbackInstructionsPromptId?: unknown };
  const sysOverride = typeof overridePrompts.systemPromptId === "string" ? overridePrompts.systemPromptId : null;
  const insOverride = typeof overridePrompts.instructionsPromptId === "string" ? overridePrompts.instructionsPromptId : null;
  const fbOverride = typeof overridePrompts.feedbackInstructionsPromptId === "string" ? overridePrompts.feedbackInstructionsPromptId : null;
  const systemPromptId = (sysOverride ?? agent.systemPromptId)?.trim() || null;
  const instructionsPromptId = (insOverride ?? agent.instructionsPromptId)?.trim() || null;
  if (!systemPromptId) {
    throw new Error(`Agent '${agent.id}' has no system prompt configured`);
  }
  if (!instructionsPromptId) {
    throw new Error(`Agent '${agent.id}' has no instructions prompt configured`);
  }

  const known = new Set(["model", "apiKey", "sessionToken", "systemPromptId", "instructionsPromptId", "feedbackInstructionsPromptId"]);
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (!known.has(key)) extra[key] = value;
  }

  return {
    model: typeof merged["model"] === "string" ? (merged["model"]) : undefined,
    apiKey: typeof merged["apiKey"] === "string" ? (merged["apiKey"]) : undefined,
    encryptedSessionToken: typeof merged["sessionToken"] === "string"
      ? (merged["sessionToken"])
      : undefined,
    systemPromptId,
    instructionsPromptId,
    feedbackInstructionsPromptId:
      (fbOverride ?? agent.feedbackInstructionsPromptId)?.trim() || null,
    extra,
  };
}

/** Safely parse a JSON string into a plain object; returns `{}` on invalid input. */
function parseConfigJson(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}
