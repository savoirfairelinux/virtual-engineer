import { homedir } from "os";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import { makeExternalChangeId, makeTaskId } from "../../src/interfaces.js";
import type { ReviewWorkspaceInput, TaskContext } from "../../src/interfaces.js";
import { AiderAdapter } from "../../src/agents/aiderAdapter.js";
import { ClaudeAdapter } from "../../src/agents/claudeAdapter.js";
import { CopilotAdapter } from "../../src/agents/copilotAdapter.js";
import {
  buildCodegenContainerSpec,
  buildReviewContainerSpec,
  SECURITY_DOCKER_ARGS,
} from "../../src/agents/containerSpecBuilders.js";

function makeContext(): TaskContext {
  return {
    taskId: makeTaskId("task-123"),
    ticketTitle: "Share container specs",
    ticketDescription: "Keep provider container contracts aligned",
    acceptanceCriteria: [],
    baseBranch: "main",
    workspacePath: "/workspace",
    volumeName: "ve-ws-test",
    homeVolumeName: "ve-home-test",
    constraints: [],
    priorFeedback: [],
    cycleNumber: 2,
    commitMessage: "Share container specs",
    agentSession: {
      agentContainerImage: "agent:test",
      repoCloneUrl: "ssh://git.example.test/project",
      pushRef: "refs/for/main",
      existingChangeId: makeExternalChangeId("Iroot"),
      perRepoChangeIds: { root: makeExternalChangeId("Irepo") },
      gitAuthorName: "Virtual Engineer",
      gitAuthorEmail: "ve@example.test",
      skillDiscoveryEnabled: true,
      localSkillsPath: "team/skills",
      ticketFooterLine: "GitLab: https://gitlab.example.test/issues/123",
      aiderBackend: "openai",
      aiderApiKey: "aider-token",
      repositoryMap: {
        superproject: { repoKey: "root", localPath: "." },
        submodules: [],
      },
    },
  };
}

function makeReviewInput(): ReviewWorkspaceInput {
  return {
    changeId: makeExternalChangeId("Ireview"),
    revisionNumber: 42,
    patchset: 3,
    repositoryName: "project",
    prompt: "Review this patch",
    systemPrompt: "Review carefully",
    agentToken: "token",
    containerImage: "review:test",
    skillDiscoveryEnabled: true,
    localSkillsPath: "team/skills",
  };
}

