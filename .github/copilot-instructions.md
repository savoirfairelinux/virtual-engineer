# Virtual Engineer — Copilot Guidelines

Concise, accurate facts Copilot must rely on when working in this repo. For deeper context see [.github/context/INDEX.md](./context/INDEX.md).

## Documentation auto-sync

Whenever you modify code, also update the matching docs in `.github/`. Per-area rules live in [`.github/instructions/*.instructions.md`](./instructions/) and are loaded automatically by Copilot via their `applyTo` globs:

| When you change… | …also update |
|---|---|
| `src/state/schema.ts` / `stateStore.ts` / `migrate.ts` | `context/database.md` |
| `src/state/stateMachine.ts` / `interfaces.ts` (states) | `context/state-machine.md` + this file's transition map |
| `src/config.ts` | `context/configuration.md` + this file's env table |
| `src/agents/**` / `agent-worker/**` | `context/modules/agents.md` + container-spec bullets here |
| `src/connectors/**` / `src/vcs/**` / `src/plugins/**` | `context/modules/{connectors,vcs,plugins}.md` |
| `src/admin/**` | `context/modules/admin.md` |
| `src/orchestrator/**` | `context/modules/orchestrator.md` |
| `tests/**` | `context/testing.md` (inventory + conventions) |
| `package.json`, `Dockerfile.agent`, `vitest.config.ts`, `tsconfig.json`, … | this file's Build & Test block + relevant context doc |

Updates land in the **same commit** as the code change. If a change is purely internal (no observable impact on schema, config, contracts, or behaviour), no doc edit is required.

## Build & Test (gate every change)
```
npm test            # Vitest — must pass
npm run typecheck   # zero TypeScript errors
npm run lint        # zero ESLint errors
npm run dev         # start orchestrator (tsx src/index.ts)
npm run db:migrate  # apply Drizzle migrations
```

Helper scripts: `npm run e2e:mock`, `npm run create:ticket`, `npm run reset:instance`.

## Architecture (one screen)

- **Orchestrator** normally runs on the **host** in development (Node.js, `tsx src/index.ts`). Optional Docker deployment uses `scripts/start-orchestrator.sh` (host networking, admin UI bound to `127.0.0.1:3100`).
- For each agent cycle the host creates Docker **named volumes**, clones the repo into a volume via a helper container, spawns an **ephemeral Docker container** (`virtual-engineer-workspace:latest`) that edits files and may create one or more local commits; push operations also run in helper containers against the volume. The **host still owns review-system credentials and push orchestration** through `src/vcs/`. Container and volumes are destroyed on exit.
- **Container constraints** (set by `buildContainerSpec` in `src/agents/copilotAdapter.ts`): `--read-only` rootfs, `--cap-drop ALL`, `--security-opt no-new-privileges:true`, `--tmpfs /tmp:rw,nosuid,size=256m`, `/workspace` named-volume mount, `/ve-home` named-volume mount for Copilot HOME (native modules), optional `/ve-prompts` mount, `networkMode=virtual-engineer_ve-agent-net`.
- **Persistence**: SQLite WAL via `better-sqlite3` (sync) + Drizzle ORM at `DATABASE_PATH` (default `./data/virtual-engineer.db`).
- **Providers (per capability)**: issue_tracking = Redmine | GitLab Issues | GitHub Issues; code_review / source_control = Gerrit | GitLab Merge Requests | GitHub Pull Requests; agent_execution = Copilot | Mock. Provider credentials live on `integrations`, while GitLab project selection is VE-project-owned (`project_integration_bindings` issue_tracking `{ ticketProjectKey }`, `project_push_targets.repoKey`, code_review `{ repos }` bindings).
- **Admin server** (`src/admin/`) exposes the dashboard plus integrations, agents, projects, prompts, concurrency, and webhook-secret operations; secrets are masked on read and the runtime is hot-refreshed after integration changes.

