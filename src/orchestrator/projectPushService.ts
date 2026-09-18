import { createHash } from "crypto";
import { isAbsolute, relative, resolve, sep } from "path";
import type {
  ChangePerRepository,
  CommitDescriptor,
  IntegrationBindingContext,
  ProjectPushTargetRecord,
  StateStore,
  Task,
  WorkspaceHandle,
} from "../interfaces.js";
import { getLogger } from "../logger.js";
import { makeExternalChangeId } from "../domain/identifiers.js";
import type { VcsConnector } from "../vcs/vcsConnector.js";
import { NO_REVIEW_SYSTEM } from "../vcs/vcsConnector.js";

const log = getLogger("project-push-service");

type ProjectPushTask = Pick<Task, "taskId" | "ticketTitle" | "pushRef">;

export interface ProjectPushWorkspaceRunner {
  listTrustedRepoPaths?: (handle: WorkspaceHandle) => string[];
  execGitInVolume?: (
    handle: WorkspaceHandle,
    args: string[],
    subPath?: string,
    signal?: AbortSignal,
  ) => Promise<string>;
}

export interface ProjectPushServiceDependencies {
  stateStore: Pick<StateStore, "getChangesForTask" | "saveChangePerRepository" | "orphanExcessChanges" | "updateExternalChangeId">;
  workspaceRunner: ProjectPushWorkspaceRunner;
  resolveVcsConnectorForTarget: (
    integrationId: string,
    context?: IntegrationBindingContext,
  ) => Promise<VcsConnector>;
  resolvePushRef: (
    task: Pick<Task, "taskId" | "pushRef">,
    compute: () => string,
  ) => Promise<string>;
}

export type ProjectPushOutcomeStatus = "NO_CHANGE" | "EXISTING" | "PUSHED" | "CLONE_FAILED" | "PUSH_FAILED";

export interface ProjectPushOutcome {
  repoKey: string;
  commitOrder: number;
  status: ProjectPushOutcomeStatus;
  changeId: string;
  reviewUrl: string;
}

export interface ProjectPushSummary {
  outcomes: ProjectPushOutcome[];
  pushedCount: number;
  reviewCount: number;
}

const NON_REVIEW_STATUSES = new Set(["NO_CHANGE", "ORPHANED", "CLONE_FAILED", "PUSH_FAILED"]);

function existingReviewForTarget(
  changes: ChangePerRepository[],
  repoKey: string,
): ChangePerRepository | undefined {
  return changes
    .filter((change) =>
      change.repoKey === repoKey &&
      typeof change.changeId === "string" &&
      change.changeId.length > 0 &&
      !NON_REVIEW_STATUSES.has(change.status))
    .sort((left, right) => left.commitIndex - right.commitIndex)[0];
}

interface IndexedGerritCommit {
  commit: CommitDescriptor;
  commitIndex: number;
  subjectHash: string;
}

function indexGerritCommits(
  commits: CommitDescriptor[],
  existingChanges: ChangePerRepository[],
  pushedChangeId: string,
): IndexedGerritCommit[] {
  const existing = existingChanges
    .filter((change) =>
      typeof change.changeId === "string" &&
      change.changeId.length > 0 &&
      !NON_REVIEW_STATUSES.has(change.status))
    .sort((left, right) => left.commitIndex - right.commitIndex);
  const usedIndexes = new Set<number>();
  let nextIndex = existing.reduce((maximum, change) => Math.max(maximum, change.commitIndex), -1) + 1;

  return commits.map((commit) => {
    const subjectHash = createHash("sha1").update(commit.subject).digest("hex");
    const suppliedChangeId = typeof commit.changeId === "string" ? commit.changeId : "";
    const match = existing.find((change) =>
      !usedIndexes.has(change.commitIndex) &&
      ((suppliedChangeId.length > 0 && change.changeId === suppliedChangeId) ||
        (change.subjectHash !== null && change.subjectHash === subjectHash))
    );
    const changeId = suppliedChangeId || match?.changeId || (commits.length === 1 ? pushedChangeId : "");
    if (changeId.length === 0) {
      throw new Error(`Gerrit commit '${commit.subject}' has no Change-Id`);
    }
    const commitIndex = match?.commitIndex ?? nextIndex++;
    usedIndexes.add(commitIndex);
    return { commit: { ...commit, changeId }, commitIndex, subjectHash };
  });
}

