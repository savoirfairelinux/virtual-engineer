import type { ExternalChangeId, TaskId } from "../domain/identifiers.js";
import type { ChangePerRepository, Task, TaskState } from "../domain/tasks.js";
import type {
  FeedbackItem,
  IntegrationBindingContext,
  ReviewComment,
  ReviewConnector,
} from "../interfaces.js";
import { getLogger } from "../logger.js";
import type { VcsConnector } from "../vcs/vcsConnector.js";
import { isCiFeedbackComment } from "./feedbackProcessor.js";

const log = getLogger("review-progress");

type ReviewProgressConnector = ReviewConnector | VcsConnector;

export interface ReviewProgressDependencies {
  getChangesForTask(taskId: TaskId): Promise<ChangePerRepository[]>;
  transition(taskId: TaskId, state: TaskState): Promise<Task>;
  updateChangeStatus(
    taskId: TaskId,
    repoKey: string,
    status: string,
    changeId: string
  ): Promise<void>;
  getTask(taskId: TaskId): Promise<Task | null>;
  resolveReviewConnector(task: Pick<Task, "taskId" | "projectId">): Promise<ReviewConnector>;
  resolveVcsConnector(
    integrationId: string,
    context: IntegrationBindingContext
  ): Promise<VcsConnector | undefined>;
  getDefaultVcsConnector(): VcsConnector | undefined;
  extractNewFeedback(
    taskId: TaskId,
    changeId: ExternalChangeId,
    comments: ReviewComment[]
  ): Promise<readonly [FeedbackItem[], ReviewComment[]]>;
  reactsToCiFailures(task: Task): Promise<boolean>;
  getMaxAgentCycles(): number;
  runAgentCycle(task: Task, feedback: FeedbackItem[]): Promise<void>;
  closeTicket(task: Task): Promise<void>;
  abandonTask(task: Task, reason: string): Promise<void>;
}

export class ReviewProgressService {
  constructor(private readonly dependencies: ReviewProgressDependencies) {}

  async check(
    task: Task,
    streamChangeId?: string,
    streamComments?: ReviewComment[]
  ): Promise<void> {
    const perRepoChanges = await this.dependencies.getChangesForTask(task.taskId);
    if (perRepoChanges.length > 0) {
      await this.checkMultiRepository(task, perRepoChanges, streamChangeId, streamComments);
      return;
    }

    await this.checkSingleRepository(task, streamComments);
  }

  private async checkSingleRepository(
    task: Task,
    streamComments?: ReviewComment[]
  ): Promise<void> {
    const changeId = task.externalChangeId;
    if (!changeId) {
      log.warn({ taskId: task.taskId }, "IN_REVIEW but no gerritChangeId — waiting");
      return;
    }

    const reviewConnector = await this.dependencies.resolveReviewConnector(task);

    let status: string;
    try {
      status = await reviewConnector.getChangeStatus(changeId);
    } catch (err) {
      log.warn({ taskId: task.taskId, changeId, err }, "failed to fetch Gerrit change status — staying IN_REVIEW");
      return;
    }

    if (status === "MERGED") {
      log.info({ taskId: task.taskId }, "change MERGED");
      const mergedTask = await this.dependencies.transition(task.taskId, "MERGED");
      await this.dependencies.closeTicket(mergedTask);
      return;
    }

    if (status === "ABANDONED") {
      await this.dependencies.abandonTask(task, "change was abandoned externally");
      return;
    }

    const comments = await reviewConnector.getUnresolvedComments(changeId, task.currentPatchset);
    const ciComments = reviewConnector.getCICheckFailures
      ? await reviewConnector.getCICheckFailures(changeId).catch((err: unknown) => {
          log.warn({ taskId: task.taskId, changeId, err }, "failed to fetch CI check failures (non-fatal)");
          return [] as ReviewComment[];
        })
      : [];
    const baseComments = ciComments.length > 0 ? [...comments, ...ciComments] : comments;
    const allComments = streamComments && streamComments.length > 0
      ? [...streamComments, ...baseComments]
      : baseComments;
    const scopedComments = await this.scopeCiComments(task, allComments);

    const feedbackTask = await this.dependencies.transition(task.taskId, "FEEDBACK_PROCESSING");
    const [feedbackItems, processedComments] = await this.dependencies.extractNewFeedback(
      feedbackTask.taskId,
      changeId,
      scopedComments
    );

    if (feedbackItems.length === 0) {
      log.debug({ taskId: task.taskId }, "no new actionable comments, back to IN_REVIEW");
      await this.dependencies.transition(task.taskId, "IN_REVIEW");
      return;
    }

    const maxAgentCycles = this.dependencies.getMaxAgentCycles();
    if (feedbackTask.cycleCount > maxAgentCycles) {
      await this.dependencies.abandonTask(
        feedbackTask,
        `Max cycles ${maxAgentCycles} reached during review`
      );
      return;
    }

    log.info(
      { taskId: task.taskId, feedbackCount: feedbackItems.length },
      "actionable feedback found, starting retry cycle"
    );
    const retryTask = await this.dependencies.transition(task.taskId, "RETRY_CYCLE");
    await this.dependencies.runAgentCycle(retryTask, feedbackItems);

    const updatedTask = await this.dependencies.getTask(task.taskId);
    if (updatedTask?.state !== "IN_REVIEW") return;

    if (processedComments.length > 0) {
      try {
        await reviewConnector.resolveComments(changeId, processedComments);
        log.info({ taskId: task.taskId, count: processedComments.length }, "resolved review comments");
      } catch (err) {
        log.warn({ taskId: task.taskId, err }, "failed to resolve Gerrit comments (non-fatal)");
      }
    }
  }

