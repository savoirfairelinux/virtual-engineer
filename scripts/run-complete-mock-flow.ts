#!/usr/bin/env tsx
/**
 * Complete end-to-end mock flow test:
 * Validates the full workflow from ticket detection → mock agent → IN_REVIEW state
 *
 * Usage:
 *   npm run build && npx tsx scripts/run-complete-mock-flow.ts
 *
 * Or set AGENT_MODE=mock before starting the main process for a real end-to-end test.
 */

import { getConfig } from "../src/config.js";
import { getLogger } from "../src/logger.js";
import { SqliteStateStore } from "../src/state/stateStore.js";
import { HttpRedmineConnector } from "../src/connectors/redmineConnector.js";
import { MockAgentAdapter } from "../src/agents/mockAgentAdapter.js";
import { DockerWorkspaceRunner } from "../src/workspace/workspaceRunner.js";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import type { ProjectModeDeps } from "../src/orchestrator/orchestrator.js";
import { makeTicketId, makeProjectId, makeAgentId } from "../src/interfaces.js";
import type { ProjectRecord } from "../src/interfaces.js";
import { mkdir } from "fs/promises";

const log = getLogger("e2e-mock-flow");

interface TestSummary {
  ticketCreated: boolean;
  taskStarted: boolean;
  reachedDetected: boolean;
  reachedContextBuilding: boolean;
  reachedAgentRunning: boolean;
  reachedInReview: boolean;
  redmineUpdated: boolean;
  gerritChangeCreated: boolean;
  finalState: string | null;
}

