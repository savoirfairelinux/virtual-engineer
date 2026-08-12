import type {
  AgentAdapter,
  ChangePerRepository,
  FeedbackItem,
  ProjectPushTargetRecord,
  ProjectRecord,
  ResolvedAgentConfig,
  RepositoryMap,
  Task,
  TaskContext,
  TaskId,
  Ticket,
  VendorComponentPromptEntry,
  WorkspaceHandle,
} from "../interfaces.js";
import { formatTicketFooter } from "../utils/ticketFooterFormatter.js";

/** Resolved agent adapter + config for a project's configured agent. */
export interface ProjectAgentRuntime {
  adapter: AgentAdapter;
  config: ResolvedAgentConfig;
}

/** Extract acceptance-criteria lines (checklist or numbered items) from a ticket description. */
export function extractAcceptanceCriteria(description: string): string[] {
  return description
    .split("\n")
    .filter((line) => /^\s*[-*]\s+\[[ x]\]/.test(line) || /^\s*\d+\.\s+/.test(line))
    .map((line) => line.trim());
}

/**
 * Build a {@link RepositoryMap} from a project's push targets so the agent
 * container knows which subdirectories map to which repositories.
 *
 * The target with `localPath === "."` (or the lowest `commitOrder` if none) is
 * treated as the superproject; all others become submodules.
 */
export function buildRepositoryMap(pushTargets: ProjectPushTargetRecord[]): RepositoryMap {
  const sorted = [...pushTargets].sort((a, b) => a.commitOrder - b.commitOrder);
  const rootIdx = sorted.findIndex((t) => t.localPath === ".");
  const root = rootIdx >= 0 ? sorted[rootIdx]! : sorted[0]!;
  const rest = sorted.filter((t) => t !== root);

  return {
    superproject: { repoKey: root.repoKey, localPath: root.localPath },
    submodules: rest.map((t) => ({ repoKey: t.repoKey, localPath: t.localPath })),
  };
}

/** Inputs required to assemble the {@link TaskContext} passed to the agent adapter for one cycle. */
export interface BuildAgentTaskContextParams {
  task: Task;
  ticket: Pick<Ticket, "subject" | "description" | "webUrl">;
  cycleNumber: number;
  hasPriorPatchset: boolean;
  commitMessage: string;
  cloneBranch: string;
  cloneUrl: string;
  pushRef: string;
  handle: WorkspaceHandle;
  priorFeedback: FeedbackItem[];
  projectAgentRuntime: ProjectAgentRuntime;
  resolvedCopilotModel: string | undefined;
  providerOptions: Record<string, unknown>;
  useChangeIdContinuity: boolean;
  projectPushTargets: ProjectPushTargetRecord[];
  vendorComponents: VendorComponentPromptEntry[];
  projectRecord: ProjectRecord;
  agentContainerImage: string;
  gitAuthorName: string;
  gitAuthorEmail: string;
  getChangesForTask: (taskId: TaskId) => Promise<ChangePerRepository[]>;
}

/**
 * Assemble the {@link TaskContext} handed to the agent adapter for one cycle:
 * ticket metadata, prior-feedback/patchset state, and the full `agentSession`
 * (clone/push info, provider credentials/options, repository map, vendor
 * components, and skill sources).
 */