  private async checkMultiRepository(
    task: Task,
    perRepoChanges: ChangePerRepository[],
    streamChangeId?: string,
    streamComments?: ReviewComment[]
  ): Promise<void> {
    const activeChanges = perRepoChanges.filter(
      (change) => change.status !== "NO_CHANGE" && change.status !== "ORPHANED"
    );
    if (activeChanges.length === 0) {
      log.info({ taskId: task.taskId }, "all per-repo changes are NO_CHANGE, treating as merged");
      const mergedTask = await this.dependencies.transition(task.taskId, "MERGED");
      await this.dependencies.closeTicket(mergedTask);
      return;
    }

    let fallbackReviewConnector: ReviewConnector | undefined;
    const getFallbackReviewConnector = async (): Promise<ReviewConnector> => {
      fallbackReviewConnector ??= await this.dependencies.resolveReviewConnector(task);
      return fallbackReviewConnector;
    };

    const reactToCiFailures = await this.dependencies.reactsToCiFailures(task);
    let allMerged = true;
    let anyAbandoned = false;
    const abandonedRepos: string[] = [];
    const allFeedback: FeedbackItem[] = [];
    const allProcessedComments: ReviewComment[] = [];

    for (const change of activeChanges) {
      const changeConnector = await this.resolveChangeConnector(change, getFallbackReviewConnector);
      if (!changeConnector) {
        log.warn(
          { taskId: task.taskId, repoKey: change.repoKey, integrationId: change.integrationId },
          "skipping per-repo review polling because the repo connector is unavailable"
        );
        allMerged = false;
        continue;
      }

      try {
        const currentStatus = await this.getChangeStatus(
          changeConnector,
          change.changeId,
          getFallbackReviewConnector
        );

        if (currentStatus !== change.status) {
          await this.dependencies.updateChangeStatus(
            task.taskId,
            change.repoKey,
            currentStatus,
            change.changeId
          );
          log.info(
            { taskId: task.taskId, repoKey: change.repoKey, oldStatus: change.status, newStatus: currentStatus },
            "per-repo change status updated"
          );
        }

        if (currentStatus === "ABANDONED") {
          anyAbandoned = true;
          abandonedRepos.push(change.repoKey);
        } else if (currentStatus !== "MERGED") {
          allMerged = false;
        }

        if (currentStatus === "OPEN" || currentStatus === "NEW") {
          await this.collectFeedback({
            task,
            change,
            changeConnector,
            getFallbackReviewConnector,
            reactToCiFailures,
            streamChangeId,
            streamComments,
            allFeedback,
            allProcessedComments,
          });
        }
      } catch (err) {
        log.warn(
          { taskId: task.taskId, repoKey: change.repoKey, changeId: change.changeId, err },
          "failed to poll per-repo change status (non-fatal)"
        );
        allMerged = false;
      }
    }

    if (anyAbandoned) {
      await this.dependencies.abandonTask(
        task,
        `Change abandoned externally for repositories: ${abandonedRepos.join(", ")}`
      );
      return;
    }

    if (allMerged) {
      log.info(
        { taskId: task.taskId, repoCount: activeChanges.length },
        "all per-repo changes MERGED — task converged"
      );
      const mergedTask = await this.dependencies.transition(task.taskId, "MERGED");
      await this.dependencies.closeTicket(mergedTask);
      return;
    }

    const feedbackTask = await this.dependencies.transition(task.taskId, "FEEDBACK_PROCESSING");
    if (allFeedback.length === 0) {
      log.debug({ taskId: task.taskId }, "no new multi-repo feedback, back to IN_REVIEW");
      await this.dependencies.transition(task.taskId, "IN_REVIEW");
      return;
    }

    const maxAgentCycles = this.dependencies.getMaxAgentCycles();
    if (feedbackTask.cycleCount > maxAgentCycles) {
      await this.dependencies.abandonTask(
        feedbackTask,
        `Max cycles ${maxAgentCycles} reached during multi-repo review`
      );
      return;
    }

    log.info(
      { taskId: task.taskId, feedbackCount: allFeedback.length },
      "multi-repo feedback found, starting retry cycle"
    );
    const retryTask = await this.dependencies.transition(task.taskId, "RETRY_CYCLE");
    await this.dependencies.runAgentCycle(retryTask, allFeedback);

    const updatedTask = await this.dependencies.getTask(task.taskId);
    if (updatedTask?.state !== "IN_REVIEW") return;

    await this.resolveProcessedComments(
      task,
      activeChanges,
      allProcessedComments,
      getFallbackReviewConnector
    );
  }

