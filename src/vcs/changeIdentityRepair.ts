import type {
  ChangePerRepository,
  ChangeIdentityRepairMutation,
  Integration,
  IntegrationBindingContext,
  ProjectId,
  ProjectPushTargetRecord,
  Task,
  TaskId,
} from "../interfaces.js";
import { makeExternalChangeId } from "../domain/identifiers.js";
import type { VcsConnector, VcsPushResult } from "./vcsConnector.js";

export interface ChangeIdentityRepairStore {
  getActiveTasks(): Promise<Task[]>;
  listProjectPushTargets(projectId: ProjectId): Promise<ProjectPushTargetRecord[]>;
  getChangesForTask(taskId: TaskId): Promise<ChangePerRepository[]>;
  getIntegration(id: string): Promise<Integration | null>;
  applyChangeIdentityRepair(input: ChangeIdentityRepairMutation): Promise<void>;
}

export interface ChangeIdentityRepairTargetReport {
  repoKey: string;
  provider: string | null;
  currentChangeIds: string[];
  resolvedChangeId: string | null;
  status: "clean" | "repair" | "no_change" | "blocked";
  detail: string | null;
}

export interface ChangeIdentityRepairTaskReport {
  taskId: string;
  status: "clean" | "repairable" | "applied" | "blocked";
  targets: ChangeIdentityRepairTargetReport[];
}

export interface ChangeIdentityRepairReport {
  apply: boolean;
  tasksScanned: number;
  tasksRepairable: number;
  tasksApplied: number;
  blockedTasks: number;
  tasks: ChangeIdentityRepairTaskReport[];
}

export interface ChangeIdentityRepairInput {
  store: ChangeIdentityRepairStore;
  createConnector: (
    integration: Integration,
    context: IntegrationBindingContext,
  ) => VcsConnector;
  apply: boolean;
}

interface ResolvedTarget {
  target: ProjectPushTargetRecord;
  provider: string;
  currentRows: ChangePerRepository[];
  review: VcsPushResult | null;
  requiresWrite: boolean;
  routingRepair: {
    repoKey: string;
    integrationId: string;
    reviewSystem: string;
  } | null;
}

const INACTIVE_CHANGE_STATUSES = new Set(["NO_CHANGE", "ORPHANED", "CLONE_FAILED", "PUSH_FAILED"]);

function activeRows(rows: ChangePerRepository[]): ChangePerRepository[] {
  return rows
    .filter((row) => row.changeId.length > 0 && !INACTIVE_CHANGE_STATUSES.has(row.status))
    .sort((left, right) => left.commitIndex - right.commitIndex);
}

function needsBranchRepair(
  rows: ChangePerRepository[],
  review: VcsPushResult,
  integrationId: string,
  reviewSystem: string,
): boolean {
  const active = activeRows(rows);
  return active.length !== 1
    || active[0]?.commitIndex !== 0
    || active[0]?.changeId !== review.changeId
    || active[0]?.reviewUrl !== review.url
    || active[0]?.status !== review.status
    || active[0]?.integrationId !== integrationId
    || active[0]?.reviewSystem !== reviewSystem;
}

function targetReport(
  resolved: ResolvedTarget,
): ChangeIdentityRepairTargetReport {
  const currentChangeIds = activeRows(resolved.currentRows).map((row) => row.changeId);
  if (resolved.review === null) {
    return {
      repoKey: resolved.target.repoKey,
      provider: resolved.provider,
      currentChangeIds,
      resolvedChangeId: null,
      status: "no_change",
      detail: null,
    };
  }
  return {
    repoKey: resolved.target.repoKey,
    provider: resolved.provider,
    currentChangeIds,
    resolvedChangeId: resolved.review.changeId,
    status: resolved.requiresWrite ? "repair" : "clean",
    detail: null,
  };
}

