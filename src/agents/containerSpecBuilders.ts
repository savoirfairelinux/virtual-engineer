import { homedir } from "os";
import { join, resolve } from "path";
import type {
  AdapterContainerSpec,
  ReviewWorkspaceInput,
  TaskContext,
} from "../interfaces.js";

const DEFAULT_AGENT_IMAGE = "virtual-engineer-workspace:latest";
const DEFAULT_AGENT_NETWORK = "virtual-engineer_ve-agent-net";
const AGENT_COMMAND = ["node", "/agent-worker/dist/index.js"];

export const SECURITY_DOCKER_ARGS = [
  "--read-only",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges:true",
  "--security-opt",
  "label=disable",
  "--tmpfs",
  "/tmp:rw,nosuid,size=256m",
];

interface CodegenContainerSpecOptions {
  providerEnv: Record<string, string>;
  maxRepositoryContextBytes: number;
  maxCommitsPerCycle: number | undefined;
  promptsDir?: string | undefined;
  dockerNetwork?: string | undefined;
}

interface ReviewContainerSpecOptions {
  providerEnv: Record<string, string>;
  dockerNetwork?: string | undefined;
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
    ...(session.skillDiscoveryEnabled ? { SKILL_DISCOVERY: "1" } : {}),
    ...(session.skillDiscoveryEnabled && session.localSkillsPath !== undefined
      ? { LOCAL_SKILLS_PATH: session.localSkillsPath }
      : {}),
    ...(session.ticketFooterLine ? { TICKET_FOOTER_LINE: session.ticketFooterLine } : {}),
  };
  const additionalDockerArgs = [...SECURITY_DOCKER_ARGS];

  if (options.promptsDir) {
    const promptsDir = resolvePath(options.promptsDir);
    additionalDockerArgs.push("-v", `${promptsDir}:/ve-prompts:ro,Z`);
    env["PROMPTS_DIR"] = "/ve-prompts";
  }

  return buildBaseContainerSpec(
    session.agentContainerImage,
    env,
    options.dockerNetwork,
    additionalDockerArgs
  );
}

export function buildReviewContainerSpec(
  input: ReviewWorkspaceInput,
  options: ReviewContainerSpecOptions
): AdapterContainerSpec {
  const env: Record<string, string> = {
    ...options.providerEnv,
    REVIEW_MODE: "1",
    USER_PROMPT_FILE: "/ve-home/user-prompt.txt",
    SYSTEM_PROMPT: input.systemPrompt,
    ...(input.skillDiscoveryEnabled ? { SKILL_DISCOVERY: "1" } : {}),
    ...(input.skillDiscoveryEnabled && input.localSkillsPath !== undefined
      ? { LOCAL_SKILLS_PATH: input.localSkillsPath }
      : {}),
  };

  return buildBaseContainerSpec(
    input.containerImage ?? DEFAULT_AGENT_IMAGE,
    env,
    options.dockerNetwork,
    [...SECURITY_DOCKER_ARGS]
  );
}

function buildBaseContainerSpec(
  image: string,
  env: Record<string, string>,
  dockerNetwork: string | undefined,
  additionalDockerArgs: string[]
): AdapterContainerSpec {
  return {
    image,
    env,
    command: [...AGENT_COMMAND],
    networkMode: dockerNetwork ?? DEFAULT_AGENT_NETWORK,
    additionalDockerArgs,
  };
}

function resolvePath(value: string): string {
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  if (value === "~") return homedir();
  return resolve(value);
}