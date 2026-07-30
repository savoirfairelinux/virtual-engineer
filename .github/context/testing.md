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
| Admin routes / server + UI | `adminServer` (+ `.behavior`, `.integration`), `adminImageProxy`, `adminHealthEndpoint`, `adminPluginRoutes`, `adminPromptRoutes`, `adminAgentsRoutes`, `adminAgentsOAuthRoutes`, `adminProjectsRoutes` (+ `.relaunch`), `adminConcurrencyRoutes`, `adminSettingsRoutes`, `adminIntegrationsDiscover`, `adminWebhookSecretRoutes`, `adminCostRoutes`, `adminAuthService`, `adminAuthRoutes`, `adminServerRbac`, `adminPoliciesRoutes`, `adminAudit`, `adminAuditRoutes`, `commonPasswords`, `loginRateLimiter`, `closeAdminServer`, `dashboard` (+ `.configurationTab`), `agentFormModal`, `projectFormModal`, `apiIdentityBoundary`, `appIdentityHandoff`, `configDirtyRace`, `configRouting`, `configPageSurface`, `configNavigation`, `configPermissions`, `identityReset` |
| Orchestrator / polling | `orchestrator` (+ `.projectMode`, `.webhookEntryPoints`, `.concurrency`), `orchestratorCommitMessage`, `pollingLoop.projects`, `pollingLoop.concurrency`, `pollingLoop.reviewPolling`, `pollingLoop.stalledTasks`, `pollingLoop.updateConfig`, `concurrencyTracker`, `feedbackProcessor`, `reviewProgressService`, `pauseResumeFlow` |
| State / stores | `taskDomain`, `stateMachine`, `stateStore` (+ `.projects`, `.cost`), `settingsStore`, `migrations.projects`, `integrationStore`, `promptStore`, `userStore`, `auditStore`, `pbacStores` |
| PBAC / authorization | `policyEngine`, `permissions`, `pbacStores`, `adminPoliciesRoutes`, `adminServerRbac` (project-scoping suite) |
| Connectors — Redmine | `redmineConnector`, `redmineDiscovery`, `webhookHandlerRedmine` |
| Connectors — Gerrit | `gerritConnector`, `gerritDiscovery`, `gerritSshDiscovery`, `gerritSshClient`, `gerritSshReviewProvider`, `gerritStreamEvents`, `gerritVcsConnector` |
| Connectors — GitLab | `gitlabHttpClient`, `gitlabIssueConnector`, `gitlabIssueDiscovery`, `gitlabMergeRequestConnector`, `gitlabMergeRequestDiscovery`, `gitlabMergeRequestReviewProvider`, `gitlabVcsConnector`, `gitlabAuth`, `webhookHandlerGitlabIssue`, `webhookHandlerGitlabMergeRequest` |
| Connectors — GitHub | `githubIssueConnector`, `githubPullRequestReviewConnector`, `githubReviewProvider`, `githubVcsConnector`, `githubPluginDescriptors`, `githubOAuth`, `githubAuth`, `githubConnectionValidator`, `branchNaming`, `webhookHandlerGithubPullRequest` |
| VCS (shared) | `vcsConnector`, `vcsFactory`, `gitRunner`, `nodeGitRunner`, `baseTicketConnector` |
| Agents / shared + Copilot | `providerOptions`, `copilotAdapter` (+ `.promptInjection`), `containerSpecBuilders` (cross-provider contract), `copilotWorker`, `mcpSubmission`, `copilotConnectionValidator`, `copilotOAuthService`, `copilotModelsService`, `providerAuthService`, `mockAgentAdapter`, `agentEventTypes` (+ `.normalization`), `workerCommitProtocol`, `workerNetworkGuard`, `workerSkills` |
| Agents / Claude | `claudeAdapter`, `claudeWorker`, `claudeConnectionValidator`, `claudeModelsService` |
| Agents / Aider | `aiderAdapter`, `aiderDescriptor`, `aiderConnectionValidator`, `aiderModelsService`, `aiderWorker` |
| Review runtime | `reviewOrchestrator`, `reviewPromptBuilder`, `reviewOutputContract` (covered through parser/orchestrator suites), `reviewResultParser`, `reviewLiveLogs`, `commentHash`, `commentSeverity`, `revisionPatchset` |
| Cost tracking | `cycleCost`, `stateStore.cost`, `adminCostRoutes` |
| Plugins / runtime wiring | `pluginManager` (+ `.multiInstance`), `registry`, `runtimeBootstrap` (historical name; covers bootstrap wiring in `src/index.ts`), `integrationStreamEvents` |