describe("containerSpecBuilders", () => {
  it("builds the common code-generation contract", () => {
    const context = makeContext();

    const spec = buildCodegenContainerSpec(context, {
      providerEnv: { AGENT_PROVIDER: "test" },
      maxRepositoryContextBytes: 123_456,
      maxCommitsPerCycle: 7,
      promptsDir: "~/ve-prompts",
      dockerNetwork: "agent-network",
    });

    expect(spec).toEqual({
      image: "agent:test",
      env: {
        AGENT_PROVIDER: "test",
        GIT_AUTHOR_NAME: "Virtual Engineer",
        GIT_AUTHOR_EMAIL: "ve@example.test",
        GIT_COMMITTER_NAME: "Virtual Engineer",
        GIT_COMMITTER_EMAIL: "ve@example.test",
        TASK_ID: "task-123",
        MAX_CONTEXT_BYTES: "123456",
        MAX_COMMITS_PER_CYCLE: "7",
        REPOSITORY_MAP_JSON: JSON.stringify(context.agentSession.repositoryMap),
        ROOT_CHANGE_ID: "Iroot",
        PER_REPO_CHANGE_IDS_JSON: JSON.stringify(context.agentSession.perRepoChangeIds),
        SKILL_DISCOVERY: "1",
        LOCAL_SKILLS_PATH: "team/skills",
        TICKET_FOOTER_LINE: "GitLab: https://gitlab.example.test/issues/123",
        PROMPTS_DIR: "/ve-prompts",
      },
      command: ["node", "/agent-worker/dist/index.js"],
      networkMode: "agent-network",
      additionalDockerArgs: [
        ...SECURITY_DOCKER_ARGS,
        "-v",
        `${homedir()}/ve-prompts:/ve-prompts:ro,Z`,
      ],
    });
  });

  it.each([
    ["~", homedir()],
    ["prompts", resolve("prompts")],
  ])("resolves the %s prompt directory", (promptsDir, expectedPath) => {
    const spec = buildCodegenContainerSpec(makeContext(), {
      providerEnv: {},
      maxRepositoryContextBytes: 123_456,
      maxCommitsPerCycle: 7,
      promptsDir,
    });

    expect(spec.additionalDockerArgs).toContain(`${expectedPath}:/ve-prompts:ro,Z`);
  });

  it("builds the common review contract with isolated security args", () => {
    const first = buildReviewContainerSpec(makeReviewInput(), {
      providerEnv: { AGENT_PROVIDER: "test" },
      dockerNetwork: "review-network",
    });
    const second = buildReviewContainerSpec(makeReviewInput(), {
      providerEnv: { AGENT_PROVIDER: "test" },
      dockerNetwork: "review-network",
    });

    expect(first).toEqual({
      image: "review:test",
      env: {
        AGENT_PROVIDER: "test",
        REVIEW_MODE: "1",
        USER_PROMPT_FILE: "/ve-home/user-prompt.txt",
        SYSTEM_PROMPT: "Review carefully",
        SKILL_DISCOVERY: "1",
        LOCAL_SKILLS_PATH: "team/skills",
      },
      command: ["node", "/agent-worker/dist/index.js"],
      networkMode: "review-network",
      additionalDockerArgs: SECURITY_DOCKER_ARGS,
    });

    first.additionalDockerArgs?.push("unsafe-mutation");
    expect(second.additionalDockerArgs).toEqual(SECURITY_DOCKER_ARGS);
  });

  it("keeps common code-generation and review contracts aligned across providers", () => {
    const context = makeContext();
    const input = makeReviewInput();
    const config = {
      maxRepositoryContextBytes: 123_456,
      maxCommitsPerCycle: 7,
      dockerNetwork: "agent-network",
    };
    const adapters = [
      {
        codegen: new CopilotAdapter(config).buildContainerSpec(context, {
          GITHUB_TOKEN: "copilot-token",
        }),
        review: new CopilotAdapter(config).buildReviewContainerSpec(input, {
          GITHUB_TOKEN: "copilot-token",
        }),
      },
      {
        codegen: new ClaudeAdapter(config).buildContainerSpec(context, {
          ANTHROPIC_API_KEY: "claude-token",
        }),
        review: new ClaudeAdapter(config).buildReviewContainerSpec(input, {
          ANTHROPIC_API_KEY: "claude-token",
        }),
      },
      {
        codegen: new AiderAdapter(config).buildContainerSpec(context, {
          OPENAI_API_KEY: "aider-token",
        }),
        review: new AiderAdapter(config).buildReviewContainerSpec(input, {
          OPENAI_API_KEY: "aider-token",
        }),
      },
    ];

    for (const { codegen, review } of adapters) {
      expect(codegen).toMatchObject({
        image: "agent:test",
        command: ["node", "/agent-worker/dist/index.js"],
        networkMode: "agent-network",
        additionalDockerArgs: SECURITY_DOCKER_ARGS,
      });
      expect(codegen.env).toMatchObject({
        GIT_AUTHOR_NAME: "Virtual Engineer",
        GIT_AUTHOR_EMAIL: "ve@example.test",
        GIT_COMMITTER_NAME: "Virtual Engineer",
        GIT_COMMITTER_EMAIL: "ve@example.test",
        TASK_ID: "task-123",
        MAX_CONTEXT_BYTES: "123456",
        MAX_COMMITS_PER_CYCLE: "7",
        SKILL_DISCOVERY: "1",
        LOCAL_SKILLS_PATH: "team/skills",
      });
      expect(review).toMatchObject({
        image: "review:test",
        command: ["node", "/agent-worker/dist/index.js"],
        networkMode: "agent-network",
        additionalDockerArgs: SECURITY_DOCKER_ARGS,
      });
      expect(review.env).toMatchObject({
        REVIEW_MODE: "1",
        USER_PROMPT_FILE: "/ve-home/user-prompt.txt",
        SYSTEM_PROMPT: "Review carefully",
        SKILL_DISCOVERY: "1",
        LOCAL_SKILLS_PATH: "team/skills",
      });
    }
  });
});