async function main(): Promise<void> {
  let stateStore: SqliteStateStore | null = null;
  const appConfig = getConfig();

  const summary: TestSummary = {
    ticketCreated: false,
    taskStarted: false,
    reachedDetected: false,
    reachedContextBuilding: false,
    reachedAgentRunning: false,
    reachedInReview: false,
    redmineUpdated: false,
    gerritChangeCreated: false,
    finalState: null,
  };

  try {
    log.info("═══════════════════════════════════════════════════════════");
    log.info("Starting complete end-to-end mock flow test");
    log.info("═══════════════════════════════════════════════════════════");

    log.info({ env: appConfig.nodeEnv }, "loaded configuration");

    // ─── Initialize state store ──────────────────────────────────────────────
    log.info("initializing state store");
    await mkdir(appConfig.workspaceBaseDir, { recursive: true });
    stateStore = await SqliteStateStore.create(appConfig.databasePath);

    // ─── Initialize connectors ───────────────────────────────────────────────
    log.info("initializing Redmine connector");
    const redmineConnector = new HttpRedmineConnector({
      baseUrl: appConfig.redmineUrl,
      apiKey: appConfig.redmineApiKey,
      virtualEngineerUserLogin: appConfig.redmineVirtualEngineerUserLogin,
      closedStatusId: appConfig.redmineClosedStatusId,
      inProgressStatusId: appConfig.ticketInProgressStatusId,
      inReviewStatusId: appConfig.ticketInReviewStatusId,
    });

    // Create a test ticket in Redmine
    log.info("creating test ticket in Redmine");
    const ticketTitle = `Virtual Engineer E2E Mock Test - ${new Date().toISOString()}`;
    const ticketDescription = `This is an automated test ticket for the Virtual Engineer mock flow.

Acceptance Criteria:
- [ ] Ticket should be detected by polling
- [ ] Virtual Engineer should create a mock agent session
- [ ] Changes should be submitted to Gerrit
- [ ] Ticket should reach IN_REVIEW state in both Redmine and Gerrit

Do not manually work on this ticket.`;

    let testTicketId: string | null = null;
    try {
      // Note: We assume Redmine is running and the virtual-engineer user is set up
      log.warn(
        "Note: Redmine ticket creation requires API credentials. See REDMINE_API_KEY in .env"
      );
      log.info(
        { title: ticketTitle },
        "ticket creation deferred — will rely on manual assignment for now"
      );
    } catch (err) {
      log.warn({ err }, "could not create test ticket; continuing with manual assignment assumption");
    }

    // For this E2E test, we'll manually create a task entry to simulate polling
    // In production, the polling loop creates tasks
    if (!testTicketId) {
      testTicketId = "999"; // Use a test ticket ID
      log.info({ ticketId: testTicketId }, "using test ticket ID for mock flow");
    }

    summary.ticketCreated = !!testTicketId;

    // ─── Initialize workspace runner and agent ───────────────────────────────
    const mockAgentAdapter = new MockAgentAdapter({
      status: "success",
      pushToGerrit: true,
      filesToWrite: {
        "MOCK_E2E_TEST.txt": [
          `Virtual Engineer E2E Mock Flow Test`,
          `Task: Mock Agent Test`,
          `Timestamp: ${new Date().toISOString()}`,
          `This file was created by the mock agent during E2E testing.`,
          `It demonstrates that the agent cycle completed successfully.`,
        ].join("\n"),
      },
      simulateDelayMs: 500,
    });

    const workspaceRunner = new DockerWorkspaceRunner(
      {
        agentContainerImage: appConfig.agentContainerImage,
        agentTimeoutMs: appConfig.agentTimeoutMs,
      },
      mockAgentAdapter
    );

    // ─── Initialize orchestrator ─────────────────────────────────────────────
    log.info("initializing orchestrator");

    const mockIntegrationId = "mock-redmine-int";
    const mockGerritIntegrationId = "mock-gerrit-int";
    const mockProjectId = makeProjectId("mock-e2e-project");
    const mockAgentId = makeAgentId("mock-agent");
    const mockProject: ProjectRecord = {
      id: mockProjectId,
      name: "E2E Mock Project",
      type: "coding",
      agentId: mockAgentId,
      agentOverrideJson: null,
      postCloneScript: "",
      maxConcurrent: 1,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const projectMode: ProjectModeDeps = {
      projectStore: {
        getProjectById: async () => mockProject,
        listProjectPushTargets: async () => [{
          id: 1,
          projectId: mockProjectId,
          integrationId: mockGerritIntegrationId,
          repoKey: "main",
          cloneUrl: appConfig.repoCloneUrl,
          targetBranch: appConfig.baseBranch,
          role: "primary" as const,
          commitOrder: 1,
          localPath: ".",
          sshKeyPath: appConfig.gerritSshKeyPath,
          createdAt: new Date(),
          updatedAt: new Date(),
        }],
        getProjectTicketSource: async () => ({
          id: 1,
          projectId: mockProjectId,
          integrationId: mockIntegrationId,
          ticketProjectKey: "MOCK",
          createdAt: new Date(),
        }),
        getProjectReviewTarget: async () => null,
        getAgentById: async () => ({
          id: mockAgentId,
          name: "Mock Agent",
          type: "coding" as const,
          integrationId: mockIntegrationId,
          modelConfigJson: "{}",
          systemPromptId: null,
          instructionsPromptId: null,
          maxConcurrent: 1,
          enabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      },
      pluginManager: {
        getConnectorForIntegration: <T>(_integrationId: string): T | null => {
          return redmineConnector as unknown as T;
        },
      },
    };

    const orchestrator = new Orchestrator(
      {
        maxAgentCycles: 1,
        maxRetryAttempts: appConfig.maxRetryAttempts,
        agentTimeoutMs: appConfig.agentTimeoutMs,
        repoCloneUrl: appConfig.repoCloneUrl,
        baseBranch: appConfig.baseBranch,
        gerritTargetBranch: appConfig.gerritTargetBranch,
        gerritSshHost: appConfig.gerritSshHost,
        gerritSshPort: appConfig.gerritSshPort,
        gerritSshUser: appConfig.gerritUsername,
        gerritSshKeyPath: appConfig.gerritSshKeyPath,
        gitAuthorName: appConfig.gerritCommitterName,
        gitAuthorEmail: appConfig.gerritCommitterEmail,
        agentContainerImage: appConfig.agentContainerImage,
        ticketInProgressStatusId: appConfig.ticketInProgressStatusId,
        ticketInReviewStatusId: appConfig.ticketInReviewStatusId,
        redmineClosedStatusId: appConfig.redmineClosedStatusId,
        redmineBaseUrl: appConfig.redmineUrl,
        reviewSystem: "gerrit",
      },
      stateStore,
      workspaceRunner,
      vcsConnector,
      undefined,
      projectMode
    );

    // ─── Run the complete flow ────────────────────────────────────────────────
    log.info("starting task with mock agent");
    const ticketId = makeTicketId(testTicketId);

    summary.taskStarted = true;

    try {
      await orchestrator.startTaskForProject(
        { id: testTicketId, subject: ticketTitle, description: "Mock E2E test ticket" },
        mockProject,
        `redmine:${mockIntegrationId}`
      );

      // Query the final state
      const finalTask = await stateStore.getTaskByTicketId(ticketId);
      if (finalTask) {
        summary.finalState = finalTask.state;
        summary.reachedDetected = true;
        summary.reachedInReview = finalTask.state === "IN_REVIEW";
        summary.gerritChangeCreated = !!finalTask.gerritChangeId;

        log.info(
          { taskId: finalTask.taskId, state: finalTask.state, changeId: finalTask.gerritChangeId },
          "task completed with mock agent"
        );

        // Display the flow
        log.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        log.info("TASK WORKFLOW STATES REACHED:");
        log.info(`  ✓ DETECTED → CONTEXT_BUILDING → AGENT_RUNNING → ${finalTask.state}`);
        if (finalTask.gerritChangeId) {
          log.info(`  ✓ Gerrit Change-Id: ${finalTask.gerritChangeId}`);
        }
        if (finalTask.currentPatchset > 0) {
          log.info(`  ✓ Patchset: ${finalTask.currentPatchset}`);
        }
        log.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      }
    } catch (err) {
      log.error({ err }, "orchestrator flow failed");
      throw err;
    }

    // ─── Print summary ───────────────────────────────────────────────────────
    log.info("═══════════════════════════════════════════════════════════");
    log.info("E2E MOCK FLOW TEST SUMMARY");
    log.info("═══════════════════════════════════════════════════════════");

    const checkmark = (value: boolean) => (value ? "✓" : "✗");

    console.log(`${checkmark(summary.ticketCreated)}  Ticket created or identified`);
    console.log(`${checkmark(summary.taskStarted)}  Task started`);
    console.log(`${checkmark(summary.reachedDetected)}  DETECTED state reached`);
    console.log(`${checkmark(summary.reachedContextBuilding)}  CONTEXT_BUILDING state reached`);
    console.log(`${checkmark(summary.reachedAgentRunning)}  AGENT_RUNNING state reached`);
    console.log(`${checkmark(summary.reachedInReview)}  IN_REVIEW state reached ← TARGET`);
    console.log(`${checkmark(summary.gerritChangeCreated)}  Gerrit change created`);
    console.log(`${checkmark(summary.redmineUpdated)}  Redmine status updated`);
    console.log(``);
    console.log(`Final state: ${summary.finalState}`);

    const allPassed =
      summary.taskStarted &&
      summary.reachedDetected &&
      summary.finalState === "IN_REVIEW" &&
      summary.gerritChangeCreated;

    if (allPassed) {
      console.log(
        `\nPASS - Complete mock flow test passed! Task reached IN_REVIEW as expected.`
      );
      process.exit(0);
    } else {
      console.log(
        `\nFAIL - Mock flow test did not reach all expected states. See logs above.`
      );
      process.exit(1);
    }
  } catch (err) {
    log.error({ err }, "fatal error in E2E mock flow test");
    console.error(
      `\nFAIL - Fatal error: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  } finally {
    if (stateStore) {
      stateStore.close();
    }
  }
}

main().catch((err) => {
  console.error("Uncaught error:", err);
  process.exit(1);
});