Experimental Copilot native review coverage spans `agentFormModal`, `adminPluginRoutes`, `adminAgentsRoutes`, `adminProjectsRoutes`, `runtimeBootstrap`, `reviewOrchestrator`, `containerSpecBuilders`, `copilotAdapter`, `copilotWorker`, `workerNetworkGuard`, and `mcpSubmission`. Unit tests prove descriptor-driven UI canonicalization, agent-owned override precedence, strategy env propagation, exact `task(code-review, sync)` permission/provenance, and exactly one accepted MCP submission. A real-token smoke test is intentionally opt-in and must run in the hardened image after Copilot SDK/CLI lockfile upgrades; it must verify one native delegation, one valid submission artifact, no workspace mutation, and no direct fallback.
| Webhooks | `webhookServer`, `webhookHandlerRegistry` (+ the per-provider handlers listed above) |
| Workspace / utils / misc | `workspaceRunner` (+ `.multiTarget`), `workspaceManifestScanner`, `repositoryManifestAccess`, `workspaceScanService` (direct config-error coverage plus admin route integration tests), `dockerVolume`, `sshKeyResolver`, `sshFilePath`, `skillSourceDiscovery`, `buildRepositoryMap`, `config`, `logger`, `encryption`, `errorClassifier`, `gitExec`, `ticketFooterFormatter` |

> **There are integration tests today.** Files ending in `.integration.test.ts` wire several modules together with mocked external I/O.

## Conventions

- All external I/O is mocked: `fetch`, `node:fs`, `dockerode`, `child_process` SSH helpers, the GitHub Copilot SDK, Git network calls. Never hit real services.
- Workspace scan route tests model recursive provider reads explicitly: only matched enabled gitlinks are followed, while contrib package and CMake declarations are parsed as data and never executed.
- Workspace scan regressions cover revision-sensitive traversal identities, local/unsupported URI filtering, the eight-request GitHub/GitLab content-read bound, and clone-URL-scoped admin errors.
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
- Remote skill source tests must mock Docker/child_process paths. `workspaceRunner` covers pre-agent skill installation into the home volume, fast failure for SSH sources without `SSH_AUTH_SOCK` or `sshKeyPath`, and verifies the agent container does not receive `SKILL_SOURCES_JSON`, `SSH_AUTH_SOCK`, private-key paths, or `GIT_SSH_COMMAND`.
- Provider worker tests verify native repository behavior: Copilot enables config discovery without explicit skill directories, Claude enables user/project settings and all native skills without a VE plugin, and Aider receives no VE-injected repository manifests.
- Container-spec contract tests run the shared builders and all three container-backed adapters against the same code-generation/review expectations, including default review image/network selection. Common hardening, command, network, prompt, Git identity, and skill environment behavior must remain provider-aligned; auth and model fields remain provider-specific.
- Aider worker lifecycle tests cover code-generation/review arguments, environment allowlisting, output/error parsing, spawn failure, and timeout rejection with subprocess and temporary-directory cleanup.
- Copilot and Claude worker lifecycle tests mock their exact worker-resolved SDK entry points. They cover code-generation/review prompt setup, event/usage/result mapping, native discovery configuration, error/timeout teardown, subprocess environment allowlisting, and no-secret event output.
- `nodeGitRunner` tests use the Node executable as a deterministic child process to cover success, non-zero exit, timeout, cancellation, output caps, and credential redaction without invoking Git or a shell.
- Create file-backed SQLite test databases with `tempDatabasePath()` from `tests/unit/helpers/tempDatabase.ts`; it removes the database, WAL/SHM sidecars, and optional dedicated directory after each test.
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