export async function buildAgentTaskContext(params: BuildAgentTaskContextParams): Promise<TaskContext> {
  const {
    task,
    ticket,
    cycleNumber,
    hasPriorPatchset,
    commitMessage,
    cloneBranch,
    cloneUrl,
    pushRef,
    handle,
    priorFeedback,
    projectAgentRuntime,
    resolvedCopilotModel,
    providerOptions,
    useChangeIdContinuity,
    projectPushTargets,
    vendorComponents,
    projectRecord,
    agentContainerImage,
    gitAuthorName,
    gitAuthorEmail,
    getChangesForTask,
  } = params;

  return {
    taskId: task.taskId,
    ticketTitle: ticket.subject,
    ticketDescription: ticket.description,
    acceptanceCriteria: extractAcceptanceCriteria(ticket.description),
    baseBranch: cloneBranch,
    workspacePath: handle.hostWorkspacePath,
    constraints: [],
    priorFeedback,
    cycleNumber,
    hasPriorPatchset,
    commitMessage,
    ticketUrl: ticket.webUrl,
    systemPromptId: projectAgentRuntime.config.systemPromptId,
    // On retry cycles, swap in the feedback-specific instructions prompt when one is configured.
    instructionsPromptId:
      cycleNumber > 1 && projectAgentRuntime.config.feedbackInstructionsPromptId
        ? projectAgentRuntime.config.feedbackInstructionsPromptId
        : projectAgentRuntime.config.instructionsPromptId,
    agentSession: {
      agentContainerImage,
      repoCloneUrl: cloneUrl,
      pushRef,
      existingChangeId: useChangeIdContinuity ? (task.externalChangeId ?? undefined) : undefined,
      perRepoChangeIds: await (async (): Promise<Record<string, string | Record<string, string>> | undefined> => {
        if (!useChangeIdContinuity) return undefined;
        const storedChanges = await getChangesForTask(task.taskId);
        if (storedChanges.length === 0) return undefined;
        // Pass ALL commit Change-Ids per repo, keyed by commit index.
        // Single-commit repos produce a flat string (backward compat).
        // Multi-commit repos produce { "0": "I...", "1": "I..." }.
        const validChanges = storedChanges.filter(
          (c) => c.status !== "NO_CHANGE" && c.changeId !== ""
        );
        if (validChanges.length === 0) return undefined;
        const byRepo = new Map<string, Map<number, string>>();
        for (const c of validChanges) {
          let m = byRepo.get(c.repoKey);
          if (!m) { m = new Map(); byRepo.set(c.repoKey, m); }
          m.set(c.commitIndex, c.changeId);
        }
        const result: Record<string, string | Record<string, string>> = {};
        for (const [repoKey, indexMap] of byRepo) {
          if (indexMap.size === 1 && indexMap.has(0)) {
            result[repoKey] = indexMap.get(0)!;
          } else {
            const obj: Record<string, string> = {};
            for (const [idx, cid] of indexMap) obj[String(idx)] = cid;
            result[repoKey] = obj;
          }
        }
        return Object.keys(result).length > 0 ? result : undefined;
      })(),
      gitAuthorName,
      gitAuthorEmail,
      githubToken: projectAgentRuntime.config.apiKey,
      ...(projectAgentRuntime.config.encryptedSessionToken
        ? { encryptedSessionToken: projectAgentRuntime.config.encryptedSessionToken }
        : {}),
      ...(resolvedCopilotModel ? { copilotModel: resolvedCopilotModel } : {}),
      ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
      // Aider backend credentials flow through `extra` (set by
      // resolveProjectAgentRuntime from the integration config).
      ...(typeof projectAgentRuntime.config.extra["aiderBackend"] === "string"
        ? { aiderBackend: projectAgentRuntime.config.extra["aiderBackend"] }
        : {}),
      ...(typeof projectAgentRuntime.config.extra["aiderApiKey"] === "string"
        ? { aiderApiKey: projectAgentRuntime.config.extra["aiderApiKey"] }
        : {}),
      ...(typeof projectAgentRuntime.config.extra["aiderApiBase"] === "string"
        ? { aiderApiBase: projectAgentRuntime.config.extra["aiderApiBase"] }
        : {}),
      // Goose provider credentials flow through `extra` (set by
      // resolveProjectAgentRuntime from the integration config).
      ...(typeof projectAgentRuntime.config.extra["gooseProvider"] === "string"
        ? { gooseProvider: projectAgentRuntime.config.extra["gooseProvider"] }
        : {}),
      ...(typeof projectAgentRuntime.config.extra["gooseApiKey"] === "string"
        ? { gooseApiKey: projectAgentRuntime.config.extra["gooseApiKey"] }
        : {}),
      ...(typeof projectAgentRuntime.config.extra["gooseApiBase"] === "string"
        ? { gooseApiBase: projectAgentRuntime.config.extra["gooseApiBase"] }
        : {}),
      // Gemini CLI Vertex AI settings flow through `extra` (set by
      // resolveProjectAgentRuntime from the integration config). The API key
      // itself is carried generically via `githubToken` above.
      ...(typeof projectAgentRuntime.config.extra["geminiAuthMode"] === "string"
        ? { geminiAuthMode: projectAgentRuntime.config.extra["geminiAuthMode"] }
        : {}),
      ...(typeof projectAgentRuntime.config.extra["geminiGoogleCloudProject"] === "string"
        ? { geminiGoogleCloudProject: projectAgentRuntime.config.extra["geminiGoogleCloudProject"] }
        : {}),
      ...(typeof projectAgentRuntime.config.extra["geminiGoogleCloudLocation"] === "string"
        ? { geminiGoogleCloudLocation: projectAgentRuntime.config.extra["geminiGoogleCloudLocation"] }
        : {}),
      // OpenCode provider credentials flow through `extra` (set by
      // resolveProjectAgentRuntime from the integration config).
      ...(typeof projectAgentRuntime.config.extra["openCodeProvider"] === "string"
        ? { openCodeProvider: projectAgentRuntime.config.extra["openCodeProvider"] }
        : {}),
      ...(typeof projectAgentRuntime.config.extra["openCodeApiKey"] === "string"
        ? { openCodeApiKey: projectAgentRuntime.config.extra["openCodeApiKey"] }
        : {}),
      ...(typeof projectAgentRuntime.config.extra["openCodeApiBase"] === "string"
        ? { openCodeApiBase: projectAgentRuntime.config.extra["openCodeApiBase"] }
        : {}),
      ...(projectPushTargets.length > 1 || projectPushTargets.some((t) => t.localPath !== ".")
        ? { repositoryMap: buildRepositoryMap(projectPushTargets) }
        : {}),
      ...(vendorComponents.length > 0 ? { vendorComponents } : {}),
      ...(projectRecord.skillSourcesJson !== "[]"
        ? { skillSourcesJson: projectRecord.skillSourcesJson }
        : {}),
      ...((): { ticketFooterLine?: string } => {
        if (!projectRecord.useFullTicketUrlInCommits) return {};
        const line = formatTicketFooter(task.ticketId, ticket.webUrl ?? "", task.ticketSourceLabel, true);
        return line ? { ticketFooterLine: line } : {};
      })(),
    },
  };
}