### Source layout
```
src/
  index.ts              # process entry; boots admin + plugins + orchestrator
  config.ts             # Zod-validated AppConfig (loads .env)
  interfaces.ts         # branded IDs, TaskState, AgentSession, AgentResult, AgentLogEvent
  copilotModel.ts       # Copilot model defaults
  logger.ts             # Pino (silent in NODE_ENV=test by default)
  admin/                # Plain Node.js admin HTTP server + dashboard HTML
                        # adminServer (multiplexer/auth), adminRouteUtils,
                        # adminTaskRoutes, adminPromptRoutes, adminStreamRoutes,
                        # adminIntegrationRoutes, adminAgentsRoutes,
                        # adminProjectsRoutes, adminConcurrencyRoutes,
                        # adminWebhookRoutes, dashboard, start/close helpers
  agents/               # copilotAdapter, copilotConnectionValidator,
                        # copilotOAuthService, providerAuthService,
                        # copilotModelsService,
                        # mockAgentAdapter, agentEventTypes, agentEventBus
  connectors/           # redmineConnector, gerritConnector,
                        # gerritSshClient, gerritSshReviewProvider,
                        # gerritStreamEvents, integrationStreamEvents,
                        # gitlabIssueConnector, gitlabHttpClient,
                        # gitlabMergeRequestConnector, baseTicketConnector,
                        # githubIssueConnector, githubPullRequestReviewConnector

  plugins/              # registry, pluginManager, init, descriptors/{github,
                        # gitlab,gerrit,redmine,copilot,mock}.ts (unified
                        # provider descriptors; githubOAuth/gitlabOAuth helpers)
  review/               # reviewOrchestrator, copilotReviewAgent,
                        # prompt builder, parser
  state/                # schema (Drizzle), stateMachine, stateStore facade, migrate
    stores/             # domain-scoped DB modules: task, integration, project,
                        # prompt(+seeding), and agent(+concurrency)
  utils/                # ticketFooterFormatter, encryption
  vcs/                  # vcsConnector + gerritVcsConnector + gitlabVcsConnector + vcsFactory
  webhooks/             # webhook server + provider handlers
  workspace/            # dockerVolume (named-volume lifecycle + execInVolume)
                        # workspaceRunner (clone + container lifecycle)
agent-worker/index.js   # JS entry inside the agent container
```

