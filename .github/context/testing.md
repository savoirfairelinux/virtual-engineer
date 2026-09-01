# Testing

## Frameworks

- **Vitest** (`npm test`, `npm run test:watch`, `npm run test:coverage`) for all unit + integration specs in `tests/unit/`. Tests use the Node environment by default; targeted React behavior specs opt into jsdom with `@vitest-environment jsdom` and use Testing Library. Vitest is the **only** test runner — there is no Playwright setup and no `tests/e2e/` directory.

## Layout

```text
tests/
  unit/
    admin-ui/               # jsdom/server-rendered Configuration SPA specs
    helpers/                # fixtures + builders
    *.test.ts[x]            # one file per source module + integration scenarios
```

### Test families by area

`tests/unit/` currently holds 150+ test files. This table lists the families; run `ls tests/unit/` for the authoritative, always-current list.

| Area | Families (file-name stems) |
|---|---|
| Admin routes / server + UI | `adminServer` (+ `.behavior`, `.integration`), `adminUiSse`, `adminImageProxy`, `imageProxyTokenStore`, `adminHealthEndpoint`, `adminOverviewRoutes`, `adminPluginRoutes`, `adminPromptRoutes`, `adminAgentsRoutes`, `adminAgentsOAuthRoutes`, `adminProjectsRoutes` (+ `.relaunch`), `adminConcurrencyRoutes`, `adminSettingsRoutes`, `adminIntegrationsDiscover`, `adminWebhookSecretRoutes`, `adminCostRoutes`, `adminModelUsageRoutes`, `adminAuthService`, `adminAuthRoutes`, `adminServerRbac`, `adminPoliciesRoutes`, `adminRuntimePolicyRoutes`, `adminRuntimeStatusRoute`, `runtimePolicyValidation`, `adminAudit`, `adminAuditRoutes`, `commonPasswords`, `loginRateLimiter`, `closeAdminServer`, `dashboard` (+ `.configurationTab`), `agentFormModal`, `toolAuthorizationSection`, `toolUsageSummary`, `projectFormModal`, `apiIdentityBoundary`, `appIdentityHandoff`, `configDirtyRace`, `configRouting`, `configPageSurface`, `configNavigation`, `configPermissions`, `guidedTour`, `topBar`, `identityReset` |
| Orchestrator / polling | `orchestrator` (+ `.projectMode`, `.webhookEntryPoints`, `.concurrency`), `orchestratorCommitMessage`, `pollingLoop.projects`, `pollingLoop.concurrency`, `pollingLoop.reviewPolling`, `pollingLoop.stalledTasks`, `pollingLoop.updateConfig`, `concurrencyTracker`, `taskLifecycleCoordinator`, `feedbackProcessor`, `reviewProgressService`, `pauseResumeFlow` |
| State / stores | `taskDomain`, `stateMachine`, `stateStore` (+ `.projects`, `.cost`, `.reviewDedup`, `.modelUsage`), `settingsStore`, `databaseMigrations`, `migrations.projects`, `integrationStore`, `promptStore`, `runtimePolicyStore` (runtime policies/denials), `userStore`, `auditStore`, `pbacStores` |
| PBAC / authorization | `policyEngine`, `permissions`, `pbacStores`, `adminPoliciesRoutes`, `adminServerRbac` (project-scoping suite) |
| Connectors — Redmine | `redmineConnector`, `redmineDiscovery`, `webhookHandlerRedmine` |
| Connectors — Gerrit | `gerritConnector`, `gerritDiscovery`, `gerritSshDiscovery`, `gerritSshClient`, `gerritSshKeyPair`, `gerritSshReviewProvider`, `gerritStreamEvents`, `gerritVcsConnector` |
| Connectors — GitLab | `gitlabHttpClient`, `gitlabIssueConnector`, `gitlabIssueDiscovery`, `gitlabMergeRequestConnector`, `gitlabMergeRequestDiscovery`, `gitlabMergeRequestReviewProvider`, `gitlabVcsConnector`, `gitlabAuth`, `webhookHandlerGitlabIssue`, `webhookHandlerGitlabMergeRequest` |
| Connectors — GitHub | `githubIssueConnector`, `githubPullRequestReviewConnector`, `githubReviewProvider`, `githubVcsConnector`, `githubPluginDescriptors`, `githubOAuth`, `githubAuth`, `githubConnectionValidator`, `branchNaming`, `webhookHandlerGithubPullRequest` |
| VCS (shared) | `vcsConnector`, `vcsFactory`, `gitRunner`, `nodeGitRunner`, `baseTicketConnector` |
| Agents / shared + Copilot | `providerOptions`, `toolAuthorization`, `toolAuthorizationValidation`, `agentStderrPipeline`, `copilotAdapter` (+ `.promptInjection`), `containerSpecBuilders` (cross-provider contract), `copilotWorker`, `mcpSubmission`, `copilotConnectionValidator`, `copilotOAuthService`, `copilotModelsService`, `providerAuthService`, `agentEventTypes` (+ `.normalization`), `workerCommitProtocol`, `workerPromptLoader`, `workerCopilotProvider`, `workerClaudeProvider`, `workerNetworkGuard`, `workerToolAuthorization`, `workerSkills` |
| Agents / Claude | `claudeAdapter`, `claudeDescriptor`, `claudeOAuth`, `claudeWorker`, `claudeConnectionValidator` |
| Agents / Aider | `aiderAdapter`, `aiderDescriptor`, `aiderConnectionValidator`, `aiderModelsService`, `aiderWorker` |
| Agents / Goose | `gooseAdapter`, `gooseDescriptor`, `gooseConnectionValidator`, `gooseModelsService`, `gooseWorker` |
| Agents / Codex | `codexAdapter`, `codexDescriptor`, `codexConnectionValidator`, `codexModelsService`, `workerCodexProvider` |
| Agents / Gemini CLI | `geminiAdapter`, `geminiDescriptor`, `geminiConnectionValidator`, `geminiModelsService`, `workerGeminiProvider` |
| Agents / OpenCode | `opencodeAdapter`, `opencodeDescriptor`, `opencodeConnectionValidator`, `opencodeModelsService`, `opencodeWorker` |
| Agents / Cursor | `cursorAdapter`, `cursorDescriptor`, `cursorConnectionValidator`, `cursorModelsService`, `workerCursorProvider` |
| Review runtime | `reviewOrchestrator`, `reviewRecovery`, `reviewRetriggerGuard`, `reviewStderrEvents`, `reviewPostingGate`, `reviewPromptBuilder`, `reviewOutputContract` (covered through parser/orchestrator suites), `reviewResultParser`, `reviewLiveLogs`, `liveLogFormat`, `liveLogWindow`, `agentCyclePresentation`, `commentHash`, `commentSeverity`, `revisionPatchset` |
| Cost / token tracking | `cycleCost`, `stateStore.cost`, `adminCostRoutes`, `liveMetrics`, `workerClaudeProvider` |
| Plugins / runtime wiring | `pluginManager` (+ `.multiInstance`), `registry`, `runtimeBootstrap` (historical name; covers bootstrap wiring in `src/index.ts`), `runtimeStartup`, `openShellWorkspaceRunner`, `openShellSandboxReconciler`, `runtimePolicyResolver`, `agentWorkerProtocol`, `openshell`, `hostGitExecutor`, `runnerContract`, `integrationStreamEvents` |
| Webhooks | `webhookServer`, `webhookHandlerRegistry` (+ the per-provider handlers listed above) |
| Workspace / utils / misc | `workspaceRunner`, `workspaceManifestScanner`, `repositoryManifestAccess`, `workspaceScanService` (direct config-error coverage plus admin route integration tests), `sshKeyResolver`, `sshFilePath`, `skillSourceDiscovery`, `buildRepositoryMap`, `config`, `logger`, `encryption`, `errorClassifier`, `gitExec`, `redactUrl`, `startScript`, `ticketFooterFormatter` |

