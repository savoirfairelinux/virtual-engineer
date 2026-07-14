# Testing

## Frameworks

- **Vitest** (`npm test`, `npm run test:watch`, `npm run test:coverage`) for all unit + integration specs in `tests/unit/`. Vitest is the **only** test framework — there is no Playwright setup and no `tests/e2e/` directory.

## Layout

```text
tests/
  unit/
    helpers/                # fixtures + builders
    *.test.ts               # one file per source module + integration scenarios
```

### Test families by area

`tests/unit/` currently holds ~100 test files. This table lists the families; run `ls tests/unit/` for the authoritative, always-current list.

| Area | Families (file-name stems) |
|---|---|
| Admin routes / server | `adminServer` (+ `.behavior`, `.integration`), `adminUiSse`, `adminHealthEndpoint`, `adminPluginRoutes`, `adminPromptRoutes`, `adminAgentsRoutes`, `adminAgentsOAuthRoutes`, `adminProjectsRoutes` (+ `.relaunch`), `adminConcurrencyRoutes`, `adminSettingsRoutes`, `adminIntegrationsDiscover`, `adminWebhookSecretRoutes`, `adminCostRoutes`, `adminAuthService`, `adminAuthRoutes`, `adminServerRbac`, `adminPoliciesRoutes`, `runtimePolicyValidation`, `adminAudit`, `adminAuditRoutes`, `commonPasswords`, `loginRateLimiter`, `closeAdminServer`, `dashboard` (+ `.configurationTab`) |
| Orchestrator / polling | `orchestrator` (+ `.projectMode`, `.webhookEntryPoints`, `.concurrency`), `orchestratorCommitMessage`, `pollingLoop.projects`, `pollingLoop.concurrency`, `pollingLoop.reviewPolling`, `pollingLoop.updateConfig`, `concurrencyTracker`, `feedbackProcessor`, `pauseResumeFlow` |
| State / stores | `stateMachine`, `stateStore` (+ `.projects`, `.cost`), `settingsStore`, `migrations.projects`, `integrationStore`, `promptStore`, `runtimePolicyStore` (runtime policies/denials), `userStore`, `auditStore`, `pbacStores` |
| PBAC / authorization | `policyEngine`, `permissions`, `pbacStores`, `adminPoliciesRoutes`, `adminServerRbac` (project-scoping suite) |
| Connectors — Redmine | `redmineConnector`, `redmineDiscovery`, `webhookHandlerRedmine` |
| Connectors — Gerrit | `gerritConnector`, `gerritDiscovery`, `gerritSshDiscovery`, `gerritSshClient`, `gerritSshReviewProvider`, `gerritStreamEvents`, `gerritVcsConnector` |
| Connectors — GitLab | `gitlabHttpClient`, `gitlabIssueConnector`, `gitlabIssueDiscovery`, `gitlabMergeRequestConnector`, `gitlabMergeRequestDiscovery`, `gitlabMergeRequestReviewProvider`, `gitlabVcsConnector`, `gitlabAuth`, `webhookHandlerGitlabIssue`, `webhookHandlerGitlabMergeRequest` |
| Connectors — GitHub | `githubIssueConnector`, `githubPullRequestReviewConnector`, `githubReviewProvider`, `githubVcsConnector`, `githubPluginDescriptors`, `githubOAuth`, `githubAuth`, `branchNaming`, `webhookHandlerGithubPullRequest` |
| VCS (shared) | `vcsConnector`, `vcsFactory`, `baseTicketConnector` |
| Agents / Copilot | `copilotAdapter` (+ `.promptInjection`), `copilotConnectionValidator`, `copilotOAuthService`, `copilotModelsService`, `providerAuthService`, `mockAgentAdapter`, `agentEventTypes` (+ `.normalization`), `workerCommitProtocol`, `workerPromptLoader`, `workerCopilotProvider`, `workerClaudeProvider` |
| Review runtime | `copilotReviewAgent`, `reviewOrchestrator`, `reviewPromptBuilder`, `reviewResultParser`, `reviewLiveLogs`, `commentHash`, `commentSeverity`, `revisionPatchset` |
| Cost / token tracking | `cycleCost`, `stateStore.cost`, `adminCostRoutes`, `liveMetrics`, `workerClaudeProvider` |
| Plugins / runtime wiring | `pluginManager` (+ `.multiInstance`), `registry`, `openShellWorkspaceRunner`, `runtimePolicyResolver`, `agentWorkerProtocol`, `openshell`, `hostGitExecutor`, `runnerContract`, `integrationStreamEvents` |
| Webhooks | `webhookServer`, `webhookHandlerRegistry` (+ the per-provider handlers listed above) |
| Workspace / utils / misc | `buildRepositoryMap`, `config`, `logger`, `encryption`, `errorClassifier`, `gitExec`, `ticketFooterFormatter` |

> **There are integration tests today.** Files ending in `.integration.test.ts` wire several modules together with mocked external I/O.

## Conventions

- OpenShell denial tests cover both OCSF shorthand and key-value log formats; runner tests inject `getSandboxLogs` and assert task/project-attributed persistence on success and setup failure without requiring a live gateway.

- All external I/O is mocked: `fetch`, `node:fs`, `dockerode`, `child_process` SSH helpers, the GitHub Copilot SDK, Git network calls. Never hit real services.
- OpenShell runner tests assert that agent credentials are attached at sandbox creation and omitted from exec-time environment arguments; only non-secret values such as prompt-file paths may be forwarded to `sandbox exec`.
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