## Critical Schema Facts
- `tasks` PK = `task_id` (TEXT). There is **no** `id` column. Key columns also include `task_type`, `gerrit_change_id`, `current_patchset`, `reviewed_patchset`, `project_id`, `ticket_source_integration_id`, `ticket_source_project_key`, `cycle_count`, `failure_reason`, `ticket_url`, `review_url`, `created_at`, `updated_at`. `ticket_source_integration_id` / `ticket_source_project_key` snapshot the originating ticket source so orphaned tasks can be adopted by a future project bound to the same ticket source.
- `state_transitions`, `agent_cycles`, `processed_comments` use INTEGER `id` PKs.
- `agent_cycles.agent_events` (TEXT, JSON `AgentLogEvent[]`) records the streamed agent log.
- `integrations` (TEXT `id` PK): `provider`, `name`, `config_json`, `enabled` (INTEGER), `discovered_resources_json`, `discovered_at`, timestamps. `provider` is one of `github | gitlab | gerrit | redmine | copilot | mock` (the former `type` column and the `category` concept were removed).
- `prompts` (TEXT `id` PK): `label`, `content`, timestamps. Used to inject `SYSTEM_PROMPT` / `INSTRUCTIONS_PROMPT` into the agent container.
- `change_per_repository` (TEXT `id` PK): `task_id`, `repo_key`, `change_id`, `review_url`, `status`, `integration_id`, `review_system`, `commit_index` (INTEGER NOT NULL DEFAULT 0), `subject_hash` (TEXT), timestamps. PK format: `${taskId}:${repoKey}:${commitIndex}` when commitIndex > 0, else `${taskId}:${repoKey}`. Status values: `OPEN`, `NEW`, `MERGED`, `ABANDONED`, `ORPHANED`, `NO_CHANGE`. The `review_system` column is **kept** (not renamed) and stores `gerrit | gitlab | github` via `VcsConnector.reviewSystemLabel`.
- `project_integration_bindings` (TEXT `id` PK): `project_id`, `integration_id`, `capability` (`issue_tracking | code_review | source_control | agent_execution`), `config_json`, timestamps. `UNIQUE(project_id, capability)` (`uq_pib_project_capability`). Replaces the dropped `project_ticket_source` / `project_review_integration` / `project_review_repos` tables. `config_json` shapes: issue_tracking = `{ ticketProjectKey }`; code_review = `{ repos: string[] }`. Cross-project ticket-source uniqueness is enforced in **application code** (throws), not by a DB unique index.
- Phase 2 tables also exist and are live: `agents`, `projects`, `project_integration_bindings`, `project_push_targets` (the `source_control` binding, unchanged), and singleton `app_concurrency`.
- `agents.enabled` defaults to `0` (disabled), not `1`.
- `agents.feedback_instructions_prompt_id` (nullable, FK → `prompts.id`) is an optional **per-agent override** used only on retry (feedback) cycles. When set on a coding agent, the orchestrator swaps it in as the instructions prompt for `cycleNumber > 1`; otherwise the regular `instructions_prompt_id` is reused. The seeded default prompt is `instructions_feedback_code` (from `prompts/instructions_feedback_code.md`).
- All `created_at`/`updated_at` are stored as **seconds since epoch** (Drizzle `mode: "timestamp"`). Correct query: `datetime(created_at, 'unixepoch')`.

Quick troubleshooting query:
```sql
SELECT task_id, state, cycle_count, failure_reason
FROM tasks WHERE ticket_id = 'X' ORDER BY created_at DESC;
```

## State Machine (`src/state/stateMachine.ts`)
Two task lifecycles share the same `TaskState` union:

- **Code-gen happy path**: `DETECTED → CONTEXT_BUILDING → AGENT_RUNNING → IN_REVIEW → MERGED → CLOSING → DONE`
- **Code-review happy path**: `REVIEW_PENDING → REVIEW_RUNNING → REVIEW_COMMENTING → REVIEW_WATCHING → REVIEW_DONE`

**Full transition map** (`VALID_TRANSITIONS`):
- `DETECTED → CONTEXT_BUILDING | FAILED`
- `CONTEXT_BUILDING → AGENT_RUNNING | FAILED`
- `AGENT_RUNNING → IN_REVIEW | RETRY_CYCLE | FAILED | ABANDONED`
- `IN_REVIEW → FEEDBACK_PROCESSING | MERGED | ABANDONED | FAILED`
- `FEEDBACK_PROCESSING → RETRY_CYCLE | IN_REVIEW | FAILED | ABANDONED`
- `RETRY_CYCLE → AGENT_RUNNING | ABANDONED | FAILED`
- `MERGED → CLOSING | DONE | FAILED`
- `CLOSING → DONE | FAILED`
- `REVIEW_PENDING → REVIEW_RUNNING | REVIEW_FAILED`
- `REVIEW_RUNNING → REVIEW_COMMENTING | REVIEW_FAILED`
- `REVIEW_COMMENTING → REVIEW_WATCHING | REVIEW_DONE | REVIEW_FAILED`
- `REVIEW_WATCHING → REVIEW_RUNNING | REVIEW_DONE | REVIEW_FAILED`

**Terminal**: `DONE`, `FAILED`, `ABANDONED`, `REVIEW_DONE`, `REVIEW_FAILED` (no outgoing transitions). Same-state → `"idempotent"`. Anything else → `InvalidTransitionError`.