Experimental Copilot native review coverage spans `agentFormModal`, `adminPluginRoutes`, `adminAgentsRoutes`, `adminProjectsRoutes`, `runtimeBootstrap`, `reviewOrchestrator`, `containerSpecBuilders`, `copilotAdapter`, `copilotWorker`, `workerNetworkGuard`, and `mcpSubmission`. Unit tests prove descriptor-driven UI canonicalization, agent-owned override precedence, strategy env propagation, exact `task(code-review, sync)` permission/provenance, and exactly one accepted MCP submission. A real-token smoke test is intentionally opt-in and must run in the hardened image after Copilot SDK/CLI lockfile upgrades; it must verify one native delegation, one valid submission artifact, no workspace mutation, and no direct fallback.

> **There are integration tests today.** Files ending in `.integration.test.ts` wire several modules together with mocked external I/O.

## Conventions

- OpenShell denial tests cover both OCSF shorthand and key-value log formats; runner tests inject `getSandboxLogs` and assert task/project-attributed persistence on success and setup failure without requiring a live gateway. Overlapping snapshots must persist each raw event line once, preserve a later same-payload line with a distinct timestamp, and retry sink failures.

- All external I/O is mocked: `fetch`, `node:fs`, the OpenShell CLI (`child_process`), `child_process` SSH helpers, the GitHub Copilot SDK, Git network calls. Never hit real services.
- OpenShell runner tests assert that agent credentials are attached at sandbox creation and omitted from exec-time environment arguments; only non-secret values such as prompt-file paths may be forwarded to `sandbox exec`.
- OpenShell command-runner tests use a simulated detached child process to assert that output retained across stdout/stderr stops at 32 MiB, live callbacks continue, and overflow escalates process-group termination from `SIGTERM` to `SIGKILL`.
- Live-log window tests keep React state updates pure and verify the 500-entry cap, matching dedup-key eviction, duplicate rejection inside the active window, and acceptance after eviction.
- Runtime-startup tests cover named-profile precedence over direct OpenShell endpoints, ordered review/code-gen recovery, best-effort initial reconciliation, scheduler startup, and idempotent shutdown without importing or mocking all of `src/index.ts`.
- Startup/deployment tests source `scripts/start-lib.sh` and `deploy/k8s/deploy-lib.sh`. They also exercise `scripts/install.sh` with local Git fixtures and a simulated Docker daemon, covering the fixed `./virtual-engineer` clone target, reuse of an existing checkout (including the current directory), and refusal to reuse an unrelated `./virtual-engineer` directory. Gateway readiness is covered by `wait_for_container_log` (simulated `docker logs`) plus contract assertions that Docker-mode startup waits for the gateway's `Server listening` line and reports registration and connection failures separately. They verify Docker-default/experimental-Kubernetes driver selection, official OpenShell Docker gateway TOML (including persistent gateway-JWT paths and container-reachable listeners), private bridge callback publication, exclusion of runtime `data/` and local artifacts from Docker build contexts, the agent image's required `sandbox` account, deterministic runtime hashing, strict private GHCR digest references, OpenShell 0.0.83/chart/image pins, fail-closed OIDC values, pull secrets in both namespaces, named-profile registration, and a sandbox namespace PSA level compatible with OpenShell's required capabilities while preserving restricted audit/warn reporting, without invoking Docker or k3s.
- OpenShell client tests cover explicit profile/endpoint flags, lazy client-credentials renewal, upload cancellation, and transient-create cleanup: an authentication failure triggers one shared login and one safe control-plane command replay, direct endpoints never attempt profile login, `sandbox exec` stderr never triggers replay, and cancellation cannot start another create attempt or a post-login replay after ambiguous-resource cleanup.
- Review orchestrator race tests must model patchset changes during agent execution and assert that the stale pass has no provider or posting-ledger side effects; a newer patchset requires a fresh checkout, diff, and agent run before posting. One deadline covers provider reads, capacity, abortable host-Git preparation, agent termination, freshness, posting/replies, and final status; clone cleanup waits for termination, while a post timeout preserves ambiguous `REVIEW_COMMENTING`.
- Agent-cycle lifecycle tests assert that code-generation and review orchestration persist `running` before the agent promise settles, then finalize the same task/cycle row; exception and cancellation paths must never leave a stale running result. State-store tests also cover atomic cycle allocation/upsert, legacy duplicate consolidation, and uniqueness under concurrent finalization.
- Task-detail request tests use the pure `taskDetailRequests` helper to prove that out-of-order polls and responses for a previously selected task cannot overwrite current cycle state, that slow same-task polls cannot overlap indefinitely, that a terminal task reload invalidates an older running snapshot, and that a delayed delete response cannot clear a newer selection. SSE tests likewise reject a chunk resolved after cleanup.
- Review recovery tests keep code-gen dispatch separate and cover restart behavior for `REVIEW_PENDING`, `REVIEW_RUNNING`, `REVIEW_COMMENTING`, and `REVIEW_WATCHING`, including existing-cycle reuse, concurrent claim loss, closed-change finalization, and parallel startup recovery; cancellation tests assert that timeout reaches the OpenShell command before workspace cleanup and provider effects.
- OpenShell cleanup tests assert that a failed sandbox delete retains attempt ownership for retry while host Git cleanup remains independent. Reconciler tests cover active, recent, foreign, orphaned, failed-delete, idempotent scheduling, and non-overlapping runs.
- Concurrency tracker tests retain every acquired lease and release that same lease. Lifecycle coordinator regressions cover pre-start cancellation, review posting cancellation, creation leases, and project tombstoning before deletion waits. Broader coverage includes overlapping acquisitions across an agent integration change, idempotent double release, abort-during-drain queue ordering, whole-review queue timeouts, serialized poll/webhook/admin lifecycle operations, active-task execution-identity reconfiguration rejection (while idempotent full-form saves remain allowed), atomic parent/child project rollback, and setup failures before a code-generation cycle row exists.
- Task-log and global SSE tests disconnect before or during initial store reads and assert that listeners/timers are never installed or are removed before history resumes; client-side SSE tests reject chunks resolved after cleanup. Task-detail action tests also reject errors from a previously selected task.
- Workspace scan route tests model recursive provider reads explicitly: only matched enabled gitlinks are followed, while contrib package and CMake declarations are parsed as data and never executed.
- Workspace scan regressions cover revision-sensitive traversal identities, local/unsupported URI filtering, the eight-request GitHub/GitLab content-read bound, and clone-URL-scoped admin errors.
- kas coverage asserts that unrelated YAML never consumes the manifest budget (300 Helm-style values files plus over-quota kas candidates must still return a successful, truncated selection), that non-kas YAML is skipped without diagnostics, and that `origin` classification distinguishes internal, pushable, and patch-only members.
- BitBake coverage asserts that recipes are read only when the listing also exposes a kas candidate, that they consume their own budget rather than the manifest one, that they are ignored unless a kas config declared an internal layer, and that `${…}` URLs held in same-file variables or `*SRC_URI` aliases still resolve while genuinely unresolvable ones are skipped.
- React component behavior tests use Testing Library under a per-file jsdom environment. Keep the global Vitest environment as Node so server suites retain their current runtime; pure UI serializers and server-rendered surfaces stay Node tests where possible.
- `npm run typecheck:ui` runs both `tsconfig.admin-ui.json` (SPA source) and `tsconfig.admin-ui-tests.json` (jsdom/server-rendered Configuration specs under `tests/unit/admin-ui/`). Those tests are excluded from the Node-only root `tsconfig.json` pass; the same directory is also used by ESLint and `Dockerfile.orchestrator`, so adding another Configuration UI test requires no tooling inventory update.
- MCP submission tests cover the persisted artifact, SDK start/complete correlation, failed-payload error propagation, correction of rejected attempts, and exactly one accepted submission; review permission tests cover the configured and declared VE server identities, raw/CLI-qualified tool names, safe permission telemetry, and rejection of cross-alias or unrelated tools.
- Mock with `vi.mock("…/foo.js", () => …)` for module-level stubs, or `vi.spyOn(obj, "method")` for instance-level.
- Gerrit SSH tests mock `child_process.execFile` callbacks with `{ stdout, stderr }` objects because the connectors promisify that API.
- Use `vi.useFakeTimers()` + `vi.runAllTimersAsync()` for the polling loop. **Always** call `loop.stop()` before `runAllTimersAsync` (Vitest aborts after 10 000 timer iterations otherwise).
- Reset shared state in `beforeEach` (`vi.clearAllMocks()`, `resetConfig()` from `src/config.ts`, fresh in-memory SQLite).
- Helper builders / fixtures live in `tests/unit/helpers/` — prefer extending them over inlining.
- VCS connector tests inject `RecordingGitRunner` from `tests/unit/helpers/recordingGitRunner.ts` to record argument arrays/options and control async outputs or failures without spawning Git.
- Admin route tests with a reduced `stateStore` that intentionally omit user/session or PBAC rule-resolution methods must set `allowUnauthenticatedAdmin: true`; production-style auth tests use the full store and leave the fail-closed default unchanged. The escape hatch is rejected when `nodeEnv` is `production`.
- Remote skill source tests (`skillSourceDiscovery`) must mock `child_process`. They cover pinned `npx skills` list commands, bounded timeouts, SSH URL resolution with per-source user/port/known-hosts, agent- vs key-backed SSH env, approved-secrets-root enforcement, and that arbitrary orchestrator env vars (including `SSH_AUTH_SOCK` when unneeded) are never forwarded.
- Provider worker tests verify native repository behavior: Copilot enables config discovery without explicit skill directories, Claude enables user/project settings and all native skills without a VE plugin, and Aider receives no VE-injected repository manifests.
- Container-spec contract tests run the shared builders and all eight agent adapters (Copilot, Claude, Aider, Goose, Codex, Gemini CLI, OpenCode, Cursor) against the same code-generation/review expectations, including default review image selection. Command, prompt, Git identity, and skill environment behavior must remain provider-aligned; auth and model fields remain provider-specific. Sandbox isolation is asserted through OpenShell runtime policies, not per-container flags.
- Aider worker lifecycle tests cover code-generation/review arguments, environment allowlisting, output/error parsing, spawn failure, and timeout rejection with subprocess and temporary-directory cleanup.
- Copilot and Claude worker lifecycle tests mock their exact worker-resolved SDK entry points. They cover code-generation/review prompt setup, event/usage/result mapping, native discovery configuration, error/timeout teardown, subprocess environment allowlisting, and no-secret event output.
- `nodeGitRunner` tests use the Node executable as a deterministic child process to cover success, non-zero exit, timeout, cancellation, output caps, and credential redaction without invoking Git or a shell.
- Create file-backed SQLite test databases with `tempDatabasePath()` from `tests/unit/helpers/tempDatabase.ts`; it removes the database, WAL/SHM sidecars, and optional dedicated directory after each test.
- Migration tests exercise the shared runtime runner directly for fresh databases, ledger validation/idempotence, recognized legacy adoption (including appended columns, SQLite integer-PK/index artifacts, and known retired fields), schema/index/trigger drift, AUTOINCREMENT continuity, predecessor-binding preservation, unknown-database rejection, and transactional rollback. Keep those cases aligned with the version-controlled `drizzle/` history.
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