  private async collectFeedback(input: {
    task: Task;
    change: ChangePerRepository;
    changeConnector: ReviewProgressConnector;
    getFallbackReviewConnector: () => Promise<ReviewConnector>;
    reactToCiFailures: boolean;
    streamChangeId: string | undefined;
    streamComments: ReviewComment[] | undefined;
    allFeedback: FeedbackItem[];
    allProcessedComments: ReviewComment[];
  }): Promise<void> {
    try {
      const comments = await this.getUnresolvedComments(
        input.changeConnector,
        input.change.changeId,
        input.getFallbackReviewConnector
      );
      let ciComments: ReviewComment[] = [];
      try {
        const ciSource = await input.getFallbackReviewConnector();
        if (ciSource.getCICheckFailures) {
          ciComments = await ciSource.getCICheckFailures(
            input.change.changeId as ExternalChangeId
          );
        }
      } catch (err) {
        log.warn(
          { taskId: input.task.taskId, repoKey: input.change.repoKey, err },
          "failed to fetch CI check failures for repo (non-fatal)"
        );
      }

      const extraComments = input.streamChangeId === input.change.changeId
        && input.streamComments
        && input.streamComments.length > 0
        ? input.streamComments
        : [];
      const allComments = [...extraComments, ...comments, ...ciComments];
      const scopedComments = input.reactToCiFailures
        ? allComments
        : allComments.filter((comment) => !isCiFeedbackComment(comment));
      const [feedback, processed] = await this.dependencies.extractNewFeedback(
        input.task.taskId,
        input.change.changeId as ExternalChangeId,
        scopedComments
      );
      for (const item of feedback) {
        input.allFeedback.push({
          ...item,
          content: `[${input.change.repoKey}] ${item.content}`,
        });
      }
      input.allProcessedComments.push(...processed);
    } catch (err) {
      log.warn(
        { taskId: input.task.taskId, repoKey: input.change.repoKey, err },
        "failed to fetch feedback for repo (non-fatal)"
      );
    }
  }

  private async resolveProcessedComments(
    task: Task,
    activeChanges: ChangePerRepository[],
    processedComments: ReviewComment[],
    getFallbackReviewConnector: () => Promise<ReviewConnector>
  ): Promise<void> {
    for (const change of activeChanges) {
      const repoComments = processedComments.filter(
        (comment) => !comment.filePath
          || comment.filePath.startsWith(`${change.repoKey}/`)
          || comment.filePath === change.repoKey
      );
      if (repoComments.length === 0) continue;

      const changeConnector = await this.resolveChangeConnector(change, getFallbackReviewConnector);
      if (!changeConnector) {
        log.warn(
          { taskId: task.taskId, repoKey: change.repoKey, integrationId: change.integrationId },
          "skipping comment resolution because the repo connector is unavailable"
        );
        continue;
      }

      try {
        if ("resolveComments" in changeConnector && typeof changeConnector.resolveComments === "function") {
          await changeConnector.resolveComments(change.changeId as ExternalChangeId, repoComments);
        } else {
          await (await getFallbackReviewConnector()).resolveComments(
            change.changeId as ExternalChangeId,
            repoComments
          );
        }
      } catch (err) {
        log.warn(
          { taskId: task.taskId, repoKey: change.repoKey, err },
          "failed to resolve comments for repo (non-fatal)"
        );
      }
    }
  }

  private async resolveChangeConnector(
    change: ChangePerRepository,
    getFallbackReviewConnector: () => Promise<ReviewConnector>
  ): Promise<ReviewProgressConnector | undefined> {
    if (change.integrationId) {
      return this.dependencies.resolveVcsConnector(change.integrationId, { repoKey: change.repoKey });
    }
    return this.dependencies.getDefaultVcsConnector() ?? getFallbackReviewConnector();
  }

  private async getChangeStatus(
    connector: ReviewProgressConnector,
    changeId: string,
    getFallbackReviewConnector: () => Promise<ReviewConnector>
  ): Promise<string> {
    if ("getChangeStatus" in connector) {
      return connector.getChangeStatus(changeId as ExternalChangeId);
    }
    return (await getFallbackReviewConnector()).getChangeStatus(changeId as ExternalChangeId);
  }

  private async getUnresolvedComments(
    connector: ReviewProgressConnector,
    changeId: string,
    getFallbackReviewConnector: () => Promise<ReviewConnector>
  ): Promise<ReviewComment[]> {
    if ("getUnresolvedComments" in connector && typeof connector.getUnresolvedComments === "function") {
      return connector.getUnresolvedComments(changeId as ExternalChangeId);
    }
    return (await getFallbackReviewConnector()).getUnresolvedComments(changeId as ExternalChangeId);
  }

  private async scopeCiComments(task: Task, comments: ReviewComment[]): Promise<ReviewComment[]> {
    return (await this.dependencies.reactsToCiFailures(task))
      ? comments
      : comments.filter((comment) => !isCiFeedbackComment(comment));
  }
}