**Pause/Resume** are NOT boolean columns. `stateStore.pauseTask()` writes a `state_transitions` row with `from_state == to_state` and `metadata.action = "pause"` (similarly for `"resume"`). Polling reads the latest pause-row to gate cycles.

**Retry counting** is source-aware (per-ticket FAILED/ABANDONED count vs. `MAX_RETRY_ATTEMPTS`). No-change agent outcomes can transition to `ABANDONED` instead of cycling.

## Key Configuration (`src/config.ts`)
All env vars are optional. Only system/infra settings remain — provider credentials live exclusively in the database.

| Var | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `test` silences logger |
| `LOG_LEVEL` | `info` | pino levels |
| `DATABASE_PATH` | `./data/virtual-engineer.db` | |
| `ADMIN_API_ENABLED` | `true` | |
| `ADMIN_API_HOST` / `ADMIN_API_PORT` | `127.0.0.1` / `3100` | |
| `ADMIN_AUTH_SECRET` | — | HMAC secret for Bearer auth (`Bearer <hex-hmac>`) |
| `POLLING_INTERVAL_MS` | `30000` | polling loop tick interval |
| `MAX_AGENT_CYCLES` | `3` | per-task cap → FAILED |
| `MAX_RETRY_ATTEMPTS` | `5` | per-ticket cap; polling skips ticket past cap |
| `MAX_COMMITS_PER_CYCLE` | `10` | max atomic commits per agent cycle |
| `AGENT_TIMEOUT_MS` | `3_600_000` | host-side agent timeout (60 min) |
| `MAX_REVIEW_DIFF_CHARS` | `60_000` | max diff chars injected into review prompt |
| `AGENT_CONTAINER_IMAGE` | `virtual-engineer-workspace:latest` | |
| `WORKSPACE_BASE_DIR` | `/tmp/virtual-engineer/workspaces` | scratch space for review diffs; agent workspaces use Docker named volumes |
| `AGENT_DOCKER_NETWORK` | `virtual-engineer_ve-agent-net` | Docker network for agent containers |

Provider configuration (Redmine, Gerrit, GitLab credentials, ticket-source/push-target selection, agent model and prompts, project lifecycle) lives entirely in the `integrations`, `agents`, `projects`, `project_integration_bindings`, and `project_push_targets` tables and is managed via the admin UI. The legacy provider env vars (`TICKET_SYSTEM`, `REVIEW_SYSTEM`, `REDMINE_*`, `GERRIT_*`, `GITLAB_*`, `REPO_CLONE_URL`, `BASE_BRANCH`, `GERRIT_TARGET_BRANCH`) have been **removed** from `src/config.ts` as part of Phase 7 cleanup.

Empty strings in env are treated as `undefined` (helpful for env overrides).


## Plugin System (`src/plugins/`)
- Static **registry** (`registry.ts`) defines one unified **provider descriptor** per `provider` in `src/plugins/descriptors/{github,gitlab,gerrit,redmine,copilot,mock}.ts`. The former split descriptors were merged: `github-issue` + `github-pull-request` → `github`; `gitlab-issue` + `gitlab-merge-request` → `gitlab`. `PLUGIN_CATEGORIES` / `category` no longer exist.
- Descriptors declare a `capabilities` map keyed by **domain capability** (`issue_tracking`, `code_review`, `source_control`, `agent_execution`) with capability factories: `capabilities.issue_tracking.createConnector`, `capabilities.code_review.{createConnector,createReviewer,streamEvents,systemPromptId,userPromptId}`, `capabilities.source_control.createVcsConnector`, `capabilities.agent_execution.createAdapter`. Technical capabilities (`oauth`, `discovery`, `stream-events`, `reviewer`) are derived from descriptor hooks via `getProviderTechnicalCapabilities(descriptor)`; domain ones via `getProviderDomainCapabilities(descriptor)`.
- **PluginManager** loads every enabled row from `integrations`, keeps multiple active integrations in parallel even for the same provider, resolves by `integrationId` (`getConnectorForIntegration`, `getActiveIntegrationById`, `isIntegrationActive`) or by capability/provider (`getConnectorForCapability(integrationId, capability)`, `getActiveIntegrationsByCapability(capability)`, `getActiveIntegrationsByProvider(provider)`, `providerSupportsCapability(provider, capability)`). `integrationHasStreamEvents` checks `capabilities.code_review.streamEvents`. It can also build project-bound connector instances via `createConnectorForIntegration(integrationId, context)` when a VE project owns part of the provider binding.
- Admin dashboard / API can hot-add or toggle integrations; `src/index.ts` refreshes runtime dependencies without restart.
- Test the connection of an unsaved form via `POST /api/admin/integrations/test` (does not persist; merges masked secrets from the existing row when `integrationId` is supplied).

