# Testing

## Frameworks

- **Vitest** (`npm test`, `npm run test:watch`, `npm run test:coverage`) for all unit + integration specs in `tests/unit/`.

## Layout

```text
tests/
  unit/
    helpers/                # fixtures + builders
    *.test.ts               # one file per source module + integration scenarios
```

### Unit-test inventory (excerpt)

State / DB: `stateMachine`, `stateStore`, `stateStore.projects`, `migrations.projects`, `integrationStore`, `promptStore`.

Connectors / VCS: `redmineConnector`, `redmineDiscovery`, `gerritConnector`, `gerritDiscovery`, `gerritSshDiscovery`, `gerritSshClient`, `gerritSshReviewProvider`, `gerritStreamEvents`, `gerritVcsConnector`, `integrationStreamEvents`, `gitlabHttpClient`, `gitlabIssueConnector`, `gitlabIssueDiscovery`, `gitlabMergeRequestConnector`, `gitlabMergeRequestReviewProvider`, `gitlabMergeRequestDiscovery`, `gitlabVcsConnector`, `vcsConnector`, `vcsFactory`, `baseTicketConnector`.

Agents / review runtime: `copilotAdapter`, `copilotAdapter.promptInjection`, `copilotConnectionValidator`, `copilotOAuthService`, `providerAuthService`, `copilotModelsService`, `mockAgentAdapter`, `agentEventTypes`, `agentEventTypes.normalization`, `copilotReviewAgent`, `reviewPromptBuilder`, `reviewResultParser`, `reviewOrchestrator`, `reviewLiveLogs`, `commentHash`, `commentSeverity`, `workerCommitProtocol`.

Orchestrator / polling / webhooks: `orchestrator`, `orchestrator.projectMode`, `orchestrator.webhookEntryPoints`, `orchestrator.concurrency`, `orchestratorCommitMessage`, `pollingLoop.projects`, `pollingLoop.concurrency`, `concurrencyTracker`, `feedbackProcessor`, `webhookServer`, `webhookHandlerRedmine`, `webhookHandlerGitlabIssue`, `webhookHandlerGitlabMergeRequest`.

Plugins / runtime wiring: `pluginManager`, `pluginManager.multiInstance`, `registry`, `runtimeBootstrap` (historical test name covering bootstrap wiring in `src/index.ts`).

Admin: `adminServer`, `adminServer.behavior`, `adminServer.integration`, `adminHealthEndpoint`, `adminPluginRoutes`, `adminPromptRoutes`, `adminAgentsRoutes`, `adminAgentsOAuthRoutes`, `adminProjectsRoutes`, `adminConcurrencyRoutes`, `adminIntegrationsDiscover`, `adminWebhookSecretRoutes`, `closeAdminServer`, `dashboard`, `dashboard.configurationTab`.

Misc: `config`, `logger`, `encryption`, `ticketFooterFormatter`, `dockerVolume`, `workspaceRunner`, `workspaceRunner.multiTarget`, `pauseResumeFlow`.

> **There are integration tests today.** Files ending in `.integration.test.ts` wire several modules together with mocked external I/O.

## Conventions

- All external I/O is mocked: `fetch`, `node:fs`, `dockerode`, `child_process` SSH helpers, the GitHub Copilot SDK, Git network calls. Never hit real services.
- Mock with `vi.mock("…/foo.js", () => …)` for module-level stubs, or `vi.spyOn(obj, "method")` for instance-level.
- Gerrit SSH tests mock `child_process.execFile` callbacks with `{ stdout, stderr }` objects because the connectors promisify that API.
- Use `vi.useFakeTimers()` + `vi.runAllTimersAsync()` for the polling loop. **Always** call `loop.stop()` before `runAllTimersAsync` (Vitest aborts after 10 000 timer iterations otherwise).
- Reset shared state in `beforeEach` (`vi.clearAllMocks()`, `resetConfig()` from `src/config.ts`, fresh in-memory SQLite).
- Helper builders / fixtures live in `tests/unit/helpers/` — prefer extending them over inlining.
- Vitest is silent in `NODE_ENV=test` thanks to `src/logger.ts`; raise `LOG_LEVEL` if you need diagnostic output during a single test.
- Strict TypeScript applies to tests too (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, no `any`).

## Vitest skeleton

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";

vi.mock("../../src/connectors/redmineConnector.js", () => ({
  RedmineConnector: vi.fn(() => ({
    getAssignedTickets: vi.fn().mockResolvedValue([]),
  })),
}));

describe("Orchestrator.startTask", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a DETECTED task and transitions to CONTEXT_BUILDING", async () => {
    // arrange / act / assert
  });
});
```

## Coverage gates

`npm run test:coverage` (V8 provider). Coverage thresholds, when configured, are enforced from [vitest.config.ts](../../vitest.config.ts). Do not lower them without justification.

## Pre-commit gate (mandatory)

```sh
npm test            # unit + integration
npm run typecheck   # zero TS errors
npm run lint        # zero ESLint errors
```

