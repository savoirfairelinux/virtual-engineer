import type Database from "better-sqlite3";
import { and, eq, isNull, notInArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { Integration, IntegrationBindingContext } from "../interfaces.js";
import { changePerRepository, integrations, projectPushTargets, tasks } from "../state/schema.js";
import { sanitizeErrorDetail } from "../utils/redactUrl.js";
import type { VcsConnector, VcsPushResult } from "./vcsConnector.js";

const LEGACY_CHANGE_ID = /^I[0-9a-f]{40}$/i;
const INACTIVE_STATUSES = ["NO_CHANGE", "ORPHANED"];

export interface HostedChangeRepairTarget {
  taskId: string;
  repoKey: string;
  currentChangeIds: string[];
  resolvedChangeId: string | null;
  resolvedTargetBranch: string | null;
  status: "repairable" | "applied" | "skipped" | "blocked";
  detail: string | null;
}

export interface HostedChangeRepairReport {
  apply: boolean;
  repairable: number;
  applied: number;
  blocked: number;
  targets: HostedChangeRepairTarget[];
}

interface RepairPlan {
  task: typeof tasks.$inferSelect;
  target: typeof projectPushTargets.$inferSelect;
  integration: typeof integrations.$inferSelect;
  rows: Array<typeof changePerRepository.$inferSelect>;
  primary: typeof changePerRepository.$inferSelect;
  review: VcsPushResult;
  report: HostedChangeRepairTarget;
}

/** Repair only proven legacy trailer-as-PR/MR corruption; retain duplicate rows as history. */
export async function repairHostedChangeIdentities(input: {
  database: Database.Database;
  createConnector: (integration: Integration, context: IntegrationBindingContext) => VcsConnector;
  apply?: boolean | undefined;
  taskId?: string | undefined;
}): Promise<HostedChangeRepairReport> {
  const { database, createConnector } = input;
  const db = drizzle(database);
  if (input.taskId !== undefined && !db.select({ taskId: tasks.taskId }).from(tasks).where(and(
    eq(tasks.taskId, input.taskId), isNull(tasks.deletedAt),
  )).get()) {
    throw new Error("Selected task does not exist");
  }
  const report: HostedChangeRepairReport = {
    apply: input.apply ?? false, repairable: 0, applied: 0, blocked: 0, targets: [],
  };
  const candidates = db.selectDistinct({
    taskId: tasks.taskId, repoKey: changePerRepository.repoKey,
  }).from(changePerRepository).innerJoin(tasks, eq(tasks.taskId, changePerRepository.taskId))
    .where(and(
      eq(tasks.taskType, "code-gen"),
      isNull(tasks.deletedAt),
      notInArray(changePerRepository.status, INACTIVE_STATUSES),
      sql`length(${changePerRepository.changeId}) = 41
        AND substr(${changePerRepository.changeId}, 1, 1) IN ('I', 'i')
        AND substr(${changePerRepository.changeId}, 2) NOT GLOB '*[^0-9a-fA-F]*'`,
      input.taskId === undefined ? undefined : eq(tasks.taskId, input.taskId),
    )).orderBy(tasks.taskId, changePerRepository.repoKey).all();
  const readRows = (taskId: string, repoKey: string): Array<typeof changePerRepository.$inferSelect> =>
    db.select().from(changePerRepository).where(and(
      eq(changePerRepository.taskId, taskId), eq(changePerRepository.repoKey, repoKey),
    )).orderBy(changePerRepository.commitIndex, changePerRepository.id).all();
  const plans: RepairPlan[] = [];

  for (const candidate of candidates) {
    const rows = readRows(candidate.taskId, candidate.repoKey);
    const active = rows.filter((row) => !INACTIVE_STATUSES.includes(row.status));
    const targetReport: HostedChangeRepairTarget = {
      ...candidate, currentChangeIds: active.map((row) => row.changeId),
      resolvedChangeId: null, resolvedTargetBranch: null, status: "blocked", detail: null,
    };
    report.targets.push(targetReport);
    try {
      const primary = active.find((row) => row.commitIndex === 0);
      if (!primary) throw new Error("No active primary change row");
      const task = db.select().from(tasks).where(eq(tasks.taskId, candidate.taskId)).get();
      if (!task) throw new Error("Task no longer exists");
      const integration = db.select().from(integrations).where(eq(integrations.id, primary.integrationId)).get();
      if (!integration) throw new Error("Recorded integration no longer exists");
      const target = task.projectId === null ? undefined : db.select().from(projectPushTargets).where(and(
        eq(projectPushTargets.projectId, task.projectId), eq(projectPushTargets.repoKey, candidate.repoKey),
      )).get();
      const connector = createConnector({ ...integration, enabled: integration.enabled === 1 }, {
        repoKey: candidate.repoKey,
        ...(target === undefined ? {} : { targetBranch: target.targetBranch }),
      });
      if (connector.useChangeIdContinuity) {
        targetReport.status = "skipped";
        targetReport.detail = "Connector uses per-commit Change-Id continuity";
        continue;
      }
      if (!target || target.integrationId !== integration.id) {
        throw new Error("Current project binding does not match the recorded integration");
      }
      if (active.some((row) => row.integrationId !== integration.id
        || row.reviewSystem !== connector.reviewSystemLabel)) {
        throw new Error("Mixed integration or review-system rows; manual reconciliation required");
      }
      if (!task.pushRef) throw new Error("No recorded push branch; refusing to guess");
      // Every target of a task shares one push ref, and a mixed-provider cycle
      // can leave another target's ref there (e.g. a non-unique `refs/for/main`).
      // Only the branch this repository's connector derives for the task proves
      // which review the repository opened.
      if (task.pushRef !== connector.buildPushSpec(target.targetBranch, task.taskId, task.ticketTitle).ref) {
        throw new Error("Recorded push branch is not this repository's branch for the task; refusing to guess");
      }
      if (!connector.findExistingReview) throw new Error("Connector does not support read-only review lookup");
      // Search every target branch: the URL may have lost the number, and the
      // project target can change after the push, so only one review may exist.
      const review = await connector.findExistingReview(task.pushRef);
      if (!review) throw new Error("No existing review found for the recorded branch");
      if (!/^[1-9]\d*$/.test(review.changeId) || !Number.isSafeInteger(Number(review.changeId))
        || !["OPEN", "MERGED", "ABANDONED"].includes(review.status)) {
        throw new Error("Provider lookup did not return a valid native review result");
      }
      const urlProvesReview = (row: typeof changePerRepository.$inferSelect): boolean =>
        row.reviewUrl === review.url || row.reviewUrl === review.url.replace(review.changeId, row.changeId);
      if (!primary.reviewUrl || !urlProvesReview(primary)) {
        throw new Error("Recorded URL does not prove the recovered review identity");
      }
      for (const row of active) {
        if (row.reviewUrl && !urlProvesReview(row)) {
          throw new Error("An active row's URL points to a different review; refusing to orphan it");
        }
        if (row.changeId !== review.changeId && !LEGACY_CHANGE_ID.test(row.changeId)) {
          throw new Error("Conflicting native change id; refusing to orphan a different review");
        }
        if ((row.status === "MERGED" || row.status === "ABANDONED") && row.status !== review.status) {
          throw new Error("Recorded terminal change status conflicts with the recovered review");
        }
      }
      targetReport.status = "repairable";
      targetReport.resolvedChangeId = review.changeId;
      targetReport.resolvedTargetBranch = review.targetBranch;
      if (review.targetBranch !== target.targetBranch) {
        targetReport.detail = sanitizeErrorDetail(
          `Only review from the branch targets ${review.targetBranch}; the project now targets ${target.targetBranch}`,
        );
      }
      report.repairable++;
      plans.push({ task, target, integration, rows, primary, review, report: targetReport });
    } catch (error: unknown) {
      targetReport.detail = sanitizeErrorDetail(error instanceof Error ? error.message : String(error));
      report.blocked++;
    }
  }

  if (!report.apply || report.blocked > 0 || plans.length === 0) return report;

  database.transaction(() => {
    for (const plan of plans) {
      const currentTask = db.select().from(tasks).where(eq(tasks.taskId, plan.task.taskId)).get();
      const currentTarget = db.select().from(projectPushTargets).where(eq(projectPushTargets.id, plan.target.id)).get();
      const currentIntegration = db.select().from(integrations).where(eq(integrations.id, plan.integration.id)).get();
      if (JSON.stringify(currentTask) !== JSON.stringify(plan.task)
        || JSON.stringify(currentTarget) !== JSON.stringify(plan.target)
        || JSON.stringify(currentIntegration) !== JSON.stringify(plan.integration)
        || JSON.stringify(readRows(plan.task.taskId, plan.target.repoKey)) !== JSON.stringify(plan.rows)) {
        throw new Error("Repair inputs changed during lookup; stop VE intake and rerun the dry run");
      }
    }
    for (const plan of plans) {
      const now = new Date();
      const updated = db.update(changePerRepository).set({
        changeId: plan.review.changeId, reviewUrl: plan.review.url,
        status: plan.review.status, subjectHash: null, updatedAt: now,
      }).where(eq(changePerRepository.id, plan.primary.id)).run();
      if (updated.changes !== 1) throw new Error("Primary change repair did not update exactly one row");
      for (const row of plan.rows) {
        if (row.id === plan.primary.id || INACTIVE_STATUSES.includes(row.status)) continue;
        const orphaned = db.update(changePerRepository).set({ status: "ORPHANED", updatedAt: now })
          .where(eq(changePerRepository.id, row.id)).run();
        if (orphaned.changes !== 1) throw new Error("Duplicate change repair did not update exactly one row");
      }
      const mirroredId = plan.task.gerritChangeId;
      if (plan.target.role === "primary" && mirroredId !== null && LEGACY_CHANGE_ID.test(mirroredId)
        && plan.task.reviewUrl === plan.review.url.replace(plan.review.changeId, mirroredId)) {
        const mirrored = db.update(tasks).set({
          gerritChangeId: plan.review.changeId, reviewUrl: plan.review.url, updatedAt: now,
        }).where(eq(tasks.taskId, plan.task.taskId)).run();
        if (mirrored.changes !== 1) throw new Error("Task review repair did not update exactly one row");
      }
    }
  }).immediate();
  for (const plan of plans) plan.report.status = "applied";
  report.applied = plans.length;
  return report;
}