## Copilot Execution

1. **Worker-local headless CLI** — code-generation containers always spawn `copilot --headless` inside the container and connect the SDK to that local CLI server.
2. **Host-side review SDK** — `src/review/copilotReviewAgent.ts` runs on the host for diff-only review tasks and authenticates the Copilot SDK directly with the selected GitHub token.
3. **Container validation fallback** — when the local Node runtime lacks `node:sqlite`, `copilotConnectionValidator` runs the validation script inside `AGENT_CONTAINER_IMAGE`, which also starts a local headless CLI in-container.

Worker `sendAndWait` timeout ≈ 540s. Host agent timeout = `AGENT_TIMEOUT_MS` (default 60 min).

Implementation: `src/agents/copilotAdapter.ts`, `src/agents/copilotOAuthService.ts`, `src/agents/copilotModelsService.ts`, `src/agents/copilotConnectionValidator.ts`, `src/review/copilotReviewAgent.ts`, `agent-worker/index.js`.

## Test Layout
- **Unit + integration tests**: `tests/unit/` (Vitest). All external I/O (fetch, fs, Docker, SDK) is mocked via `vi.mock`/`vi.spyOn`. Current project-mode and webhook-oriented scenarios live alongside unit specs (for example `orchestrator.projectMode.test.ts`, `orchestrator.webhookEntryPoints.test.ts`, `pollingLoop.projects.test.ts`).
- **Helpers/fixtures**: `tests/unit/helpers/`.

## Development Workflow (TDD mandatory)
Use the `ve-tdd` skill. Gate every commit on the three checks above. Reuse the `tested-engineer` agent for full TDD cycles, `codebase-analyst` for read-only review, `log-debugger` for runtime diagnosis, `dev-coordinator` for multi-stage features (see [DEVELOPMENT-WORKFLOW.md](./DEVELOPMENT-WORKFLOW.md)).

## TypeScript / Lint Conventions
- ESM with NodeNext: imports require `.js` suffix (`from "./foo.js"`).
- `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`.
- No `any` in `src/` — use `unknown` + type guards.
- Optional props: declare `T | undefined` explicitly.
- Unused locals/params must be `_`-prefixed.

## Commit Messages (Conventional Commits, Gerrit-friendly)
`<type>(<scope>): <≤50-char subject>`

Types: `feat`, `fix`, `test`, `refactor`, `perf`, `docs`, `chore`, `ci`.
Scopes: `orchestrator`, `polling-loop`, `state`, `gerrit`, `redmine`, `gitlab`, `agent`, `copilot-cli`, `vcs`, `plugins`, `admin`, `dashboard`, `prompts`, `config`, `workspace`, `db`.
Body lines ≤72 chars. See `typescript-standard` skill.

