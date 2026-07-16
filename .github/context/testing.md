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
| Orchestrator / polling | `orchestrator` (+ `.projectMode`, `.webhookEntryPoints`, `.concurrency`), `orchestratorCommitMessage`, `pollingLoop.projects`, `pollingLoop.concurrency`, `pollingLoop.reviewPolling`, `pollingLoop.updateConfig`, `concurrencyTracker`, `taskLifecycleCoordinator`, `feedbackProcessor`, `pauseResumeFlow` |
| State / stores | `stateMachine`, `stateStore` (+ `.projects`, `.cost`), `settingsStore`, `migrations.projects`, `integrationStore`, `promptStore`, `runtimePolicyStore` (runtime policies/denials), `userStore`, `auditStore`, `pbacStores` |
| PBAC / authorization | `policyEngine`, `permissions`, `pbacStores`, `adminPoliciesRoutes`, `adminServerRbac` (project-scoping suite) |
| Connectors — Redmine | `redmineConnector`, `redmineDiscovery`, `webhookHandlerRedmine` |
| Connectors — Gerrit | `gerritConnector`, `gerritDiscovery`, `gerritSshDiscovery`, `gerritSshClient`, `gerritSshReviewProvider`, `gerritStreamEvents`, `gerritVcsConnector` |
| Connectors — GitLab | `gitlabHttpClient`, `gitlabIssueConnector`, `gitlabIssueDiscovery`, `gitlabMergeRequestConnector`, `gitlabMergeRequestDiscovery`, `gitlabMergeRequestReviewProvider`, `gitlabVcsConnector`, `gitlabAuth`, `webhookHandlerGitlabIssue`, `webhookHandlerGitlabMergeRequest` |
| Connectors — GitHub | `githubIssueConnector`, `githubPullRequestReviewConnector`, `githubReviewProvider`, `githubVcsConnector`, `githubPluginDescriptors`, `githubOAuth`, `githubAuth`, `branchNaming`, `webhookHandlerGithubPullRequest` |
| VCS (shared) | `vcsConnector`, `vcsFactory`, `baseTicketConnector` |
| Agents / Copilot | `copilotAdapter` (+ `.promptInjection`), `copilotConnectionValidator`, `copilotOAuthService`, `copilotModelsService`, `providerAuthService`, `mockAgentAdapter`, `agentEventTypes` (+ `.normalization`), `workerCommitProtocol`, `workerPromptLoader`, `workerCopilotProvider`, `workerClaudeProvider` |
| Review runtime | `copilotReviewAgent`, `reviewOrchestrator`, `reviewRecovery`, `reviewPromptBuilder`, `reviewResultParser`, `reviewLiveLogs`, `liveLogFormat`, `liveLogWindow`, `agentCyclePresentation`, `commentHash`, `commentSeverity`, `revisionPatchset` |
| Cost / token tracking | `cycleCost`, `stateStore.cost`, `adminCostRoutes`, `liveMetrics`, `workerClaudeProvider` |
| Plugins / runtime wiring | `pluginManager` (+ `.multiInstance`), `registry`, `openShellWorkspaceRunner`, `openShellSandboxReconciler`, `runtimePolicyResolver`, `runtimeStartup`, `agentWorkerProtocol`, `openshell`, `hostGitExecutor`, `runnerContract`, `integrationStreamEvents` |
| Webhooks | `webhookServer`, `webhookHandlerRegistry` (+ the per-provider handlers listed above) |
| Workspace / utils / misc | `buildRepositoryMap`, `config`, `logger`, `encryption`, `errorClassifier`, `gitExec`, `startScript`, `ticketFooterFormatter` |

> **There are integration tests today.** Files ending in `.integration.test.ts` wire several modules together with mocked external I/O.

## Conventions

- OpenShell denial tests cover both OCSF shorthand and key-value log formats; runner tests inject `getSandboxLogs` and assert task/project-attributed persistence on success and setup failure without requiring a live gateway. Overlapping snapshots must persist each raw event line once, preserve a later same-payload line with a distinct timestamp, and retry sink failures.

