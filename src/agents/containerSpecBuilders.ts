import { homedir } from "os";
import { join, resolve } from "path";
import type {
  AdapterContainerSpec,
  AgentEgressSpec,
  ReviewWorkspaceInput,
  TaskContext,
} from "../interfaces.js";

const DEFAULT_AGENT_IMAGE = "virtual-engineer-workspace:latest";
// The worker lives under /app because OpenShell's default filesystem policy
// only permits read-only executable content there.
const AGENT_COMMAND = ["node", "/app/agent-worker/dist/index.js"];

interface CodegenContainerSpecOptions {
  providerEnv: Record<string, string>;
  maxRepositoryContextBytes: number;
  maxCommitsPerCycle: number | undefined;
  promptsDir?: string | undefined;
  egress?: AgentEgressSpec | undefined;
}

interface ReviewContainerSpecOptions {
  providerEnv: Record<string, string>;
  egress?: AgentEgressSpec | undefined;
}

/**
 * OpenShell rejects literal CR/LF in `sandbox exec --env` values, so a
 * multiline system prompt is transported base64-encoded and decoded by the
 * worker before provider dispatch.
 */
/** Spread helper that omits `egress` entirely when the provider declares none. */
export function egressOption(spec: AgentEgressSpec | undefined): { egress?: AgentEgressSpec } {
  return spec !== undefined ? { egress: spec } : {};
}

export function systemPromptEnv(systemPrompt: string): Record<string, string> {
  return /[\r\n]/u.test(systemPrompt)
    ? { SYSTEM_PROMPT_BASE64: Buffer.from(systemPrompt, "utf8").toString("base64") }
    : { SYSTEM_PROMPT: systemPrompt };
}

export function buildCodegenContainerSpec(
  context: TaskContext,
  options: CodegenContainerSpecOptions
): AdapterContainerSpec {
  const session = context.agentSession;
  const env: Record<string, string> = {
    ...options.providerEnv,
    GIT_AUTHOR_NAME: session.gitAuthorName,
    GIT_AUTHOR_EMAIL: session.gitAuthorEmail,
    GIT_COMMITTER_NAME: session.gitAuthorName,
    GIT_COMMITTER_EMAIL: session.gitAuthorEmail,
    TASK_ID: context.taskId,
    MAX_CONTEXT_BYTES: String(options.maxRepositoryContextBytes),
    MAX_COMMITS_PER_CYCLE: String(options.maxCommitsPerCycle ?? 10),
    ...(session.repositoryMap !== undefined
      ? { REPOSITORY_MAP_JSON: JSON.stringify(session.repositoryMap) }
      : {}),
    ...(session.existingChangeId !== undefined
      ? { ROOT_CHANGE_ID: session.existingChangeId }
      : {}),
    ...(session.perRepoChangeIds !== undefined
      ? { PER_REPO_CHANGE_IDS_JSON: JSON.stringify(session.perRepoChangeIds) }
      : {}),
    ...(session.ticketFooterLine ? { TICKET_FOOTER_LINE: session.ticketFooterLine } : {}),
  };
  if (options.promptsDir) {
    env["PROMPTS_DIR"] = resolvePath(options.promptsDir);
  }

  return buildBaseContainerSpec(session.agentContainerImage, env, options.egress);
}

export function buildReviewContainerSpec(
  input: ReviewWorkspaceInput,
  options: ReviewContainerSpecOptions
): AdapterContainerSpec {
  const env: Record<string, string> = {
    ...options.providerEnv,
    REVIEW_MODE: "1",
    REVIEW_STRATEGY: input.reviewStrategy,
    ...systemPromptEnv(input.systemPrompt),
  };

  return buildBaseContainerSpec(input.containerImage ?? DEFAULT_AGENT_IMAGE, env, options.egress);
}

function buildBaseContainerSpec(
  image: string,
  env: Record<string, string>,
  egress: AgentEgressSpec | undefined
): AdapterContainerSpec {
  return {
    image,
    env,
    command: [...AGENT_COMMAND],
    ...(egress !== undefined ? { egress } : {}),
  };
}

function resolvePath(value: string): string {
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  if (value === "~") return homedir();
  return resolve(value);
}