function resolveWorkspaceSubPath(workspacePath: string, localPath: string): string {
  if (isAbsolute(localPath)) {
    throw new Error(`Push target path must stay within the workspace: ${localPath}`);
  }
  const workspace = resolve(workspacePath);
  const target = resolve(workspace, localPath);
  const relativePath = relative(workspace, target);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`Push target path must stay within the workspace: ${localPath}`);
  }
  return target;
}

/** Pushes project repositories and persists their review changes. */
export class ProjectPushService {
  constructor(private readonly dependencies: ProjectPushServiceDependencies) {}

  async pushProjectChanges(
    task: ProjectPushTask,
    handle: WorkspaceHandle,
    pushTargets: ProjectPushTargetRecord[],
    fallbackCommitMessage: string,
    agentCommits: CommitDescriptor[] | undefined = undefined,
    topicOverride: string | null = null,
  ): Promise<ProjectPushSummary> {
    const sorted = [...pushTargets].sort((a, b) => a.commitOrder - b.commitOrder);
    const primaryTarget = sorted.find((target) => target.localPath === ".") ?? sorted[0];
    const trustedRepoPaths = this.dependencies.workspaceRunner.listTrustedRepoPaths
      ? new Set(this.dependencies.workspaceRunner.listTrustedRepoPaths(handle))
      : null;
    const existingChanges = await this.dependencies.stateStore.getChangesForTask(task.taskId);

    const outcomes: ProjectPushOutcome[] = [];
    const pushErrors: Array<{ repoKey: string; err: unknown }> = [];

    for (const target of sorted) {
      const existingReview = existingReviewForTarget(existingChanges, target.repoKey);
      const repoCommits = (agentCommits ?? []).filter((commit) =>
        commit.repoKey === target.repoKey ||
        (sorted.length === 1 && commit.repoKey === "superproject")
      );
      if (trustedRepoPaths !== null && !trustedRepoPaths.has(target.localPath)) {
        const err = new Error(
          `Push target "${target.repoKey}" was not cloned by Virtual Engineer; refusing to push from an untrusted workspace path`,
        );
        log.warn({ taskId: task.taskId, repoKey: target.repoKey, localPath: target.localPath }, err.message);
        if (existingReview === undefined) {
          await this.dependencies.stateStore.saveChangePerRepository(
            task.taskId,
            target.repoKey,
            "",
            "",
            "CLONE_FAILED",
            target.integrationId,
            NO_REVIEW_SYSTEM,
            0,
            null,
          );
        }
        outcomes.push({
          repoKey: target.repoKey,
          commitOrder: target.commitOrder,
          status: "CLONE_FAILED",
          changeId: "",
          reviewUrl: "",
        });
        pushErrors.push({ repoKey: target.repoKey, err });
        continue;
      }

      if (agentCommits !== undefined && existingReview !== undefined && repoCommits.length === 0) {
        outcomes.push({
          repoKey: target.repoKey,
          commitOrder: target.commitOrder,
          status: "EXISTING",
          changeId: existingReview.changeId,
          reviewUrl: existingReview.reviewUrl ?? "",
        });
        log.info(
          { taskId: task.taskId, repoKey: target.repoKey, changeId: existingReview.changeId },
          "agent produced no commits for restored target; preserving existing review",
        );
        continue;
      }

      let isDirty = false;
      if (this.dependencies.workspaceRunner.execGitInVolume) {
        try {
          const aheadOut = await this.dependencies.workspaceRunner.execGitInVolume(
            handle,
            ["rev-list", "--count", "HEAD", `^origin/${target.targetBranch}`],
            target.localPath,
          );
          isDirty = (parseInt(aheadOut.trim(), 10) || 0) > 0;
        } catch (err) {
          log.warn(
            { taskId: task.taskId, repoKey: target.repoKey, err },
            "git rev-list failed for project push target; assuming changes present",
          );
          isDirty = true;
        }
      }

      if (!isDirty) {
        if (existingReview !== undefined) {
          outcomes.push({
            repoKey: target.repoKey,
            commitOrder: target.commitOrder,
            status: "EXISTING",
            changeId: existingReview.changeId,
            reviewUrl: existingReview.reviewUrl ?? "",
          });
          log.info(
            { taskId: task.taskId, repoKey: target.repoKey, changeId: existingReview.changeId },
            "project push target had no new changes; preserving existing review",
          );
          continue;
        }
        await this.dependencies.stateStore.saveChangePerRepository(
          task.taskId,
          target.repoKey,
          "",
          "",
          "NO_CHANGE",
          target.integrationId,
          NO_REVIEW_SYSTEM,
          0,
          "",
        );
        outcomes.push({
          repoKey: target.repoKey,
          commitOrder: target.commitOrder,
          status: "NO_CHANGE",
          changeId: "",
          reviewUrl: "",
        });
        log.info({ taskId: task.taskId, repoKey: target.repoKey }, "project push target had no changes");
        continue;
      }

      let vcsConnector: VcsConnector;
      try {
        vcsConnector = await this.dependencies.resolveVcsConnectorForTarget(
          target.integrationId,
          { repoKey: target.repoKey, targetBranch: target.targetBranch },
        );
      } catch (err) {
        log.warn(
          { taskId: task.taskId, repoKey: target.repoKey, integrationId: target.integrationId, err },
          "no VCS connector for push target; skipping",
        );
        if (existingReview === undefined) {
          await this.dependencies.stateStore.saveChangePerRepository(
            task.taskId,
            target.repoKey,
            "",
            "",
            "PUSH_FAILED",
            target.integrationId,
            NO_REVIEW_SYSTEM,
            0,
            null,
          );
        }
        outcomes.push({
          repoKey: target.repoKey,
          commitOrder: target.commitOrder,
          status: "PUSH_FAILED",
          changeId: "",
          reviewUrl: "",
        });
        pushErrors.push({ repoKey: target.repoKey, err });
        continue;
      }
      const { ref: computedRef, topic: computedTopic } = vcsConnector.buildPushSpec(
        target.targetBranch,
        task.taskId,
        task.ticketTitle,
      );
      const ref = target === primaryTarget
        ? await this.dependencies.resolvePushRef(task, () => computedRef)
        : computedRef;
      const topic = topicOverride?.trim() ? topicOverride.trim() : computedTopic;
      const reviewSystemLabel = vcsConnector.reviewSystemLabel;
      const repoDir = resolveWorkspaceSubPath(handle.hostWorkspacePath, target.localPath);
      let remotePushSucceeded = false;

      try {
        const subjectHash = createHash("sha1").update(fallbackCommitMessage.split("\n")[0] ?? "").digest("hex");

        if (!vcsConnector.pushDirect) {
          throw new Error(`VCS connector for ${reviewSystemLabel} does not implement pushDirect`);
        }
        const pushResult = await vcsConnector.pushDirect(
          repoDir,
          ref,
          topic,
          target.reviewerEmails,
        );
        remotePushSucceeded = true;

        const makeChangeUrl = (targetChangeId: string): string => {
          if (!pushResult.url) return "";
          if (pushResult.changeId && pushResult.url.includes(pushResult.changeId)) {
            return pushResult.url.replace(pushResult.changeId, targetChangeId);
          }
          return pushResult.url;
        };

        if (vcsConnector.useChangeIdContinuity) {
          const existingTargetChanges = existingChanges.filter((change) => change.repoKey === target.repoKey);
          const commitsToPersist = repoCommits.length > 0
            ? repoCommits
            : [{
                repoKey: target.repoKey,
                sha: "",
                subject: fallbackCommitMessage.split("\n")[0] ?? "",
                body: "",
                changeId: pushResult.changeId,
                files: [],
              }];
          const indexedCommits = indexGerritCommits(
            commitsToPersist,
            existingTargetChanges,
            pushResult.changeId,
          );
          for (const { commit, commitIndex, subjectHash: commitSubjectHash } of indexedCommits) {
            await this.dependencies.stateStore.saveChangePerRepository(
              task.taskId,
              target.repoKey,
              commit.changeId,
              makeChangeUrl(commit.changeId),
              pushResult.status || "OPEN",
              target.integrationId,
              reviewSystemLabel,
              commitIndex,
              commitSubjectHash,
            );
          }
          log.info(
            { taskId: task.taskId, repoKey: target.repoKey, commitCount: indexedCommits.length },
            "pushed Gerrit project target",
          );
          const existingActive = existingTargetChanges.filter(
            (change) =>
              typeof change.changeId === "string" &&
              change.changeId.length > 0 &&
              !NON_REVIEW_STATUSES.has(change.status),
          );
          if (existingActive.length === 0) {
            const maximumIndex = indexedCommits.reduce(
              (maximum, indexed) => Math.max(maximum, indexed.commitIndex),
              0,
            );
            const orphaned = await this.dependencies.stateStore.orphanExcessChanges(
              task.taskId,
              target.repoKey,
              maximumIndex,
            );
            if (orphaned > 0) {
              log.info(
                { taskId: task.taskId, repoKey: target.repoKey, orphanedCount: orphaned },
                "marked excess change_per_repository rows as ORPHANED",
              );
            }
          }
          const updatedPrimary = indexedCommits.find((indexed) => indexed.commitIndex === 0);
          const existingPrimary = existingActive.find((change) => change.commitIndex === 0);
          const primaryChangeId = updatedPrimary?.commit.changeId ?? existingPrimary?.changeId;
          if (primaryChangeId === undefined) {
            throw new Error(`Gerrit target ${target.repoKey} has no primary change at commit index 0`);
          }
          const primaryReviewUrl = updatedPrimary !== undefined
            ? makeChangeUrl(primaryChangeId)
            : existingPrimary?.reviewUrl ?? makeChangeUrl(primaryChangeId);
          outcomes.push({
            repoKey: target.repoKey,
            commitOrder: target.commitOrder,
            status: "PUSHED",
            changeId: primaryChangeId,
            reviewUrl: primaryReviewUrl,
          });
        } else {
          const primaryChangeId = pushResult.changeId;
          const primaryReviewUrl = pushResult.url;
          await this.dependencies.stateStore.saveChangePerRepository(
            task.taskId,
            target.repoKey,
            primaryChangeId,
            primaryReviewUrl,
            pushResult.status || "OPEN",
            target.integrationId,
            reviewSystemLabel,
            0,
            subjectHash,
          );
          log.info(
            { taskId: task.taskId, repoKey: target.repoKey, changeId: primaryChangeId, url: primaryReviewUrl },
            "pushed project target",
          );
          const orphaned = await this.dependencies.stateStore.orphanExcessChanges(task.taskId, target.repoKey, 0);
          if (orphaned > 0) {
            log.info(
              { taskId: task.taskId, repoKey: target.repoKey, orphanedCount: orphaned },
              "marked excess change_per_repository rows as ORPHANED",
            );
          }
          outcomes.push({
            repoKey: target.repoKey,
            commitOrder: target.commitOrder,
            status: "PUSHED",
            changeId: primaryChangeId,
            reviewUrl: primaryReviewUrl,
          });
        }
      } catch (err) {
        log.error(
          { taskId: task.taskId, repoKey: target.repoKey, err },
          "project push target push failed; continuing with remaining targets",
        );
        if (!remotePushSucceeded && existingReview === undefined) {
          await this.dependencies.stateStore.saveChangePerRepository(
            task.taskId,
            target.repoKey,
            "",
            "",
            "PUSH_FAILED",
            target.integrationId,
            reviewSystemLabel,
            0,
            null,
          );
        }
        outcomes.push({
          repoKey: target.repoKey,
          commitOrder: target.commitOrder,
          status: "PUSH_FAILED",
          changeId: "",
          reviewUrl: "",
        });
        pushErrors.push({ repoKey: target.repoKey, err });
      }
    }

    if (pushErrors.length > 0) {
      const detail = pushErrors
        .map((entry) => `${entry.repoKey}: ${entry.err instanceof Error ? entry.err.message : String(entry.err)}`)
        .join("; ");
      throw new Error(`Push targets failed: ${detail}`);
    }

    const primaryChange = outcomes.find((outcome) => outcome.changeId.length > 0);
    if (primaryChange !== undefined) {
      await this.dependencies.stateStore.updateExternalChangeId(
        task.taskId,
        makeExternalChangeId(primaryChange.changeId),
        0,
        primaryChange.reviewUrl,
      );
    }

    return {
      outcomes,
      pushedCount: outcomes.filter((outcome) => outcome.status === "PUSHED").length,
      reviewCount: outcomes.filter((outcome) => outcome.changeId.length > 0).length,
    };
  }
}