`npm run test:coverage` uses the V8 provider and is the test command enforced by CI. Global floors are 79% statements, 68% branches, 84% functions, and 82% lines. Security-critical per-file floors (statements / branches / functions / lines) are:

- `src/admin/adminImageProxy.ts`: 90 / 75 / 100 / 91
- `src/admin/adminServer.ts`: 84 / 85 / 96 / 84
- `src/webhooks/webhookServer.ts`: 81 / 71 / 96 / 83
- `src/utils/gitlabAuth.ts`: 63 / 63 / 61 / 66

Shared infrastructure and extracted workflow modules also have focused non-regression floors:

- `src/agents/containerSpecBuilders.ts`: 100 / 96 / 100 / 100
- `src/vcs/gitRunner.ts`: 100 / 50 / 100 / 100
- `src/vcs/nodeGitRunner.ts`: 92 / 78 / 100 / 95
- `src/orchestrator/reviewProgressService.ts`: 88 / 73 / 93 / 89

These are truthful non-regression ratchets based on measured coverage. Raise them as coverage improves; do not lower them merely to land a change. Threshold failure must fail CI.

## Pre-commit gate (mandatory)

```sh
npm test            # unit + integration
npm run typecheck   # zero TS errors
npm run lint        # zero ESLint errors
```

## Related docs

- [INDEX.md](INDEX.md) — navigable context index
- [configuration.md](configuration.md) — env-var stubbing and `resetConfig`
- [modules/orchestrator.md](modules/orchestrator.md) — orchestrator test families
- [modules/agents.md](modules/agents.md) — agent test families
- [copilot-instructions.md](../copilot-instructions.md) — Build & Test block (always-loaded)