- All external I/O is mocked: `fetch`, `node:fs`, `dockerode`, `child_process` SSH helpers, the GitHub Copilot SDK, Git network calls. Never hit real services.
- OpenShell runner tests assert that agent credentials are attached at sandbox creation and omitted from exec-time environment arguments; only non-secret values such as prompt-file paths may be forwarded to `sandbox exec`.
- OpenShell command-runner tests use a simulated detached child process to assert that output retained across stdout/stderr stops at 32 MiB, live callbacks continue, and overflow escalates process-group termination from `SIGTERM` to `SIGKILL`.
- Live-log window tests keep React state updates pure and verify the 500-entry cap, matching dedup-key eviction, duplicate rejection inside the active window, and acceptance after eviction.
- Runtime-startup tests cover named-profile precedence over direct OpenShell endpoints, ordered review/code-gen recovery, best-effort initial reconciliation, scheduler startup, and idempotent shutdown without importing or mocking all of `src/index.ts`.
- Startup/deployment tests source `scripts/start-lib.sh` and `deploy/k8s/deploy-lib.sh`. They verify deterministic runtime hashing, strict private GHCR digest references, OpenShell 0.0.83/chart/image pins, fail-closed OIDC values, pull secrets in both namespaces, named-profile registration, and a sandbox namespace PSA level compatible with OpenShell's required capabilities while preserving restricted audit/warn reporting, without invoking Docker or k3s.
- OpenShell client tests cover explicit profile/endpoint flags, lazy client-credentials renewal, upload cancellation, and transient-create cleanup: an authentication failure triggers one shared login and one safe control-plane command replay, direct endpoints never attempt profile login, `sandbox exec` stderr never triggers replay, and cancellation cannot start another create attempt or a post-login replay after ambiguous-resource cleanup.
- Review orchestrator race tests must model patchset changes during agent execution and assert that the stale pass has no provider or posting-ledger side effects; a newer patchset requires a fresh checkout, diff, and agent run before posting. One deadline covers provider reads, capacity, abortable host-Git preparation, agent termination, freshness, posting/replies, and final status; clone cleanup waits for termination, while a post timeout preserves ambiguous `REVIEW_COMMENTING`.
- Agent-cycle lifecycle tests assert that code-generation and review orchestration persist `running` before the agent promise settles, then finalize the same task/cycle row; exception and cancellation paths must never leave a stale running result. State-store tests also cover atomic cycle allocation/upsert, legacy duplicate consolidation, and uniqueness under concurrent finalization.
- Task-detail request tests use the pure `taskDetailRequests` helper to prove that out-of-order polls and responses for a previously selected task cannot overwrite current cycle state, that slow same-task polls cannot overlap indefinitely, that a terminal task reload invalidates an older running snapshot, and that a delayed delete response cannot clear a newer selection. SSE tests likewise reject a chunk resolved after cleanup.
- Review recovery tests keep code-gen dispatch separate and cover restart behavior for `REVIEW_PENDING`, `REVIEW_RUNNING`, `REVIEW_COMMENTING`, and `REVIEW_WATCHING`, including existing-cycle reuse, concurrent claim loss, closed-change finalization, and parallel startup recovery; cancellation tests assert that timeout reaches the OpenShell command before workspace cleanup and provider effects.
- OpenShell cleanup tests assert that a failed sandbox delete retains attempt ownership for retry while host Git cleanup remains independent. Reconciler tests cover active, recent, foreign, orphaned, failed-delete, idempotent scheduling, and non-overlapping runs.
- Concurrency tracker tests retain every acquired lease and release that same lease. Lifecycle coordinator regressions cover pre-start cancellation, review posting cancellation, creation leases, and project tombstoning before deletion waits. Broader coverage includes overlapping acquisitions across an agent integration change, idempotent double release, abort-during-drain queue ordering, whole-review queue timeouts, serialized poll/webhook/admin lifecycle operations, active-task execution-identity reconfiguration rejection (while idempotent full-form saves remain allowed), atomic parent/child project rollback, and setup failures before a code-generation cycle row exists.
- Task-log and global SSE tests disconnect before or during initial store reads and assert that listeners/timers are never installed or are removed before history resumes; client-side SSE tests reject chunks resolved after cleanup. Task-detail action tests also reject errors from a previously selected task.
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