## Recent Gotchas
- **Orphaned-task adoption**: `deleteProject` snapshots `(integrationId, ticketProjectKey)` onto the project's tasks, sets their `project_id` to `NULL`, and abandons non-terminal ones. When a new project is created and `setProjectTicketSource` binds the same `(integrationId, ticketProjectKey)`, `adoptOrphanedTasksForProject` re-attaches those orphan tasks to the new project — preventing "No ticket source configured for project …" errors.
- **Copilot defaults**: `src/copilotModel.ts` only defines the default model (`auto`); runtime code should trim optional overrides but not rewrite model ids.
- **Task resolution**: `getTaskByTicketId()` orders by `createdAt DESC` so polling sees the newest task, not a stale FAILED row.
- **Pause/Resume** are state_transitions metadata rows, not boolean columns.
- **Plugin reload**: editing integrations triggers `refreshRuntimeDependencies()` from `src/index.ts`; no orchestrator restart needed.
- **Container image rebuild**: after editing `src/agents/copilotAdapter.ts`, `agent-worker/index.js`, or `Dockerfile.agent`, run `docker build -f Dockerfile.agent -t virtual-engineer-workspace:latest .` and restart `npm run dev`.
- **Timestamp queries**: stored in seconds → `datetime(created_at, 'unixepoch')` (NOT `created_at/1000`).
- **`exactOptionalPropertyTypes`**: when forwarding optional fields, prefer conditional spreading (`...(x !== undefined ? { x } : {})`) over `x: x ?? undefined`.
- **Provider config lives in admin DB**: do not add new env-var-driven provider settings — extend the relevant `integrations` descriptor or the `agents` / `projects` tables instead.
- **GitLab project binding is project-owned**: do not reintroduce GitLab `projectId`, label IDs, or label names into Add Integration forms; use `ticketProjectKey` / `repoKey` from VE project configuration and treat old integration fields as compatibility fallbacks only.
- **One provider, many capabilities**: there is no longer a `github-issue` vs `github-pull-request` (or `gitlab-issue` vs `gitlab-merge-request`) split. A single `github` / `gitlab` provider descriptor exposes multiple domain capabilities; resolve runtime dependencies by capability (`getConnectorForCapability`, `getActiveIntegrationsByCapability`) rather than by an integration type/role.
- **Ticket-source uniqueness is app-enforced**: there is no DB unique index across projects for the issue_tracking binding. `projectStore` throws when a second project binds the same `(integrationId, ticketProjectKey)`; keep that check in application code.
- **Multi-instance plugins**: all enabled integrations stay active in memory, including multiple rows of the same provider. Resolve runtime dependencies by `integrationId`, capability, or explicit integration lists; do not add new logic that assumes a single active integration per provider.
- **Copilot execution path**: no host/external CLI server support remains. Containers and validation scripts always boot a local headless CLI; host-side reviews use direct token auth.
- **Descriptor-driven event streams**: stream-capable integrations are reconciled through `descriptor.streamEvents` plus `PluginManager.getActiveIntegrations()`. Gerrit is the current stream-backed implementation, but the bootstrap is no longer Gerrit-specific.
- **Descriptor-driven review backends**: generic review routing resolves active review integrations through `descriptor.createReviewer`; keep provider-specific clone/setup logic in the descriptor and out of `src/index.ts` / `src/review/reviewOrchestrator.ts`.
- **Review tasks are integration-scoped**: webhook-triggered review flows must resolve the exact review integration by `integrationId`, and code-review tasks should preserve that integration in `ticketSourceLabel` / derived `ticketId` to avoid collisions between multiple active Gerrit instances.
- **Review event intake is provider-specific**: Redmine / GitLab still use per-integration webhook secrets in `configJson.webhookSecret`, while Gerrit review events now come from one host-side `ssh gerrit stream-events` listener per active integration.
- **Concurrency gating is integration-scoped at agent-cycle time**: `ConcurrencyTracker` keys limits by `agents.integrationId` using `agents.maxConcurrent`. It no longer gates `PollingLoop` or `startTaskForProject`; it gates active `runAgentCycle` executions (Docker-heavy phase) and releases at cycle end.
