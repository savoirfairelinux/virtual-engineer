import { createHash } from "crypto";
import { isAbsolute, relative, resolve, sep } from "path";
import type {
  CommitDescriptor,
  IntegrationBindingContext,
  ProjectPushTargetRecord,
  StateStore,
  Task,
  WorkspaceHandle,
} from "../interfaces.js";
import { getLogger } from "../logger.js";
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
  stateStore: Pick<StateStore, "saveChangePerRepository" | "orphanExcessChanges">;
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
  ): Promise<void> {
    const sorted = [...pushTargets].sort((a, b) => a.commitOrder - b.commitOrder);
    const trustedRepoPaths = this.dependencies.workspaceRunner.listTrustedRepoPaths
      ? new Set(this.dependencies.workspaceRunner.listTrustedRepoPaths(handle))
      : null;

    let dirtyCount = 0;
    let successCount = 0;
    const pushErrors: Array<{ repoKey: string; err: unknown }> = [];

    for (const target of sorted) {
      if (trustedRepoPaths !== null && !trustedRepoPaths.has(target.localPath)) {
        const err = new Error(
          `Push target "${target.repoKey}" was not cloned by Virtual Engineer; refusing to push from an untrusted workspace path`,
        );
        log.warn({ taskId: task.taskId, repoKey: target.repoKey, localPath: target.localPath }, err.message);
        pushErrors.push({ repoKey: target.repoKey, err });
        dirtyCount++;
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
        log.info({ taskId: task.taskId, repoKey: target.repoKey }, "project push target had no changes");
        continue;
      }

      dirtyCount++;

      let vcsConnector: VcsConnector;
      try {
        vcsConnector = await this.dependencies.resolveVcsConnectorForTarget(
          target.integrationId,
          { repoKey: target.repoKey },
        );
      } catch (err) {
        log.warn(
          { taskId: task.taskId, repoKey: target.repoKey, integrationId: target.integrationId, err },
          "no VCS connector for push target; skipping",
        );
        pushErrors.push({ repoKey: target.repoKey, err });
        continue;
      }
      const { ref: computedRef, topic: computedTopic } = vcsConnector.buildPushSpec(
        target.targetBranch,
        task.taskId,
        task.ticketTitle,
      );
      const ref = await this.dependencies.resolvePushRef(task, () => computedRef);
      const topic = topicOverride?.trim() ? topicOverride.trim() : computedTopic;
      const reviewSystemLabel = vcsConnector.reviewSystemLabel;
      const repoDir = resolveWorkspaceSubPath(handle.hostWorkspacePath, target.localPath);

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

        const repoCommits = (agentCommits ?? []).filter((commit) => commit.repoKey === target.repoKey);
        const makeChangeUrl = (targetChangeId: string): string => {
          if (!pushResult.url) return "";
          if (pushResult.changeId && pushResult.url.includes(pushResult.changeId)) {
            return pushResult.url.replace(pushResult.changeId, targetChangeId);
          }
          return pushResult.url;
        };

        if (repoCommits.length > 1) {
          for (let i = 0; i < repoCommits.length; i++) {
            const commit = repoCommits[i]!;
            const subjectHash = createHash("sha1").update(commit.subject).digest("hex");
            await this.dependencies.stateStore.saveChangePerRepository(
              task.taskId,
              target.repoKey,
              commit.changeId,
              i === 0 ? makeChangeUrl(commit.changeId) : "",
              pushResult.status || "OPEN",
              target.integrationId,
              reviewSystemLabel,
              i,
              subjectHash,
            );
          }
          log.info(
            { taskId: task.taskId, repoKey: target.repoKey, commitCount: repoCommits.length, firstChangeId: repoCommits[0]?.changeId },
            "pushed project target (multi-commit)",
          );
          const orphaned = await this.dependencies.stateStore.orphanExcessChanges(
            task.taskId,
            target.repoKey,
            repoCommits.length - 1,
          );
          if (orphaned > 0) {
            log.info(
              { taskId: task.taskId, repoKey: target.repoKey, orphanedCount: orphaned },
              "marked excess change_per_repository rows as ORPHANED",
            );
          }
        } else {
          const primaryChangeId = repoCommits[0]?.changeId || pushResult.changeId;
          await this.dependencies.stateStore.saveChangePerRepository(
            task.taskId,
            target.repoKey,
            primaryChangeId,
            makeChangeUrl(primaryChangeId),
            pushResult.status || "OPEN",
            target.integrationId,
            reviewSystemLabel,
            0,
            subjectHash,
          );
          log.info(
            { taskId: task.taskId, repoKey: target.repoKey, changeId: primaryChangeId, url: makeChangeUrl(primaryChangeId) },
            "pushed project target",
          );
          const orphaned = await this.dependencies.stateStore.orphanExcessChanges(task.taskId, target.repoKey, 0);
          if (orphaned > 0) {
            log.info(
              { taskId: task.taskId, repoKey: target.repoKey, orphanedCount: orphaned },
              "marked excess change_per_repository rows as ORPHANED",
            );
          }
        }
        successCount++;
      } catch (err) {
        log.error(
          { taskId: task.taskId, repoKey: target.repoKey, err },
          "project push target push failed; continuing with remaining targets",
        );
        pushErrors.push({ repoKey: target.repoKey, err });
      }
    }

    if (dirtyCount > 0 && successCount === 0 && pushErrors.length > 0) {
      const detail = pushErrors
        .map((entry) => `${entry.repoKey}: ${entry.err instanceof Error ? entry.err.message : String(entry.err)}`)
        .join("; ");
      throw new Error(`All push targets failed: ${detail}`);
    }

    if (pushErrors.length > 0) {
      log.warn(
        { taskId: task.taskId, successCount, failedCount: pushErrors.length },
        "some push targets failed but at least one succeeded; proceeding to IN_REVIEW",
      );
    }
  }
}