async function resolveTarget(
  input: ChangeIdentityRepairInput,
  task: Task,
  target: ProjectPushTargetRecord,
  changes: ChangePerRepository[],
  isPrimary: boolean,
): Promise<ResolvedTarget | ChangeIdentityRepairTargetReport> {
  const currentRows = changes.filter((change) => change.repoKey === target.repoKey);
  const active = activeRows(currentRows);
  const hasOnlyNoChange = active.length === 0
    && currentRows.some((change) => change.status === "NO_CHANGE");

  const integration = await input.store.getIntegration(target.integrationId);
  if (integration === null) {
    return {
      repoKey: target.repoKey,
      provider: null,
      currentChangeIds: active.map((row) => row.changeId),
      resolvedChangeId: null,
      status: "blocked",
      detail: `Integration ${target.integrationId} was not found`,
    };
  }

  let connector: VcsConnector;
  try {
    connector = input.createConnector(integration, {
      repoKey: target.repoKey,
      targetBranch: target.targetBranch,
    });
  } catch (error) {
    return {
      repoKey: target.repoKey,
      provider: integration.provider,
      currentChangeIds: active.map((row) => row.changeId),
      resolvedChangeId: null,
      status: "blocked",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (connector.useChangeIdContinuity) {
    const current = active[0];
    if (current === undefined) {
      if (hasOnlyNoChange) {
        return { target, provider: integration.provider, currentRows, review: null, requiresWrite: false, routingRepair: null };
      }
      return {
        repoKey: target.repoKey,
        provider: integration.provider,
        currentChangeIds: [],
        resolvedChangeId: null,
        status: "blocked",
        detail: "No persisted Gerrit change identity was found",
      };
    }
    const routingMismatch = active.some((row) =>
      row.integrationId !== target.integrationId || row.reviewSystem !== connector.reviewSystemLabel);
    return {
      target,
      provider: integration.provider,
      currentRows,
      review: {
        changeId: current.changeId,
        url: current.reviewUrl ?? "",
        status: current.status,
      },
      requiresWrite: routingMismatch,
      routingRepair: routingMismatch
        ? {
            repoKey: target.repoKey,
            integrationId: target.integrationId,
            reviewSystem: connector.reviewSystemLabel,
          }
        : null,
    };
  }

  if (connector.findExistingReview === undefined) {
    return {
      repoKey: target.repoKey,
      provider: integration.provider,
      currentChangeIds: active.map((row) => row.changeId),
      resolvedChangeId: null,
      status: "blocked",
      detail: `Provider ${integration.provider} cannot resolve a review by branch`,
    };
  }

  try {
    const sourceRef = isPrimary
      ? task.pushRef!
      : connector.buildPushSpec(target.targetBranch, task.taskId, task.ticketTitle).ref;
    const review = await connector.findExistingReview(sourceRef, target.targetBranch);
    if (review === null) {
      if (hasOnlyNoChange) {
        return { target, provider: integration.provider, currentRows, review: null, requiresWrite: false, routingRepair: null };
      }
      return {
        repoKey: target.repoKey,
        provider: integration.provider,
        currentChangeIds: active.map((row) => row.changeId),
        resolvedChangeId: null,
        status: "blocked",
        detail: `No open review was found for branch ${sourceRef}`,
      };
    }
    return {
      target,
      provider: integration.provider,
      currentRows,
      review,
      requiresWrite: needsBranchRepair(
        currentRows,
        review,
        target.integrationId,
        connector.reviewSystemLabel,
      ),
      routingRepair: null,
    };
  } catch (error) {
    return {
      repoKey: target.repoKey,
      provider: integration.provider,
      currentChangeIds: active.map((row) => row.changeId),
      resolvedChangeId: null,
      status: "blocked",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function isBlockedTarget(
  value: ResolvedTarget | ChangeIdentityRepairTargetReport,
): value is ChangeIdentityRepairTargetReport {
  return "status" in value && value.status === "blocked";
}

/** Dry-run or apply canonical provider identities for active code-generation reviews. */
export async function repairProviderChangeIdentities(
  input: ChangeIdentityRepairInput,
): Promise<ChangeIdentityRepairReport> {
  const tasks = (await input.store.getActiveTasks()).filter(
    (task) => task.taskType === "code-gen" && task.state === "IN_REVIEW",
  );
  const reports: ChangeIdentityRepairTaskReport[] = [];
  let tasksRepairable = 0;
  let tasksApplied = 0;
  let blockedTasks = 0;

  for (const task of tasks) {
    if (task.projectId == null || !task.pushRef) {
      blockedTasks += 1;
      reports.push({
        taskId: task.taskId,
        status: "blocked",
        targets: [{
          repoKey: "(unknown)",
          provider: null,
          currentChangeIds: [],
          resolvedChangeId: null,
          status: "blocked",
          detail: task.projectId == null ? "Task has no project" : "Task has no persisted push branch",
        }],
      });
      continue;
    }

    const [targets, changes] = await Promise.all([
      input.store.listProjectPushTargets(task.projectId),
      input.store.getChangesForTask(task.taskId),
    ]);
    const sortedTargets = [...targets].sort((left, right) => left.commitOrder - right.commitOrder);
    const primaryTarget = sortedTargets.find((target) => target.localPath === ".") ?? sortedTargets[0];
    const resolved = await Promise.all(
      sortedTargets.map((target) => resolveTarget(input, task, target, changes, target === primaryTarget)),
    );
    const blocked = resolved.filter(isBlockedTarget);
    if (blocked.length > 0 || resolved.length === 0) {
      blockedTasks += 1;
      reports.push({
        taskId: task.taskId,
        status: "blocked",
        targets: resolved.length > 0
          ? resolved.map((value) => isBlockedTarget(value) ? value : targetReport(value))
          : [{
              repoKey: "(none)",
              provider: null,
              currentChangeIds: [],
              resolvedChangeId: null,
              status: "blocked",
              detail: "Project has no configured push targets",
            }],
      });
      continue;
    }

    const plans = resolved as ResolvedTarget[];
    const primary = plans.find((plan) => plan.review !== null)?.review ?? null;
    if (primary === null) {
      blockedTasks += 1;
      reports.push({
        taskId: task.taskId,
        status: "blocked",
        targets: plans.map(targetReport),
      });
      continue;
    }
    const mirrorNeedsRepair = task.externalChangeId !== primary.changeId
      || task.reviewUrl !== primary.url;
    const needsRepair = mirrorNeedsRepair || plans.some((plan) => plan.requiresWrite);
    if (!needsRepair) {
      reports.push({ taskId: task.taskId, status: "clean", targets: plans.map(targetReport) });
      continue;
    }

    tasksRepairable += 1;
    if (input.apply) {
      await input.store.applyChangeIdentityRepair({
        taskId: task.taskId,
        targets: plans.flatMap((plan) => {
          if (!plan.requiresWrite || plan.review === null || plan.routingRepair !== null) return [];
          return [{
            repoKey: plan.target.repoKey,
            changeId: plan.review.changeId,
            reviewUrl: plan.review.url,
            status: plan.review.status,
            integrationId: plan.target.integrationId,
            reviewSystem: plan.provider,
            subjectHash: plan.currentRows.find((row) => row.commitIndex === 0)?.subjectHash ?? null,
          }];
        }),
        routingRepairs: plans.flatMap((plan) => plan.routingRepair === null ? [] : [plan.routingRepair]),
        primaryChangeId: makeExternalChangeId(primary.changeId),
        primaryReviewUrl: primary.url,
      });
      tasksApplied += 1;
    }

    reports.push({
      taskId: task.taskId,
      status: input.apply ? "applied" : "repairable",
      targets: plans.map(targetReport),
    });
  }

  return {
    apply: input.apply,
    tasksScanned: tasks.length,
    tasksRepairable,
    tasksApplied,
    blockedTasks,
    tasks: reports,
  };
}